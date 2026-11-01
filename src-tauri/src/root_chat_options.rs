//! What a general chat (root chat) can be set to: agent, model, effort, deep research and
//! the user's own MCP servers -- the lists a phone picks from (`rootchatoptions`), the
//! validation of what it sends back, and the MCP definitions a Claude turn merges into its
//! `--mcp-config`. Design: docs/superpowers/specs/2026-11-01-phone-controls-usage-design.md §3.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::agent::AgentId;

/// Every effort level both `claude --effort` and `agy --effort` accept.
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Claude's model aliases (`claude --model` takes these or a full id).
pub const CLAUDE_MODELS: [(&str, &str); 4] = [
    ("fable", "Fable"),
    ("opus", "Opus"),
    ("sonnet", "Sonnet"),
    ("haiku", "Haiku"),
];

/// The agents a general chat can run on.
pub fn chat_agent_from_wire(s: &str) -> Option<AgentId> {
    use crate::store::PersistedEnum;
    match AgentId::from_wire(s)? {
        a @ (AgentId::Claude | AgentId::Antigravity) => Some(a),
        _ => None,
    }
}

/// A model id is passed to a CLI flag, so it must look like one: 1..=80 chars of
/// `[A-Za-z0-9._:/@\[\]-]`. Whether the model exists is the agent's question.
pub fn valid_model(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/@[]-".contains(c))
}

pub fn valid_effort(s: &str) -> bool {
    EFFORTS.contains(&s)
}

/// An MCP server name a chat may opt into: Claude namespaces its tools as
/// `mcp__<name>__<tool>` and the name rides `--allowedTools`, so it must be a plain token
/// (no comma, paren, space or quote), and never Conduit's own server.
pub fn valid_mcp_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s != crate::root_mcp::SERVER_NAME
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The effort a turn runs at: deep research raises it to at least `high` (`max` when the
/// user picked nothing); otherwise the user's choice, if any.
pub fn effective_effort(effort: Option<&str>, research: bool) -> Option<String> {
    if !research {
        return effort.map(str::to_string);
    }
    Some(match effort {
        None => "max".to_string(),
        Some(e @ ("high" | "xhigh" | "max")) => e.to_string(),
        Some(_) => "high".to_string(),
    })
}

/// Where a Claude profile keeps its state: (`.claude.json`, the `.claude` dir holding
/// `skills/`). Resolved exactly as the spawn redirect does (`agent::claude_profile_env`): a
/// config dir named `.claude` is a HOME redirect (its `.claude.json` sits at the profile
/// root beside it); any other dir is a flat `CLAUDE_CONFIG_DIR`; no account means the
/// inherited `CLAUDE_CONFIG_DIR`, else the real home.
pub fn claude_profile_paths(config_dir: Option<&str>) -> Option<(PathBuf, PathBuf)> {
    let flat = |d: PathBuf| (d.join(".claude.json"), d);
    match config_dir.filter(|s| !s.is_empty()) {
        Some(cfg) => {
            let p = Path::new(cfg);
            if p.file_name().and_then(|f| f.to_str()) == Some(".claude") {
                let root = p.parent()?;
                Some((root.join(".claude.json"), p.to_path_buf()))
            } else {
                Some(flat(p.to_path_buf()))
            }
        }
        None => match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
            Some(d) => Some(flat(PathBuf::from(d))),
            None => {
                let home = dirs::home_dir()?;
                Some((home.join(".claude.json"), home.join(".claude")))
            }
        },
    }
}

/// The user-scope `mcpServers` map of a `.claude.json` text. Unparseable -> empty.
fn user_mcp_map(claude_json: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(claude_json)
        .ok()
        .and_then(|v| v.get("mcpServers").and_then(|m| m.as_object()).cloned())
        .unwrap_or_default()
}

/// The NAMES of the user-scope MCP servers a chat may opt into -- never their definitions,
/// which carry env vars, headers and args (secrets). Sorted; unusable names dropped.
pub fn user_mcp_names(claude_json: &str) -> Vec<String> {
    let mut names: Vec<String> = user_mcp_map(claude_json)
        .into_iter()
        .filter(|(k, v)| v.is_object() && valid_mcp_name(k))
        .map(|(k, _)| k)
        .collect();
    names.sort();
    names
}

/// The definitions of exactly the CHOSEN servers, for the chat's `--mcp-config`. A chosen
/// name that is not (or no longer) defined is skipped.
pub fn chosen_mcp_servers(claude_json: &str, chosen: &[String]) -> Map<String, Value> {
    let all = user_mcp_map(claude_json);
    chosen
        .iter()
        .filter(|n| valid_mcp_name(n))
        .filter_map(|n| {
            all.get(n)
                .filter(|v| v.is_object())
                .map(|v| (n.clone(), v.clone()))
        })
        .collect()
}

/// The chat's whole `--mcp-config` document: Conduit's root server (`root` = its port and
/// the chat id, when it is up; `root_mcp::mcp_config_json` builds that entry) plus the chosen
/// user servers. `None` when there is nothing to load. Conduit's entry is written LAST so a
/// user server can never take its name.
pub fn merged_mcp_config(root: Option<(u16, &str)>, user: &Map<String, Value>) -> Option<String> {
    let mut servers = user.clone();
    servers.remove(crate::root_mcp::SERVER_NAME);
    if let Some((port, chat_id)) = root {
        let doc: Value =
            serde_json::from_str(&crate::root_mcp::mcp_config_json(port, chat_id)).ok()?;
        if let Some(own) = doc.get("mcpServers").and_then(|m| m.as_object()) {
            servers.extend(own.clone());
        }
    }
    (!servers.is_empty()).then(|| json!({ "mcpServers": servers }).to_string())
}

/// One user-level skill: `<claude dir>/skills/<dir>/SKILL.md`, named by its frontmatter.
pub fn user_skills(claude_dir: &Path) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(claude_dir.join("skills")) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = rd
        .flatten()
        .filter_map(|e| {
            let dir_name = e.file_name().to_string_lossy().into_owned();
            let text = read_head(&e.path().join("SKILL.md"))?;
            let (name, description) = skill_frontmatter(&text);
            let name = name.unwrap_or(dir_name).trim_start_matches('/').to_string();
            Some((name, description.unwrap_or_default()))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.dedup_by(|a, b| a.0 == b.0);
    out.into_iter()
        .map(|(name, description)| json!({ "name": name, "description": description }))
        .collect()
}

/// The first 16 KB of a file: frontmatter is at the top, and a huge SKILL.md must not cost
/// the whole options reply.
fn read_head(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(16 * 1024)
        .read_to_end(&mut buf)
        .ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// `name` / `description` from a SKILL.md's YAML frontmatter, each capped.
pub fn skill_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let t = text.trim_start_matches('\u{feff}');
    let Some(rest) = t
        .strip_prefix("---\r\n")
        .or_else(|| t.strip_prefix("---\n"))
    else {
        return (None, None);
    };
    let end = rest.find("\n---").map(|i| &rest[..i]).unwrap_or_default();
    let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(end) else {
        return (None, None);
    };
    let field = |k: &str, max: usize| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(max).collect::<String>())
    };
    (field("name", 80), field("description", 300))
}

/// `agy models` output: `<id>\t<label>` lines after a "Fetching available models..." line.
pub fn parse_agy_models(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let (id, label) = l.trim_end().split_once('\t')?;
            let id = id.trim();
            valid_model(id).then(|| (id.to_string(), label.trim().to_string()))
        })
        .collect()
}

/// How long one `agy models` answer is reused.
const AGY_MODELS_TTL: Duration = Duration::from_secs(600);
/// How long `agy models` may take before the options reply goes out without it.
const AGY_MODELS_TIMEOUT: Duration = Duration::from_secs(15);

/// How long an options reply waits for a refresh before answering with what it has: the
/// phone gives up on `rootChatOptions` after 6 s.
pub const AGY_MODELS_WAIT: Duration = Duration::from_secs(3);

/// (fetched at, `(id, label)` list).
type AgyModelCache = Option<(Instant, Vec<(String, String)>)>;

static AGY_MODELS: Mutex<AgyModelCache> = Mutex::new(None);
static AGY_REFRESHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn cached_agy_models() -> Option<(bool, Vec<(String, String)>)> {
    AGY_MODELS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|(at, list)| (at.elapsed() < AGY_MODELS_TTL, list.clone()))
}

/// Start refreshing agy's model list in the background unless it is fresh or already
/// refreshing. Never blocks.
pub fn prewarm_agy_models(config_dir: Option<String>) {
    use std::sync::atomic::Ordering;
    if cached_agy_models().is_some_and(|(fresh, _)| fresh) {
        return;
    }
    if AGY_REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let list = run_agy_models(config_dir.as_deref()).unwrap_or_default();
        // A failure is not cached: the next request tries again.
        if !list.is_empty() {
            *AGY_MODELS.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), list));
        }
        AGY_REFRESHING.store(false, Ordering::SeqCst);
    });
}

/// agy's model list, cached for ten minutes. A stale or missing cache starts a background
/// refresh and waits at most `wait` for it, then answers with whatever it has (possibly
/// stale, possibly empty) -- a reply never waits on `agy models` itself.
pub fn agy_models(config_dir: Option<&str>, wait: Duration) -> Vec<(String, String)> {
    use std::sync::atomic::Ordering;
    if let Some((true, list)) = cached_agy_models() {
        return list;
    }
    prewarm_agy_models(config_dir.map(str::to_string));
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline && AGY_REFRESHING.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(100));
    }
    cached_agy_models().map(|(_, l)| l).unwrap_or_default()
}

fn run_agy_models(config_dir: Option<&str>) -> Option<Vec<(String, String)>> {
    use crate::NoWindow;
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    let mut c = {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = Command::new(shell);
        use std::os::windows::process::CommandExt;
        c.arg("/C").raw_arg("agy models");
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut c = Command::new(shell);
        c.args(["-i", "-l", "-c", "agy models"]);
        c
    };
    c.env_remove("npm_config_prefix")
        .no_window()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(cfg) = config_dir.filter(|s| !s.is_empty()) {
        for (k, v) in crate::agent::adapter_for(AgentId::Antigravity).account_env(cfg) {
            c.env(k, v);
        }
    }
    let mut child = c.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        let _ = std::io::BufReader::new(stdout).read_to_string(&mut s);
        let _ = tx.send(s);
    });
    match rx.recv_timeout(AGY_MODELS_TIMEOUT) {
        Ok(out) => {
            let _ = child.wait();
            Some(parse_agy_models(&out))
        }
        Err(_) => {
            crate::pty::kill_process_tree(&mut child);
            None
        }
    }
}

/// The `rootChatOptions` frame's body. `claude_cfg` / `agy_cfg` are the config dirs a NEW
/// chat would be pinned to (each agent's global default account). Blocking: see
/// [`agy_models`].
pub fn options_frame(request_id: &str, claude_cfg: Option<&str>, agy_cfg: Option<&str>) -> Value {
    let models = |list: Vec<(String, String)>| -> Vec<Value> {
        list.into_iter()
            .map(|(id, label)| json!({ "id": id, "label": label }))
            .collect()
    };
    let claude_models = models(
        CLAUDE_MODELS
            .iter()
            .map(|(i, l)| (i.to_string(), l.to_string()))
            .collect(),
    );
    let agy_models = models(agy_models(agy_cfg, AGY_MODELS_WAIT));
    let (skills, mcps) = match claude_profile_paths(claude_cfg) {
        Some((claude_json, claude_dir)) => (
            user_skills(&claude_dir),
            user_mcp_names(&std::fs::read_to_string(&claude_json).unwrap_or_default())
                .into_iter()
                .map(|name| json!({ "name": name }))
                .collect::<Vec<_>>(),
        ),
        None => (Vec::new(), Vec::new()),
    };
    json!({
        "type": "rootChatOptions",
        "requestId": request_id,
        "agents": [
            { "id": "claude", "label": "Claude", "models": claude_models, "efforts": EFFORTS },
            { "id": "antigravity", "label": "Antigravity", "models": agy_models, "efforts": EFFORTS },
        ],
        "skills": skills,
        "mcps": mcps,
    })
}

/// Check what a phone sent for a chat's model / effort / MCP servers. `known_mcps` = the
/// user-scope names in the chat's profile. Returns the first problem, phrased for the user.
pub fn validate_settings(
    agent: AgentId,
    model: Option<&str>,
    effort: Option<&str>,
    mcps: Option<&[String]>,
    known_mcps: &[String],
) -> Result<(), String> {
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        if !valid_model(m) {
            return Err("that model name is not valid".into());
        }
    }
    if let Some(e) = effort.filter(|e| !e.is_empty()) {
        if !valid_effort(e) {
            return Err(format!("effort must be one of {}", EFFORTS.join(", ")));
        }
    }
    if let Some(list) = mcps {
        if !list.is_empty() && agent != AgentId::Claude {
            return Err("MCP servers are available in Claude chats only".into());
        }
        if list.len() > 32 {
            return Err("too many MCP servers".into());
        }
        if let Some(bad) = list
            .iter()
            .find(|n| !valid_mcp_name(n) || !known_mcps.contains(n))
        {
            return Err(format!("no MCP server named {bad}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_JSON: &str = r#"{
        "numStartups": 3,
        "mcpServers": {
            "github": {"type": "http", "url": "https://x", "headers": {"Authorization": "Bearer SECRET"}},
            "local": {"command": "node", "args": ["s.js"], "env": {"TOKEN": "SECRET2"}},
            "conduit-root": {"type": "http", "url": "http://evil"},
            "bad name": {"command": "x"},
            "notanobject": 4
        },
        "projects": {"/p": {"mcpServers": {"projonly": {"command": "y"}}}}
    }"#;

    #[test]
    fn mcp_names_are_names_only_and_never_secrets() {
        assert_eq!(user_mcp_names(CLAUDE_JSON), vec!["github", "local"]);
        let frame = json!(user_mcp_names(CLAUDE_JSON)).to_string();
        assert!(!frame.contains("SECRET"));
        // Project-scoped servers are not user scope.
        assert!(!frame.contains("projonly"));
        assert!(user_mcp_names("not json").is_empty());
    }

    #[test]
    fn the_mcp_config_holds_only_chosen_servers_and_conduit_wins_its_name() {
        let chosen = chosen_mcp_servers(
            CLAUDE_JSON,
            &["local".into(), "missing".into(), "conduit-root".into()],
        );
        assert_eq!(chosen.keys().collect::<Vec<_>>(), vec!["local"]);
        // The chosen server keeps its full definition (it must actually start).
        assert_eq!(chosen["local"]["env"]["TOKEN"], "SECRET2");
        let doc = merged_mcp_config(Some((1, "c")), &chosen).unwrap();
        let v: Value = serde_json::from_str(&doc).unwrap();
        let servers = v["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(
            servers["conduit-root"]["url"],
            "http://127.0.0.1:1/mcp?rootchat=c"
        );
        assert!(
            servers.get("github").is_none(),
            "an unchosen server must not load"
        );
        // A user server can never replace Conduit's.
        let mut hostile = Map::new();
        hostile.insert("conduit-root".into(), json!({"url": "http://evil"}));
        let doc = merged_mcp_config(Some((1, "c")), &hostile).unwrap();
        assert!(!doc.contains("evil"));
        // Nothing at all: no file.
        assert!(merged_mcp_config(None, &Map::new()).is_none());
        // User servers with the root server down still load.
        assert!(merged_mcp_config(None, &chosen).unwrap().contains("local"));
    }

    #[test]
    fn settings_are_validated() {
        let known = vec!["github".to_string()];
        assert!(
            validate_settings(AgentId::Claude, Some("opus"), Some("max"), None, &known).is_ok()
        );
        assert!(validate_settings(
            AgentId::Claude,
            Some("claude-opus-4-6[1m]"),
            None,
            None,
            &known
        )
        .is_ok());
        assert!(validate_settings(AgentId::Claude, Some(""), Some(""), None, &known).is_ok());
        assert!(validate_settings(AgentId::Claude, Some("a b"), None, None, &known).is_err());
        assert!(validate_settings(AgentId::Claude, Some("x\"&y"), None, None, &known).is_err());
        assert!(
            validate_settings(AgentId::Claude, Some(&"m".repeat(81)), None, None, &known).is_err()
        );
        assert!(validate_settings(AgentId::Claude, None, Some("ultra"), None, &known).is_err());
        assert!(validate_settings(
            AgentId::Claude,
            None,
            None,
            Some(&["github".into()]),
            &known
        )
        .is_ok());
        assert!(
            validate_settings(AgentId::Claude, None, None, Some(&["nope".into()]), &known).is_err()
        );
        assert!(validate_settings(
            AgentId::Antigravity,
            None,
            None,
            Some(&["github".into()]),
            &known
        )
        .is_err());
        assert!(validate_settings(AgentId::Antigravity, None, None, Some(&[]), &known).is_ok());
    }

    #[test]
    fn chat_agents_are_read_strictly() {
        assert_eq!(chat_agent_from_wire("claude"), Some(AgentId::Claude));
        assert_eq!(
            chat_agent_from_wire("antigravity"),
            Some(AgentId::Antigravity)
        );
        assert_eq!(chat_agent_from_wire("codex"), None);
        assert_eq!(chat_agent_from_wire("gpt-9"), None);
    }

    #[test]
    fn research_raises_effort() {
        assert_eq!(effective_effort(None, false), None);
        assert_eq!(effective_effort(Some("low"), false).as_deref(), Some("low"));
        assert_eq!(effective_effort(None, true).as_deref(), Some("max"));
        assert_eq!(effective_effort(Some("low"), true).as_deref(), Some("high"));
        assert_eq!(
            effective_effort(Some("xhigh"), true).as_deref(),
            Some("xhigh")
        );
    }

    #[test]
    fn agy_models_parse_after_the_banner() {
        let out = "Fetching available models...\r\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\r\n\r\n";
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
        assert!(parse_agy_models("Error: not signed in").is_empty());
    }

    #[test]
    fn skill_frontmatter_reads_quoted_and_plain_values() {
        let (n, d) = skill_frontmatter(
            "---\nname: \"api-design\"\ndescription: Reviews APIs\n  and more\n---\n# body",
        );
        assert_eq!(n.as_deref(), Some("api-design"));
        assert_eq!(d.as_deref(), Some("Reviews APIs and more"));
        assert_eq!(skill_frontmatter("# no frontmatter"), (None, None));
    }

    #[test]
    fn user_skills_list_each_skill_dir() {
        let dir = std::env::temp_dir().join(format!("rco-skills-{}", uuid::Uuid::new_v4()));
        let s = dir.join("skills");
        std::fs::create_dir_all(s.join("a")).unwrap();
        std::fs::create_dir_all(s.join("b")).unwrap();
        std::fs::write(
            s.join("a/SKILL.md"),
            "---\nname: alpha\ndescription: first\n---\n",
        )
        .unwrap();
        std::fs::write(s.join("b/SKILL.md"), "no frontmatter").unwrap();
        std::fs::write(s.join("loose.md"), "x").unwrap();
        let list = user_skills(&dir);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["name"], "alpha");
        assert_eq!(list[1]["name"], "b");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn profile_paths_follow_the_spawn_redirect() {
        let (json, dir) = claude_profile_paths(Some("/p/.claude")).unwrap();
        assert_eq!(json, PathBuf::from("/p/.claude.json"));
        assert_eq!(dir, PathBuf::from("/p/.claude"));
        let (json, dir) = claude_profile_paths(Some("/p/claude-arlo")).unwrap();
        assert_eq!(json, PathBuf::from("/p/claude-arlo/.claude.json"));
        assert_eq!(dir, PathBuf::from("/p/claude-arlo"));
    }
}
