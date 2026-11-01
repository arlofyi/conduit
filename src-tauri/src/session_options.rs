//! The phone's per-session controls: `sessionoptions` (what a session can be switched to and
//! steered with) and `sessionset` (apply a change). Both are session-scoped, so the bridge's
//! private-session gate (`bridge::session_scope`) refuses them before anything here runs.
//!
//! Read-only discovery is pure and unit-tested against temp dirs: Claude's custom commands
//! and skills, agy's skills, and MCP server NAMES -- never their env, headers or commands,
//! which hold secrets. Changes go through the desktop's own paths: a model through
//! `apply_model_switch` (the body of `switch_session_model`), a rename and a restart as a
//! `mobile-session-action` the main window runs itself.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::AgentId;
use crate::store::Store;

/// Most commands/skills one reply lists.
pub const COMMANDS_MAX: usize = 200;
/// Longest description sent, in characters.
pub const DESCRIPTION_MAX: usize = 120;
/// Longest session name a phone may set, in characters (one line).
pub const NAME_MAX: usize = 40;
/// Bytes of a command/skill file read to find its frontmatter.
const HEAD_BYTES: u64 = 16 * 1024;
/// Directory entries considered per scanned folder.
const DIR_ENTRIES_MAX: usize = 500;
/// The effort levels `--effort` accepts (verified in `claude --help`; see `Session::effort`).
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
/// How long one `agy models` answer is reused.
const AGY_MODELS_TTL: Duration = Duration::from_secs(10 * 60);
/// `agy models` is a network call (~2 s measured); past this it is killed.
const AGY_MODELS_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq)]
pub struct CommandItem {
    pub name: String,
    pub description: String,
    /// "builtin" | "command" | "skill"
    pub kind: &'static str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct McpItem {
    pub name: String,
    /// "user" | "local" | "project" | "conduit"
    pub source: &'static str,
    pub enabled: bool,
}

// ---- models -------------------------------------------------------------------------

/// Claude's model aliases, plus the session's own model when it is something else (a full
/// id a route pinned), so the phone can always show what is selected.
pub fn claude_models(current: Option<&str>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = [
        ("fable", "Fable"),
        ("opus", "Opus"),
        ("sonnet", "Sonnet"),
        ("haiku", "Haiku"),
    ]
    .iter()
    .map(|(i, l)| (i.to_string(), l.to_string()))
    .collect();
    if let Some(c) = current.map(str::trim).filter(|c| !c.is_empty()) {
        if !out.iter().any(|(id, _)| id == c) {
            out.push((c.to_string(), c.to_string()));
        }
    }
    out
}

/// `agy models` output: a "Fetching available models..." line, then `<id>\t<label>` per
/// model. Lines without a tab are not models.
pub fn parse_agy_models(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let (id, label) = l.trim_end_matches('\r').split_once('\t')?;
            let (id, label) = (id.trim(), label.trim());
            (!id.is_empty() && !id.contains(' ')).then(|| {
                (
                    id.to_string(),
                    if label.is_empty() { id } else { label }.to_string(),
                )
            })
        })
        .collect()
}

/// (id, label) pairs.
type ModelList = Vec<(String, String)>;
static AGY_MODELS: Mutex<Option<(Instant, ModelList)>> = Mutex::new(None);
static AGY_FETCHING: AtomicBool = AtomicBool::new(false);

/// agy's model list, never blocking the caller: a cached answer (refreshed in the
/// background once older than [`AGY_MODELS_TTL`]), or nothing yet plus `pending = true`
/// while the first `agy models` runs on its own thread. The bridge loop serves every phone
/// on one thread per socket and a ~2 s network call there would freeze that phone's chat
/// stream, so a short synchronous deadline was rejected: the phone simply asks again.
pub fn agy_models() -> (Vec<(String, String)>, bool) {
    let cached = AGY_MODELS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let fresh = cached
        .as_ref()
        .is_some_and(|(at, _)| at.elapsed() < AGY_MODELS_TTL);
    if !fresh && !AGY_FETCHING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(|| {
            let models = run_agy_models()
                .map(|o| parse_agy_models(&o))
                .unwrap_or_default();
            if !models.is_empty() {
                *AGY_MODELS.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some((Instant::now(), models));
            }
            AGY_FETCHING.store(false, Ordering::SeqCst);
        });
    }
    match cached {
        Some((_, m)) => (m, false),
        None => (Vec::new(), true),
    }
}

fn agy_binary() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        Some(PathBuf::from("agy"))
    }
    #[cfg(not(windows))]
    {
        // A Dock-launched app has no login PATH; resolve it the way agent detection does.
        crate::agent::detect_agents()
            .into_iter()
            .find(|a| a.id == AgentId::Antigravity)
            .and_then(|a| a.path)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
    }
}

fn run_agy_models() -> Option<String> {
    use crate::agent::UserPath;
    use crate::NoWindow;
    let mut child = Command::new(agy_binary()?)
        .arg("models")
        .user_path()
        .no_window()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // Drained on a thread so a full pipe cannot stall the child while we poll for exit.
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() >= AGY_MODELS_DEADLINE => {
                let _ = child.kill();
                let _ = child.wait();
                return None; // the reader is detached, never joined
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
    reader.join().ok()
}

// ---- commands and skills ------------------------------------------------------------

/// Claude's built-in slash commands that make sense from a phone: each runs on its own or
/// with a typed argument. Pickers and editors (`/memory`, `/resume`, `/agents`, `/config`,
/// `/rewind`) are left out -- a phone cannot drive the menu they open.
pub fn claude_builtins() -> Vec<CommandItem> {
    [
        ("compact", "Summarize the conversation to free up context"),
        ("clear", "Start a fresh conversation"),
        ("context", "Show what is using the context window"),
        ("cost", "Show this session's token use and cost"),
        ("usage", "Show plan usage limits"),
        ("status", "Show version, model, account and connections"),
        ("model", "Switch model: add a name, e.g. /model sonnet"),
        ("review", "Review a pull request"),
        ("security-review", "Security review of the pending changes"),
        ("pr-comments", "Fetch the comments on a GitHub pull request"),
        ("init", "Create a CLAUDE.md that documents this codebase"),
        ("todos", "List the current todo items"),
        ("release-notes", "Show Claude Code's release notes"),
        ("help", "Show help and the available commands"),
    ]
    .iter()
    .map(|(n, d)| CommandItem {
        name: n.to_string(),
        description: d.to_string(),
        kind: "builtin",
    })
    .collect()
}

/// agy's built-ins. Only `/help` is documented by agy itself (its bundled CLI reference);
/// everything else it offers is a skill, listed from disk.
pub fn agy_builtins() -> Vec<CommandItem> {
    vec![CommandItem {
        name: "help".into(),
        description: "List agy's slash commands".into(),
        kind: "builtin",
    }]
}

/// A command name as the phone sends it after `/`: no leading slash, no whitespace.
fn command_name(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('/')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

/// One line, at most [`DESCRIPTION_MAX`] characters.
fn one_line(s: &str) -> String {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(DESCRIPTION_MAX).collect()
}

fn read_head(path: &Path) -> Option<String> {
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(HEAD_BYTES)
        .read_to_end(&mut buf)
        .ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// A markdown file's frontmatter `name` and `description`, and the body after it.
pub fn frontmatter(text: &str) -> (Option<String>, Option<String>, &str) {
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))
    else {
        return (None, None, text);
    };
    let (block, body) = match rest.find("\n---") {
        Some(i) => {
            let after = &rest[i + 4..];
            let body = after.split_once('\n').map_or("", |(_, b)| b);
            (&rest[..i], body)
        }
        None => return (None, None, text),
    };
    let field = |v: &serde_yaml::Value, k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(one_line)
            .filter(|s| !s.is_empty())
    };
    match serde_yaml::from_str::<serde_yaml::Value>(block) {
        Ok(v) => (field(&v, "name"), field(&v, "description"), body),
        // Hand-written frontmatter is often not valid YAML (an unquoted colon): fall back
        // to the plain `key: value` lines.
        Err(_) => {
            let line = |k: &str| {
                block.lines().find_map(|l| {
                    let v = l.strip_prefix(k)?.strip_prefix(':')?;
                    let v = one_line(v.trim().trim_matches('"').trim_matches('\''));
                    (!v.is_empty()).then_some(v)
                })
            };
            (line("name"), line("description"), body)
        }
    }
}

/// The first non-empty line of a body, as a fallback description.
fn first_line(body: &str) -> String {
    body.lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty())
        .map(one_line)
        .unwrap_or_default()
}

fn sorted_entries(dir: &Path) -> Vec<std::fs::DirEntry> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut v: Vec<_> = rd.flatten().take(DIR_ENTRIES_MAX).collect();
    v.sort_by_key(|e| e.file_name());
    v
}

fn is_md(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Claude custom commands in one `commands/` dir: `<name>.md`, and one level of
/// subfolders as `<folder>:<name>` (Claude's namespacing).
pub fn discover_commands(dir: &Path) -> Vec<CommandItem> {
    let mut out = Vec::new();
    let mut push = |path: &Path, name: String| {
        let Some(text) = read_head(path) else { return };
        let (_, desc, body) = frontmatter(&text);
        out.push(CommandItem {
            name: command_name(&name),
            description: desc.unwrap_or_else(|| first_line(body)),
            kind: "command",
        });
    };
    for e in sorted_entries(dir) {
        let path = e.path();
        let Ok(ft) = e.file_type() else { continue };
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if ft.is_file() && is_md(&path) && !stem.is_empty() {
            push(&path, stem);
        } else if ft.is_dir() && !stem.starts_with('.') {
            let folder = e.file_name().to_string_lossy().into_owned();
            for f in sorted_entries(&path) {
                let p = f.path();
                let is_file = f.file_type().is_ok_and(|t| t.is_file());
                if let (true, true, Some(s)) =
                    (is_file, is_md(&p), p.file_stem().and_then(|s| s.to_str()))
                {
                    push(&p, format!("{folder}:{s}"));
                }
            }
        }
    }
    out
}

/// Skills in one `skills/` dir: `<dir>/SKILL.md`, named by frontmatter `name` (else the
/// folder), described by frontmatter `description`.
pub fn discover_skills(dir: &Path) -> Vec<CommandItem> {
    let mut out = Vec::new();
    for e in sorted_entries(dir) {
        if !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let folder = e.file_name().to_string_lossy().into_owned();
        if folder.starts_with('.') {
            continue;
        }
        let Some(text) = read_head(&e.path().join("SKILL.md")) else {
            continue;
        };
        let (name, desc, body) = frontmatter(&text);
        out.push(CommandItem {
            name: command_name(&name.unwrap_or(folder)),
            description: desc.unwrap_or_else(|| first_line(body)),
            kind: "skill",
        });
    }
    out
}

/// Concatenate in precedence order, first occurrence of a (kind, name) wins, capped at
/// [`COMMANDS_MAX`].
pub fn merge_commands(lists: Vec<Vec<CommandItem>>) -> Vec<CommandItem> {
    let mut seen = HashSet::new();
    lists
        .into_iter()
        .flatten()
        .filter(|c| seen.insert((c.kind, c.name.clone())))
        .take(COMMANDS_MAX)
        .collect()
}

// ---- MCP servers ----------------------------------------------------------------------

fn server_names(v: Option<&Value>) -> Vec<String> {
    let mut names: Vec<String> = v
        .and_then(|m| m.get("mcpServers"))
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// The MCP servers a Claude session would load, by NAME and source only -- the config
/// values (env, headers, command lines) hold secrets and never leave this function.
/// `claude_json` is the account's `.claude.json` (user scope + per-project local scope),
/// `mcp_json` the session directory's `.mcp.json`. `allow` is `Session::mcp_servers`:
/// None loads everything; Some(list) loads exactly the listed registry names (strict mode,
/// which also suppresses the repo's own `.mcp.json`), so anything else is disabled, and a
/// listed name found in neither file comes from Conduit's registry.
pub fn claude_mcps(
    claude_json: Option<&Value>,
    session_dir: &str,
    mcp_json: Option<&Value>,
    allow: Option<&[String]>,
) -> Vec<McpItem> {
    let enabled = |n: &str| allow.is_none_or(|a| a.iter().any(|x| x == n));
    let mut out: Vec<McpItem> = Vec::new();
    let add = |name: String, source: &'static str, out: &mut Vec<McpItem>| {
        if !out.iter().any(|m| m.name == name) {
            out.push(McpItem {
                enabled: enabled(&name),
                name,
                source,
            });
        }
    };
    for n in server_names(claude_json) {
        add(n, "user", &mut out);
    }
    // Claude keys local scope by the project's absolute path; on Windows with forward
    // slashes. Try both spellings.
    if let Some(projects) = claude_json
        .and_then(|v| v.get("projects"))
        .and_then(Value::as_object)
    {
        let alt = session_dir.replace('\\', "/");
        let local = projects.get(session_dir).or_else(|| projects.get(&alt));
        for n in server_names(local) {
            add(n, "local", &mut out);
        }
    }
    for n in server_names(mcp_json) {
        add(n, "project", &mut out);
    }
    for n in allow.unwrap_or(&[]) {
        add(n.clone(), "conduit", &mut out);
    }
    out
}

/// agy's MCP servers (`~/.gemini/config/mcp_config.json`), by name. A server agy marks
/// `"disabled": true` is listed as disabled.
pub fn agy_mcps(cfg: Option<&Value>) -> Vec<McpItem> {
    let servers = cfg
        .and_then(|v| v.get("mcpServers"))
        .and_then(Value::as_object);
    let mut out: Vec<McpItem> = servers
        .map(|o| {
            o.iter()
                .map(|(name, v)| McpItem {
                    name: name.clone(),
                    source: "user",
                    enabled: v.get("disabled").and_then(Value::as_bool) != Some(true),
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn read_json(path: &Path) -> Option<Value> {
    // `.claude.json` is a few hundred KB at most; refuse anything absurd.
    let md = std::fs::metadata(path).ok()?;
    if md.len() > 16 * 1024 * 1024 {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// A Claude account's config dir and its `.claude.json`, as the spawned `claude` sees them
/// (`agent::claude_profile_env`): a `.claude` dir redirects HOME to its parent, any other
/// dir is `CLAUDE_CONFIG_DIR`; no account is Conduit's own environment.
pub fn claude_dirs(account_cfg: Option<&str>) -> Option<(PathBuf, PathBuf)> {
    let cfg = match account_cfg.filter(|c| !c.is_empty() && Path::new(c).exists()) {
        Some(c) => PathBuf::from(c),
        None => match std::env::var("CLAUDE_CONFIG_DIR") {
            Ok(c) if !c.is_empty() => PathBuf::from(c),
            _ => dirs::home_dir()?.join(".claude"),
        },
    };
    let json = if cfg.file_name().and_then(|f| f.to_str()) == Some(".claude") {
        cfg.parent()?.join(".claude.json")
    } else {
        cfg.join(".claude.json")
    };
    Some((cfg, json))
}

// ---- the frames -----------------------------------------------------------------------

fn find_session(store: &Store, session_id: &str) -> Option<(String, crate::store::Session)> {
    store.list().into_iter().find_map(|p| {
        p.sessions
            .iter()
            .find(|s| s.id == session_id)
            .map(|s| (p.id.clone(), s.clone()))
    })
}

/// Everything `sessionOptions` carries except the identity fields. Pure over its inputs.
pub struct Options {
    pub models: Vec<(String, String)>,
    pub models_pending: bool,
    pub efforts: Vec<&'static str>,
    pub model_live: bool,
    pub commands: Vec<CommandItem>,
    pub mcps: Vec<McpItem>,
}

/// Discover a session's options from disk. `dir` is the session's directory, `account_cfg`
/// its account config dir.
pub fn discover(
    agent: AgentId,
    model: Option<&str>,
    dir: Option<&str>,
    account_cfg: Option<&str>,
    mcp_allow: Option<&[String]>,
) -> Options {
    let adapter = crate::agent::adapter_for(agent);
    let efforts = if adapter.supports_model_flags() {
        EFFORTS.to_vec()
    } else {
        Vec::new()
    };
    // Any non-empty model answers the question "does this agent have a live command".
    let model_live = adapter.model_switch_command("x", None, None).is_some();
    let project = dir.map(PathBuf::from);
    match agent {
        AgentId::Claude => {
            let dirs = claude_dirs(account_cfg);
            let mut lists = vec![claude_builtins()];
            if let Some(p) = &project {
                lists.push(discover_commands(&p.join(".claude").join("commands")));
            }
            if let Some((cfg, _)) = &dirs {
                lists.push(discover_commands(&cfg.join("commands")));
            }
            if let Some(p) = &project {
                lists.push(discover_skills(&p.join(".claude").join("skills")));
            }
            if let Some((cfg, _)) = &dirs {
                lists.push(discover_skills(&cfg.join("skills")));
            }
            let claude_json = dirs.as_ref().and_then(|(_, j)| read_json(j));
            let mcp_json = project
                .as_ref()
                .and_then(|p| read_json(&p.join(".mcp.json")));
            Options {
                models: claude_models(model),
                models_pending: false,
                efforts,
                model_live,
                commands: merge_commands(lists),
                mcps: claude_mcps(
                    claude_json.as_ref(),
                    dir.unwrap_or(""),
                    mcp_json.as_ref(),
                    mcp_allow,
                ),
            }
        }
        AgentId::Antigravity => {
            let home = crate::agy_usage::resolve_agy_home(account_cfg);
            let gemini = home.as_ref().map(|h| h.join(".gemini"));
            let mut lists = vec![agy_builtins()];
            if let Some(p) = &project {
                // agy's workspace customization roots (its bundled `agy-customizations` doc).
                for root in [".agents", ".agent", "_agents", "_agent"] {
                    lists.push(discover_skills(&p.join(root).join("skills")));
                }
            }
            if let Some(g) = &gemini {
                lists.push(discover_skills(&g.join("config").join("skills")));
                lists.push(discover_skills(
                    &g.join("antigravity-cli").join("builtin").join("skills"),
                ));
            }
            let (mut models, pending) = agy_models();
            if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
                if !models.iter().any(|(id, _)| id == m) {
                    models.push((m.to_string(), m.to_string()));
                }
            }
            Options {
                models,
                models_pending: pending,
                efforts,
                model_live,
                commands: merge_commands(lists),
                mcps: agy_mcps(
                    gemini
                        .as_ref()
                        .and_then(|g| read_json(&g.join("config").join("mcp_config.json")))
                        .as_ref(),
                ),
            }
        }
        _ => Options {
            models: model
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(|m| vec![(m.to_string(), m.to_string())])
                .unwrap_or_default(),
            models_pending: false,
            efforts,
            model_live,
            commands: Vec::new(),
            mcps: Vec::new(),
        },
    }
}

/// The `sessionOptions` reply frame.
#[allow(clippy::too_many_arguments)]
pub fn options_json(
    request_id: &str,
    session_id: &str,
    agent: AgentId,
    model: Option<&str>,
    effort: Option<&str>,
    keep_running: bool,
    o: &Options,
) -> Value {
    json!({
        "type": "sessionOptions",
        "requestId": request_id,
        "sessionId": session_id,
        "agent": agent,
        "model": model,
        "effort": effort,
        "keepRunning": keep_running,
        "modelLive": o.model_live,
        "models": o.models.iter().map(|(id, label)| json!({ "id": id, "label": label })).collect::<Vec<_>>(),
        "modelsPending": o.models_pending,
        "efforts": o.efforts,
        "commands": o.commands.iter().map(|c| json!({
            "name": c.name, "description": c.description, "kind": c.kind,
        })).collect::<Vec<_>>(),
        "mcps": o.mcps.iter().map(|m| json!({
            "name": m.name, "source": m.source, "enabled": m.enabled,
        })).collect::<Vec<_>>(),
    })
}

/// Answer `sessionoptions`. An unknown session is an `error` frame.
pub fn options_frame(app: &AppHandle, session_id: &str, request_id: &str) -> Value {
    let store = app.state::<Arc<Store>>();
    let Some((_, s)) = find_session(&store, session_id) else {
        return json!({ "type": "error", "requestId": request_id, "sessionId": session_id,
            "message": "That session no longer exists." });
    };
    let dir = store.session_dir(session_id);
    let cfg = store.session_account_config_dir(session_id);
    let o = discover(
        s.agent,
        s.model.as_deref(),
        dir.as_deref(),
        cfg.as_deref(),
        s.mcp_servers.as_deref(),
    );
    options_json(
        request_id,
        session_id,
        s.agent,
        s.model.as_deref(),
        s.effort.as_deref(),
        s.keep_running,
        &o,
    )
}

/// A model id a phone may send: what `/model <id>` and `--model <id>` take (aliases, full
/// ids, `provider/model`, `[1m]` suffixes). Anything else -- spaces, control characters,
/// shell metacharacters -- is refused, because it is pasted into a live terminal.
pub fn valid_model(m: &str) -> bool {
    !m.is_empty()
        && m.len() <= 100
        && m.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:/@[]".contains(c))
}

/// A phone-chosen name: its first line, trimmed, at most [`NAME_MAX`] characters.
pub fn clean_name(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    let name: String = line
        .chars()
        .filter(|c| !c.is_control())
        .take(NAME_MAX)
        .collect();
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// An effort level, normalized. `Some(None)` clears it; `None` is not a level.
pub fn clean_effort(raw: &str) -> Option<Option<String>> {
    let e = raw.trim().to_ascii_lowercase();
    if e.is_empty() {
        Some(None)
    } else {
        EFFORTS.contains(&e.as_str()).then_some(Some(e))
    }
}

/// The `sessionSetResult` frame.
pub fn set_result(request_id: &str, ok: bool, note: &str) -> Value {
    json!({ "type": "sessionSetResult", "requestId": request_id, "ok": ok, "note": note })
}

/// Apply a `sessionset`. Each named field is applied in turn; `ok` is false if any was
/// refused, and `note` says what happened in short user-facing copy.
pub fn apply_set(
    app: &AppHandle,
    session_id: &str,
    request_id: &str,
    model: Option<String>,
    effort: Option<String>,
    name: Option<String>,
    keep_running: Option<bool>,
) -> Value {
    let store = app.state::<Arc<Store>>();
    let pty = app.state::<Arc<crate::pty::PtyManager>>();
    let Some((project_id, s)) = find_session(&store, session_id) else {
        return set_result(request_id, false, "That session no longer exists.");
    };
    let adapter = crate::agent::adapter_for(s.agent);
    let live = pty.has(session_id);
    let idle = || {
        app.state::<Arc<crate::fleet::FleetState>>()
            .snapshot()
            .get(session_id)
            .is_none_or(|f| f.status != "running" && f.status != "needsInput")
    };
    let restart = || {
        let _ = app.emit(
            "mobile-session-action",
            json!({ "action": "restart", "projectId": project_id, "sessionId": session_id }),
        );
    };
    let mut ok = true;
    let mut notes: Vec<String> = Vec::new();
    let mut want_restart = false;

    if let Some(e) = effort {
        if !adapter.supports_model_flags() {
            ok = false;
            notes.push("This agent has no effort setting.".into());
        } else if let Some(level) = clean_effort(&e) {
            store.set_session_effort(session_id, level);
            if live && idle() {
                want_restart = true;
            } else {
                notes.push("Effort applies when the session next starts.".into());
            }
        } else {
            ok = false;
            notes.push("Unknown effort level.".into());
        }
    }

    if let Some(m) = model {
        let m = m.trim().to_string();
        let can = adapter.supports_model_flags()
            || adapter.model_switch_command("x", None, None).is_some();
        if !can {
            ok = false;
            notes.push("This agent's model can't be changed from Conduit yet.".into());
        } else if !m.is_empty() && !valid_model(&m) {
            ok = false;
            notes.push("That isn't a model name.".into());
        } else {
            let r = crate::apply_model_switch(&store, &pty, session_id, &m, None, None);
            if r.live {
                notes.push(format!("Switched to {m}."));
            } else if m.is_empty() {
                notes.push(r.reason);
            } else if live && adapter.supports_model_flags() && idle() {
                want_restart = true;
            } else {
                // Stopped, mid-turn, or the live command failed to send: the pin persisted
                // by `apply_model_switch` applies at the next start either way.
                notes.push("Model applies when the session next starts.".into());
            }
        }
    }

    if let Some(n) = name {
        match clean_name(&n) {
            Some(n) => {
                let _ = app.emit(
                    "mobile-session-action",
                    json!({ "action": "rename", "projectId": project_id,
                        "sessionId": session_id, "name": n }),
                );
                notes.push("Renamed.".into());
            }
            None => {
                ok = false;
                notes.push("A name can't be empty.".into());
            }
        }
    }

    if let Some(k) = keep_running {
        store.set_session_keep_running(session_id, k);
        notes.push(if k {
            "Kept running: it won't auto-stop.".into()
        } else {
            "It can auto-stop when idle again.".into()
        });
    }

    if want_restart {
        restart();
        notes.push("Restarting to apply.".into());
    }
    if notes.is_empty() {
        return set_result(request_id, false, "Nothing to change.");
    }
    set_result(request_id, ok, &notes.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("conduit-sopt-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn claude_models_offer_aliases_plus_the_current_one() {
        let ids: Vec<String> = claude_models(None).into_iter().map(|m| m.0).collect();
        assert_eq!(ids, ["fable", "opus", "sonnet", "haiku"]);
        assert_eq!(claude_models(Some("sonnet")).len(), 4);
        let m = claude_models(Some("claude-opus-4-6[1m]"));
        assert_eq!(m.last().unwrap().0, "claude-opus-4-6[1m]");
        assert_eq!(claude_models(Some("haiku"))[3].1, "Haiku");
    }

    #[test]
    fn agy_models_parse_tab_lines_only() {
        let out = "Fetching available models...\r\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\nnot a model line\n";
        assert_eq!(
            parse_agy_models(out),
            vec![
                (
                    "gemini-3.8-flash-high".to_string(),
                    "Gemini 3.8 Flash (High)".to_string()
                ),
                (
                    "claude-sonnet-4-6".to_string(),
                    "Claude Sonnet 4.6 (Thinking)".to_string()
                ),
            ]
        );
        assert!(parse_agy_models("Fetching available models...\n").is_empty());
    }

    #[test]
    fn frontmatter_reads_yaml_and_falls_back_to_lines() {
        let (n, d, body) =
            frontmatter("---\nname: deploy\ndescription: >-\n  Ship it\n  safely\n---\n# Body\n");
        assert_eq!(n.as_deref(), Some("deploy"));
        assert_eq!(d.as_deref(), Some("Ship it safely"));
        assert_eq!(body, "# Body\n");
        // Not valid YAML (unquoted colon inside a value): the line scan still finds it.
        let (_, d, _) = frontmatter("---\ndescription: Run: the thing\nbad: [\n---\nx");
        assert_eq!(d.as_deref(), Some("Run: the thing"));
        let (n, d, body) = frontmatter("no frontmatter\n");
        assert!(n.is_none() && d.is_none());
        assert_eq!(body, "no frontmatter\n");
        let long = format!("---\ndescription: {}\n---\n", "a ".repeat(300));
        assert_eq!(
            frontmatter(&long).1.unwrap().chars().count(),
            DESCRIPTION_MAX
        );
    }

    #[test]
    fn commands_and_skills_are_discovered_from_disk() {
        let root = tmp("cmds");
        let cmds = root.join("commands");
        write(
            &cmds.join("ship.md"),
            "---\ndescription: Ship the branch\n---\nbody",
        );
        write(&cmds.join("plain.md"), "\n# Explain the code\nmore");
        write(&cmds.join("two words.md"), "x");
        write(&cmds.join("notes.txt"), "ignored");
        write(&cmds.join("git").join("sync.md"), "Sync with main");
        let skills = root.join("skills");
        write(
            &skills.join("pdf").join("SKILL.md"),
            "---\nname: pdf-tools\ndescription: Read PDFs\n---\n",
        );
        write(&skills.join("bare").join("SKILL.md"), "Just a body");
        std::fs::create_dir_all(skills.join("empty")).unwrap();

        let c = discover_commands(&cmds);
        let names: Vec<&str> = c.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["git:sync", "plain", "ship", "two-words"]);
        assert_eq!(c[0].description, "Sync with main");
        assert_eq!(c[1].description, "Explain the code");
        assert_eq!(c[2].description, "Ship the branch");
        assert!(c.iter().all(|c| c.kind == "command"));

        let s = discover_skills(&skills);
        let names: Vec<&str> = s.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["bare", "pdf-tools"]);
        assert_eq!(s[1].description, "Read PDFs");
        assert!(s.iter().all(|c| c.kind == "skill"));
        assert!(discover_skills(&root.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_discovery_merges_project_over_user_and_caps() {
        let root = tmp("merge");
        let (proj, cfg) = (root.join("proj"), root.join("acct").join(".claude"));
        write(
            &proj.join(".claude").join("commands").join("ship.md"),
            "---\ndescription: project ship\n---\n",
        );
        write(
            &cfg.join("commands").join("ship.md"),
            "---\ndescription: user ship\n---\n",
        );
        write(&cfg.join("skills").join("s1").join("SKILL.md"), "skill one");
        write(
            &proj.join(".mcp.json"),
            r#"{"mcpServers":{"repo-db":{"command":"x","env":{"TOKEN":"SECRET"}}}}"#,
        );
        write(
            &root.join("acct").join(".claude.json"),
            r#"{"mcpServers":{"github":{"headers":{"Authorization":"SECRET"}}}}"#,
        );
        let o = discover(
            AgentId::Claude,
            Some("opus"),
            proj.to_str(),
            cfg.to_str(),
            None,
        );
        let ship: Vec<&CommandItem> = o.commands.iter().filter(|c| c.name == "ship").collect();
        assert_eq!(ship.len(), 1);
        assert_eq!(ship[0].description, "project ship");
        assert!(o
            .commands
            .iter()
            .any(|c| c.name == "s1" && c.kind == "skill"));
        assert!(o
            .commands
            .iter()
            .any(|c| c.name == "compact" && c.kind == "builtin"));
        assert_eq!(o.efforts, EFFORTS.to_vec());
        assert!(o.model_live);
        let mcps: Vec<(&str, &str, bool)> = o
            .mcps
            .iter()
            .map(|m| (m.name.as_str(), m.source, m.enabled))
            .collect();
        assert_eq!(
            mcps,
            [("github", "user", true), ("repo-db", "project", true)]
        );
        let frame = options_json("r", "s", AgentId::Claude, Some("opus"), None, true, &o);
        assert!(!frame.to_string().contains("SECRET"), "MCP config leaked");

        let many: Vec<CommandItem> = (0..300)
            .map(|i| CommandItem {
                name: format!("c{i}"),
                description: String::new(),
                kind: "command",
            })
            .collect();
        assert_eq!(merge_commands(vec![many]).len(), COMMANDS_MAX);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mcp_allowlist_marks_enabled_and_adds_registry_servers() {
        let cj = json!({
            "mcpServers": {"github": {}},
            "projects": {"C:/work/repo": {"mcpServers": {"local-one": {}}}},
        });
        let mj = json!({"mcpServers": {"repo-db": {}}});
        let allow = vec!["github".to_string(), "from-registry".to_string()];
        let m = claude_mcps(Some(&cj), "C:\\work\\repo", Some(&mj), Some(&allow));
        let got: Vec<(&str, &str, bool)> = m
            .iter()
            .map(|m| (m.name.as_str(), m.source, m.enabled))
            .collect();
        assert_eq!(
            got,
            [
                ("github", "user", true),
                ("local-one", "local", false),
                ("repo-db", "project", false),
                ("from-registry", "conduit", true),
            ]
        );
        let a = agy_mcps(Some(
            &json!({"mcpServers": {"b": {"disabled": true}, "a": {}}}),
        ));
        assert_eq!(
            a,
            [
                McpItem {
                    name: "a".into(),
                    source: "user",
                    enabled: true
                },
                McpItem {
                    name: "b".into(),
                    source: "user",
                    enabled: false
                },
            ]
        );
    }

    #[test]
    fn agy_skills_come_from_its_customization_roots() {
        let root = tmp("agy");
        let proj = root.join("proj");
        write(
            &proj
                .join(".agents")
                .join("skills")
                .join("deploy")
                .join("SKILL.md"),
            "---\nname: deploy\ndescription: Deploy\n---\n",
        );
        let o = discover(AgentId::Antigravity, None, proj.to_str(), None, None);
        assert!(o
            .commands
            .iter()
            .any(|c| c.name == "deploy" && c.kind == "skill"));
        assert!(o
            .commands
            .iter()
            .any(|c| c.name == "help" && c.kind == "builtin"));
        assert!(!o.model_live);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inputs_a_phone_sends_are_validated() {
        for ok in [
            "opus",
            "claude-opus-4-6[1m]",
            "google/gemini-3.7-flash",
            "a:b@c",
        ] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in ["", "opus\r/clear", "a b", "x;rm", &"a".repeat(101)] {
            assert!(!valid_model(bad), "{bad:?}");
        }
        assert_eq!(
            clean_name("  Fix login  \nsecond").as_deref(),
            Some("Fix login")
        );
        assert_eq!(
            clean_name(&"x".repeat(80)).unwrap().chars().count(),
            NAME_MAX
        );
        assert_eq!(clean_name(" \n "), None);
        assert_eq!(clean_effort("HIGH"), Some(Some("high".into())));
        assert_eq!(clean_effort(""), Some(None));
        assert_eq!(clean_effort("turbo"), None);
        assert_eq!(
            set_result("r", true, "Renamed."),
            json!({"type":"sessionSetResult","requestId":"r","ok":true,"note":"Renamed."})
        );
    }
}
