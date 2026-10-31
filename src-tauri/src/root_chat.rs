//! Root chat: headless spawn-per-message `claude -p` conversations above all projects.
//! Read-only by CLI flag policy; one unified item stream shared with transcript replay.
//! Design: docs/superpowers/specs/2026-08-26-root-chat-design.md

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

/// Live children, one per chat at most. A child exists only while a turn is streaming;
/// idle chats hold no process (spawn-per-message).
#[derive(Default)]
pub struct RootChatState {
    children: Mutex<HashMap<String, Child>>,
    /// Phone sockets following chat events (`subscribe`). Each gets every event and keeps
    /// the ones for the chat it shows.
    subscribers: Mutex<Vec<(u64, Sender<Value>)>>,
    next_subscriber: AtomicU64,
    /// The workspace root the desktop last sent with a turn. Only the desktop knows it (it
    /// is a frontend setting), so a turn sent from a phone reuses it; home if never set.
    workspace_root: Mutex<Option<String>>,
}

impl RootChatState {
    /// Follow every chat's events: `{event: "user"|"item"|"done"|"error", chatId, ...}`.
    pub fn subscribe(&self) -> (u64, Receiver<Value>) {
        let id = self.next_subscriber.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((id, tx));
        (id, rx)
    }

    pub fn unsubscribe(&self, id: u64) {
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(i, _)| *i != id);
    }

    fn publish(&self, event: Value) {
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(_, tx)| tx.send(event.clone()).is_ok());
    }

    /// Is a turn streaming for this chat right now?
    pub fn is_running(&self, chat_id: &str) -> bool {
        let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, c| matches!(c.try_wait(), Ok(None)));
        map.contains_key(chat_id)
    }

    /// Stop a chat's streaming turn, if any (a tree kill: see `root_chat_stop`).
    pub fn stop(&self, chat_id: &str) {
        if let Some(c) = self
            .children
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(chat_id)
        {
            crate::pty::kill_process_tree(c);
        }
    }

    /// True if any turn is mid-stream. Reaps exited children first so a finished child
    /// can't hold the quit guard open.
    /// End every streaming turn. Called on app exit: these children live outside the PTY
    /// manager, so `kill_all` never reached them and a mid-turn chat outlived the app.
    pub fn kill_all(&self) {
        let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut child) in map.drain() {
            crate::pty::kill_process_tree(&mut child);
        }
    }

    pub fn any_running(&self) -> bool {
        let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, c| matches!(c.try_wait(), Ok(None)));
        !map.is_empty()
    }
}

#[tauri::command(async)]
pub fn root_chat_send(
    app: tauri::AppHandle,
    chat_id: String,
    text: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    send_turn(&app, &chat_id, &text, workspace_root, false)
}

/// Where a phone-sent turn's chat is titled from: its first line, like a phone-started
/// session (the desktop titles its own chats with a model call after the first reply).
pub fn title_from(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(if line.chars().count() <= 40 {
        line
    } else {
        format!("{}…", line.chars().take(39).collect::<String>().trim_end())
    })
}

/// Run one turn of a root chat. `from_phone`: the turn came over the mobile bridge, so the
/// desktop is told about the user's message (it adds its OWN sends locally) and the chat
/// is marked as phone-driven.
pub fn send_turn(
    app: &tauri::AppHandle,
    chat_id: &str,
    text: &str,
    workspace_root: Option<String>,
    from_phone: bool,
) -> Result<(), String> {
    use crate::NoWindow;
    let state = app.state::<Arc<RootChatState>>();
    let store = app.state::<Arc<crate::store::Store>>();
    let chat_id = chat_id.to_string();

    let chat = store
        .root_chat(&chat_id)
        .ok_or_else(|| format!("unknown root chat {chat_id}"))?;
    {
        // One live child per chat: reject, never queue (the composer is disabled anyway).
        let mut map = state.children.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, c| matches!(c.try_wait(), Ok(None)));
        if map.contains_key(&chat_id) {
            return Err("a turn is already running for this chat".into());
        }
    }

    let workspace_root = {
        let mut remembered = state
            .workspace_root
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match workspace_root.filter(|s| !s.is_empty()) {
            Some(w) => {
                *remembered = Some(w.clone());
                Some(w)
            }
            None => remembered.clone(),
        }
    };
    let cwd = workspace_root
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or("no workspace root and no resolvable home directory")?;
    if !cwd.is_dir() {
        return Err(format!(
            "workspace root {} is not a directory",
            cwd.display()
        ));
    }

    // Transcript home follows the chat's pinned account (same rule as every other
    // transcript consumer); it also decides fresh (--session-id) vs resume.
    let config_dir = store.root_chat_config_dir(&chat_id);
    let projects_dir = match &config_dir {
        Some(cfg) if !cfg.is_empty() => Some(PathBuf::from(cfg).join("projects")),
        _ => crate::pty::claude_projects_dir(),
    };
    let resume = projects_dir
        .as_deref()
        .is_some_and(|d| crate::pty::transcript_exists(&chat_id, d));

    // Only the projects in the chat's scope: the roster is what the chat believes exists.
    let in_scope = store.projects_for_chat(&chat_id);
    let roster: Vec<(String, String)> = in_scope
        .iter()
        .map(|p| (p.name.clone(), p.path.clone()))
        .collect();
    // Registered projects OUTSIDE the scope are denied to the file tools. A deny is the only
    // rule that holds: Read/Glob/Grep need no permission, so an allow list cannot narrow
    // them (measured: a scoped allow still read an out-of-scope file). Never deny a folder
    // that CONTAINS an in-scope project -- a deny would win over it too.
    let denied_paths: Vec<String> = if chat.scope.is_some() {
        let inside: Vec<&str> = in_scope.iter().map(|p| p.path.as_str()).collect();
        store
            .list()
            .iter()
            .map(|p| p.path.clone())
            .filter(|path| !inside.iter().any(|i| contains_path(path, i)))
            .collect()
    } else {
        Vec::new()
    };
    // Scratch + shared memory exist before the child looks for them; the memory index
    // is injected fresh each spawn, so a write from any chat is visible to all on
    // their very next turn.
    let dirs = dirs_for(&chat_id);
    let _ = std::fs::create_dir_all(&dirs.scratch);
    let _ = std::fs::create_dir_all(&dirs.memory);
    let memory_index =
        cap_index(&std::fs::read_to_string(dirs.memory.join("MEMORY.md")).unwrap_or_default());
    let mcp_config = crate::root_mcp::write_mcp_config(crate::root_mcp::port(), &chat_id);
    let charter = build_charter(
        &cwd.to_string_lossy(),
        &roster,
        &dirs,
        &memory_index,
        mcp_config.is_some(),
    );
    // The charter rides a FILE: it is many lines, and a newline ends a cmd.exe command line,
    // so on Windows an inline charter cut the command short and the rest of it reached
    // claude as stray arguments (`--session-id` was lost, the chat never resumed).
    let charter_path = dirs.scratch.join("charter.md");
    std::fs::write(&charter_path, &charter).map_err(|e| format!("write charter: {e}"))?;
    let cmd = build_command(
        &chat_id,
        resume,
        &charter_path.to_string_lossy(),
        &dirs,
        mcp_config.as_deref(),
        &denied_paths,
    );

    // Interactive login shell for PATH parity with the titler / pty.rs (GUI-launched
    // apps get the bare Finder PATH; nvm/Homebrew claude would be missing otherwise).
    #[cfg(windows)]
    let mut builder = {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = Command::new(shell);
        // RAW: `args` would re-quote the already cmd-quoted line with MSVCRT rules (`"` ->
        // `\"`), which cmd.exe does not understand (see "Where the Windows spawn command
        // lives" in CLAUDE.md).
        use std::os::windows::process::CommandExt;
        c.arg("/C").raw_arg(&cmd);
        c
    };
    #[cfg(not(windows))]
    let mut builder = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut c = Command::new(shell);
        c.args(["-i", "-l", "-c", &cmd]);
        c
    };
    builder
        .current_dir(&cwd)
        .env_remove("npm_config_prefix")
        .no_window()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cfg) = config_dir.as_deref().filter(|s| !s.is_empty()) {
        for (k, v) in crate::agent::adapter_for(crate::agent::AgentId::Claude).account_env(cfg) {
            builder.env(k, v);
        }
    }

    let mut child = builder.spawn().map_err(|e| format!("spawn claude: {e}"))?;
    if from_phone {
        store.mark_root_chat_phone(&chat_id);
        if chat.title == "New Chat" {
            if let Some(t) = title_from(text) {
                store.rename_root_chat(&chat_id, &t);
            }
        }
        let user = json!({ "kind": "bubble", "role": "user", "text": text });
        let _ = app.emit("root-chat-user", json!({ "chatId": chat_id, "item": user }));
    }
    state.publish(json!({ "event": "user", "chatId": chat_id, "text": text }));
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
        // Dropped here -> EOF, so `claude -p` reads the full prompt (titler pattern).
    }
    let stdout = child.stdout.take().ok_or("child stdout unavailable")?;
    let stderr = child.stderr.take();

    let state_arc = Arc::clone(state.inner());
    let app = app.clone();
    state_arc
        .children
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(chat_id.clone(), child);

    std::thread::spawn(move || {
        let mut saw_done = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match classify_line(&line) {
                LineOut::Items(items) => {
                    for item in items {
                        state_arc.publish(
                            json!({ "event": "item", "chatId": chat_id, "item": item.clone() }),
                        );
                        let _ =
                            app.emit("root-chat-item", json!({ "chatId": chat_id, "item": item }));
                    }
                }
                LineOut::Done(mut done) => {
                    saw_done = true;
                    done["chatId"] = json!(chat_id);
                    let mut ev = done.clone();
                    ev["event"] = json!("done");
                    state_arc.publish(ev);
                    let _ = app.emit("root-chat-done", done);
                }
                LineOut::Nothing => {}
            }
        }
        // Stream over: reap the child and surface silent failures (spawn errors land in
        // stderr with no `result` line — e.g. claude not on PATH, bad --resume).
        let status = state_arc
            .children
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&chat_id)
            .and_then(|mut c| c.wait().ok());
        if !saw_done {
            let mut tail = String::new();
            if let Some(mut err) = stderr {
                let mut buf = String::new();
                let _ = err.read_to_string(&mut buf);
                let trimmed = buf.trim();
                let cut = trimmed
                    .char_indices()
                    .rev()
                    .nth(499)
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                tail = trimmed[cut..].to_string();
            }
            let message = match status {
                Some(s) if s.success() => "claude exited without a result".to_string(),
                Some(s) => format!("claude exited with {s}: {tail}"),
                None => format!("claude terminated: {tail}"),
            };
            state_arc.publish(json!({ "event": "error", "chatId": chat_id, "message": message }));
            let _ = app.emit(
                "root-chat-error",
                json!({ "chatId": chat_id, "message": message }),
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn root_chat_stop(chat_id: String, state: State<Arc<RootChatState>>) {
    // A tree kill: the child is the `cmd.exe /C` wrapper, and killing only it on Windows
    // left the real `claude -p` running the turn to the end.
    state.stop(&chat_id);
}

/// Parse a chat's transcript into renderable items. Shared by the `root_chat_history`
/// command and root_mcp's `chat_read`, so the two can never drift.
pub fn history_items(store: &crate::store::Store, chat_id: &str) -> Vec<Value> {
    let projects = match store.root_chat_config_dir(chat_id) {
        Some(cfg) if !cfg.is_empty() => PathBuf::from(cfg).join("projects"),
        _ => match crate::pty::claude_projects_dir() {
            Some(d) => d,
            None => return Vec::new(),
        },
    };
    let Some(path) = crate::pty::transcript_path(chat_id, &projects) else {
        return Vec::new();
    };
    let Ok(f) = std::fs::File::open(&path) else {
        return Vec::new();
    };
    BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .flat_map(|l| crate::transcript::parse_line(&l))
        .collect()
}

/// Replay a chat's history from its transcript on disk — the same parser the live
/// stream uses, so reopen renders exactly what streaming rendered. Missing transcript
/// (fresh chat, deleted store) degrades to empty, per the transcript-consumer rule.
#[tauri::command(async)]
pub fn root_chat_history(chat_id: String, store: State<Arc<crate::store::Store>>) -> Vec<Value> {
    history_items(&store, &chat_id)
}

/// What one stream-json stdout line means to the chat.
pub enum LineOut {
    /// Renderable chat items (bubbles / tool events), via `transcript::parse_line` —
    /// stream-json assistant lines and transcript JSONL lines share the same shape.
    Items(Vec<Value>),
    /// The terminal `result` line: turn finished (cost, turn count, error flag).
    Done(Value),
    Nothing,
}

pub fn classify_line(line: &str) -> LineOut {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return LineOut::Nothing;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("result") => LineOut::Done(json!({
            "isError": v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
            "result": v.get("result").and_then(|r| r.as_str()).unwrap_or(""),
            "costUsd": v.get("total_cost_usd").and_then(|c| c.as_f64()),
            "numTurns": v.get("num_turns").and_then(|n| n.as_i64()),
        })),
        Some("system") => LineOut::Nothing,
        _ => {
            let items = crate::transcript::parse_line(line);
            if items.is_empty() {
                LineOut::Nothing
            } else {
                LineOut::Items(items)
            }
        }
    }
}

/// The Conduit-owned locations a root chat may write: its own scratchpad and the
/// global shared memory. Everything else stays read-only by tool policy.
pub struct Dirs {
    /// `<base>/rootchat` — rides `--add-dir` so the file tools may leave the cwd.
    pub root: PathBuf,
    /// `<base>/rootchat/scratch/<chat-id>` — private per-chat working files.
    pub scratch: PathBuf,
    /// `<base>/rootchat/memory` — one shared memory across ALL root chats.
    pub memory: PathBuf,
}

impl Dirs {
    pub fn under(base: &std::path::Path, chat_id: &str) -> Dirs {
        let root = base.join("rootchat");
        Dirs {
            scratch: root.join("scratch").join(chat_id),
            memory: root.join("memory"),
            root,
        }
    }
}

/// The real dirs for a chat, under Conduit's data dir.
pub fn dirs_for(chat_id: &str) -> Dirs {
    Dirs::under(&crate::store::data_dir(), chat_id)
}

/// Cap the injected memory index so a runaway MEMORY.md can't eat the system prompt.
pub fn cap_index(s: &str) -> String {
    const MAX: usize = 8 * 1024;
    if s.len() <= MAX {
        return s.to_string();
    }
    let cut = s
        .char_indices()
        .take_while(|(i, _)| *i <= MAX)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    format!("{}\n… (index truncated)", &s[..cut])
}

/// The per-spawn system prompt: role, GitHub powers, scratchpad, shared memory (index
/// injected inline), orchestration tools (only when `has_tools`), workspace root, and the
/// registered-project roster — rebuilt every message, so none of it is ever stale.
///
/// `has_tools` must track whether the spawn actually carries `--mcp-config` (i.e.
/// `root_mcp::write_mcp_config` returned `Some`) — the charter must never promise tools
/// the process cannot reach.
pub fn build_charter(
    workspace_root: &str,
    projects: &[(String, String)],
    dirs: &Dirs,
    memory_index: &str,
    has_tools: bool,
) -> String {
    let roster = if projects.is_empty() {
        "(none registered yet)".to_string()
    } else {
        projects
            .iter()
            .map(|(name, path)| format!("- {name}: {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let scratch = dirs.scratch.to_string_lossy();
    let memory = dirs.memory.to_string_lossy();
    let index = if memory_index.trim().is_empty() {
        "(empty — no memories yet)"
    } else {
        memory_index
    };
    let orchestration = if has_tools {
        "\n\nOrchestration: you can see and act across the whole workspace. \
         `sessions_list` and `session_peek` show what every agent session is doing; \
         `chats_list` and `chat_read` let you pull context out of your other HQ chats; \
         `chat_fork` starts a new HQ chat for a distinct topic. To get work built, call \
         `dispatch_work` with the project and a brief written for an engineer with no \
         context — this does NOT start anything: the user sees a card and approves it, \
         and you learn the outcome later from `dispatch_status`. Never claim work has \
         started until dispatch_status says approved.\n"
    } else {
        ""
    };
    format!(
        "You are Conduit's root chat: a project-management and ideation partner for the \
         user's whole workspace. You are not a code agent. You never modify project files \
         or write code into repositories — the ONLY locations you may write are your \
         scratchpad and the shared memory below, and the tool policy enforces that. When \
         a conversation lands on something that should be built, produce a concise \
         implementation brief the user can hand to a coding session in the relevant \
         project.\n\n\
         GitHub: you may use the `gh` CLI for project management — viewing and triaging \
         pull requests and issues, reading CI runs, commenting, labeling, editing \
         descriptions. Ask the user before anything hard to reverse: merging, closing, \
         creating repos/PRs/issues, or editing things you did not create. `gh api`, \
         `gh auth`, `gh secret`, and repo deletion are denied by policy — use typed \
         subcommands.\n\n\
         Scratchpad (private to THIS chat — drafts, notes, working files):\n{scratch}\n\n\
         Shared memory (every root chat reads and writes it):\n{memory}\n\
         `MEMORY.md` there is the index — one line per fact file. To remember something \
         durable, write one focused markdown file per fact and add or refresh its index \
         line; update or delete entries that turn out stale. The current index:\n\
         {index}\n\
         {orchestration}\n\n\
         Workspace root: {workspace_root}\n\n\
         Registered Conduit projects:\n{roster}"
    )
}

/// The full shell command for one message. `resume` = a transcript for this chat id
/// already exists (decided by the caller via `pty::transcript_exists`). `mcp_config` is
/// the path to the per-chat `--mcp-config` file (`root_mcp::write_mcp_config`), or `None`
/// when the root MCP server never bound a port.
pub fn build_command(
    chat_id: &str,
    resume: bool,
    charter_file: &str,
    dirs: &Dirs,
    mcp_config: Option<&str>,
    denied_paths: &[String],
) -> String {
    let id = crate::pty::quote_cmdline_arg(chat_id);
    let sys = crate::pty::quote_cmdline_arg(charter_file);
    let scratch = dirs.scratch.to_string_lossy();
    let memory = dirs.memory.to_string_lossy();
    // The orchestration tools must be ALLOWED, not merely configured. `-p` auto-denies
    // anything unallowed, and that includes MCP tools: with `--mcp-config` alone the
    // seven tools appear in the chat's tool list, every call is refused before the server
    // is reached, and the result carries `permission_denials`. (It looked like it worked
    // on machines whose `~/.claude/settings.json` sets `"defaultMode": "auto"` — a
    // per-user setting Conduit does not control, and a chat pinned to another account
    // reads a different settings tree.) Naming the SERVER allows all seven, so an eighth
    // tool cannot ship unreachable. Gated on the same condition as the flag: with no
    // server there is nothing to allow, and the chat keeps exactly its Phase 2 surface.
    let root_tools = if mcp_config.is_some() {
        format!(",{}", crate::root_mcp::TOOL_NAMESPACE)
    } else {
        String::new()
    };
    // Allow: read tools, the GitHub CLI, and writes scoped to the two Conduit-owned
    // dirs. Generic Bash/Write/Edit are NOT denied — they are simply unallowed, which
    // `-p` auto-denies; a blanket deny would override the scoped allows (deny wins).
    let allow = crate::pty::quote_cmdline_arg(&format!(
        "Read,Glob,Grep,WebSearch,WebFetch,Bash(gh:*),\
         Write({scratch}/**),Edit({scratch}/**),Write({memory}/**),Edit({memory}/**){root_tools}"
    ));
    // Deny the dangerous gh tail: `gh api` is arbitrary REST (a DELETE smuggles past
    // any prefix matcher), and auth/secrets/repo-deletion have no PM use.
    // A scoped chat is also denied the file tools on every project outside its scope.
    let out_of_scope: String = denied_paths
        .iter()
        .map(|p| {
            let r = permission_path(p);
            format!(",Read({r}/**),Glob({r}/**),Grep({r}/**)")
        })
        .collect();
    let deny = crate::pty::quote_cmdline_arg(&format!(
        "NotebookEdit,Bash(gh repo delete:*),Bash(gh secret:*),Bash(gh auth:*),Bash(gh api:*){out_of_scope}"
    ));
    let add = crate::pty::quote_cmdline_arg(&dirs.root.to_string_lossy());
    let mode = if resume {
        format!("--resume {id}")
    } else {
        format!("--session-id {id}")
    };
    // Orchestration tools ride a --mcp-config file naming the root MCP server. When the
    // server did not boot there is no flag at all, so --strict-mcp-config leaves the chat
    // with exactly its Phase 2 surface rather than a half-state that believes it can
    // dispatch.
    let mcp = mcp_config
        .map(|p| format!(" --mcp-config {}", crate::pty::quote_cmdline_arg(p)))
        .unwrap_or_default();
    format!(
        "claude -p --output-format stream-json --verbose \
         --allowedTools {allow} \
         --disallowedTools {deny} \
         --add-dir {add}{mcp} \
         --strict-mcp-config \
         --append-system-prompt-file {sys} {mode}"
    )
}

/// Is `inner` the folder `outer` or somewhere inside it? (Separator- and case-insensitive,
/// which errs toward NOT denying -- the safe side for this question.)
fn contains_path(outer: &str, inner: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let (o, i) = (norm(outer), norm(inner));
    i == o || i.starts_with(&format!("{o}/"))
}

/// An absolute path in Claude Code's permission-rule syntax: `//` + the path, with a
/// Windows drive written as Claude normalizes it (`C:\\a\\b` -> `//c/a/b`).
pub fn permission_path(path: &str) -> String {
    let p = path.replace('\\', "/");
    let p = p.trim_end_matches('/');
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        format!("//{}{}", (b[0] as char).to_ascii_lowercase(), &p[2..])
    } else {
        format!("/{p}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_folder_holding_an_in_scope_project_is_never_denied() {
        assert!(contains_path("C:\\work", "c:/work/app"));
        assert!(contains_path("/a/b", "/a/b/"));
        assert!(!contains_path("/a/b", "/a/bc"));
        assert!(!contains_path("/a/b/c", "/a/b"));
        let d = Dirs::under(std::path::Path::new("/data"), "x");
        let cmd = build_command("x", false, "c", &d, None, &["/other/proj".to_string()]);
        assert!(cmd.contains("Read(//other/proj/**)"));
    }

    #[test]
    fn permission_paths_are_absolute_in_claudes_syntax() {
        assert_eq!(permission_path("/Users/me/proj"), "//Users/me/proj");
        assert_eq!(
            permission_path("C:\\Users\\me\\proj\\"),
            "//c/Users/me/proj"
        );
        assert_eq!(permission_path("d:/work"), "//d/work");
    }

    #[test]
    fn a_phone_turn_titles_its_chat_from_the_first_line() {
        assert_eq!(
            title_from("\n  what is  open?\nmore").as_deref(),
            Some("what is open?")
        );
        assert_eq!(title_from("  "), None);
        assert_eq!(title_from(&"a".repeat(60)).unwrap().chars().count(), 40);
    }

    #[test]
    fn classify_result_line_as_done() {
        let line = json!({
            "type": "result", "subtype": "success", "is_error": false,
            "result": "Here's the brief.", "total_cost_usd": 0.042, "num_turns": 3
        })
        .to_string();
        match classify_line(&line) {
            LineOut::Done(v) => {
                assert_eq!(v["isError"], false);
                assert_eq!(v["costUsd"], 0.042);
                assert_eq!(v["numTurns"], 3);
            }
            _ => panic!("result line must classify as Done"),
        }
    }

    #[test]
    fn classify_assistant_line_as_items_via_transcript_parser() {
        let line = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"Thinking about your roadmap."},
            {"type":"tool_use","name":"Read","input":{"file_path":"/w/app/README.md"}}
        ]}})
        .to_string();
        match classify_line(&line) {
            LineOut::Items(items) => {
                assert_eq!(items[0]["kind"], "bubble");
                assert_eq!(items[1]["kind"], "event");
                assert_eq!(items[1]["event"], "read");
            }
            _ => panic!("assistant line must classify as Items"),
        }
    }

    #[test]
    fn classify_init_junk_and_empty_as_nothing() {
        let init = json!({"type":"system","subtype":"init","session_id":"abc"}).to_string();
        assert!(matches!(classify_line(&init), LineOut::Nothing));
        assert!(matches!(classify_line("not json"), LineOut::Nothing));
        // A user line carrying only a tool_result is now a `result` item, not nothing.
        let tr =
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}})
                .to_string();
        assert!(matches!(classify_line(&tr), LineOut::Items(_)));
    }

    fn tdirs() -> Dirs {
        // A base with a space, mirroring "Application Support" — quoting must survive it.
        Dirs::under(std::path::Path::new("/tmp/App Support/CT"), "chat-1")
    }

    #[test]
    fn dirs_nest_scratch_per_chat_and_memory_shared() {
        let d = tdirs();
        assert!(d.scratch.ends_with("rootchat/scratch/chat-1"));
        assert!(d.memory.ends_with("rootchat/memory"));
        assert!(d.root.ends_with("rootchat"));
        // Another chat shares memory but not scratch.
        let e = Dirs::under(std::path::Path::new("/tmp/App Support/CT"), "chat-2");
        assert_eq!(d.memory, e.memory);
        assert_ne!(d.scratch, e.scratch);
    }

    #[test]
    fn charter_carries_roster_dirs_memory_and_write_boundary() {
        let d = tdirs();
        let c = build_charter(
            "/Users/u/ooozzy",
            &[("conduit".into(), "/Users/u/ooozzy/conduit".into())],
            &d,
            "- [Release cadence](cadence.md) — weekly",
            false,
        );
        assert!(c.contains("/Users/u/ooozzy"));
        assert!(c.contains("- conduit: /Users/u/ooozzy/conduit"));
        assert!(c.contains(d.scratch.to_string_lossy().as_ref()));
        assert!(c.contains(d.memory.to_string_lossy().as_ref()));
        assert!(
            c.contains("Release cadence"),
            "memory index must be injected"
        );
        assert!(
            c.contains("gh"),
            "charter must explain the GitHub CLI powers"
        );
        assert!(
            c.contains("never modify project files"),
            "write boundary must be stated: {c}"
        );
        let empty = build_charter("/Users/u", &[], &d, "", false);
        assert!(empty.contains("(none registered yet)"));
        assert!(empty.contains("(empty — no memories yet)"));
    }

    #[test]
    fn charter_explains_the_orchestration_tools_only_when_they_exist() {
        let d = tdirs();
        let with = build_charter("/w", &[], &d, "", true);
        assert!(with.contains("dispatch_work"));
        assert!(
            with.contains("approve"),
            "the charter must say the user approves: {with}"
        );
        let without = build_charter("/w", &[], &d, "", false);
        assert!(!without.contains("dispatch_work"));
    }

    #[test]
    fn command_pins_session_id_first_then_resumes() {
        let d = tdirs();
        let fresh = build_command("abc-123", false, "charter text", &d, None, &[]);
        assert!(fresh.contains("--session-id"), "{fresh}");
        assert!(fresh.contains("--output-format stream-json"));
        assert!(fresh.contains("--strict-mcp-config"));
        assert!(fresh.contains("--append-system-prompt-file"));
        let resumed = build_command("abc-123", true, "charter text", &d, None, &[]);
        assert!(resumed.contains("--resume"));
        assert!(!resumed.contains("--session-id"));
    }

    #[test]
    fn command_includes_the_mcp_config_when_the_root_server_is_up() {
        let d = tdirs();
        let path = "/tmp/App Support/rootchat-mcp-abc.json";
        let with = build_command("abc-123", false, "charter", &d, Some(path), &[]);
        // The path must arrive as ONE shell word: Conduit's data dir has a space on
        // macOS ("Application Support"), so an unquoted interpolation would split into
        // two words under `sh -c` and the flag would silently take a truncated argument.
        // Comparing against `crate::pty::quote_cmdline_arg`'s own output (rather than a hardcoded
        // quote character) keeps this correct on both the sh/single-quote and the
        // cmd.exe/double-quote platform, and still fails if `build_command` stops calling
        // it: an unquoted `--mcp-config /tmp/App Support/...` does not contain the quoted
        // substring below.
        let quoted = crate::pty::quote_cmdline_arg(path);
        assert!(
            with.contains(&format!("--mcp-config {quoted}")),
            "expected the mcp-config path quoted as one shell word: {with}"
        );
        assert!(
            with.contains("--strict-mcp-config"),
            "strict mode must survive"
        );
        // Configuring the server is not enough: `-p` auto-denies any MCP tool absent from
        // --allowedTools, so without this the seven tools are listed, every call is
        // refused before the server is reached, and the run reports permission_denials.
        assert!(
            with.contains(crate::root_mcp::TOOL_NAMESPACE),
            "the root MCP namespace must be on the allow list, or every tool call is denied: {with}"
        );
        // No server: no flag, no namespace, and the chat degrades to its Phase 2 tool set.
        let without = build_command("abc-123", false, "charter", &d, None, &[]);
        assert!(!without.contains("--mcp-config"));
        assert!(
            !without.contains("mcp__"),
            "no server means nothing to allow: {without}"
        );
        assert!(without.contains("--strict-mcp-config"));
    }

    #[test]
    fn command_grants_gh_and_scoped_writes_denies_the_dangerous_tail() {
        let d = tdirs();
        let s = d.scratch.to_string_lossy();
        let m = d.memory.to_string_lossy();
        let cmd = build_command("abc-123", false, "charter text", &d, None, &[]);
        // Allow: read tools + gh + writes scoped to the two Conduit-owned dirs.
        assert!(
            cmd.contains("Read,Glob,Grep,WebSearch,WebFetch,Bash(gh:*)"),
            "{cmd}"
        );
        assert!(cmd.contains(&format!("Write({s}/**)")));
        assert!(cmd.contains(&format!("Edit({s}/**)")));
        assert!(cmd.contains(&format!("Write({m}/**)")));
        assert!(cmd.contains(&format!("Edit({m}/**)")));
        // Deny wins: the dangerous gh tail stays unreachable.
        assert!(cmd.contains("Bash(gh repo delete:*)"));
        assert!(cmd.contains("Bash(gh secret:*)"));
        assert!(cmd.contains("Bash(gh auth:*)"));
        assert!(cmd.contains("Bash(gh api:*)"));
        // The old blanket denies are GONE (they would override the scoped allows) —
        // generic Bash/Write/Edit are simply unallowed, which -p auto-denies.
        assert!(!cmd.contains("Bash,Write,Edit,NotebookEdit"), "{cmd}");
        // The writable root rides --add-dir so file tools may leave the cwd.
        assert!(cmd.contains("--add-dir"));
        assert!(cmd.contains(d.root.to_string_lossy().as_ref()));
    }

    #[test]
    fn cap_index_truncates_on_a_char_boundary() {
        let small = "short index";
        assert_eq!(cap_index(small), small);
        let big = "é".repeat(9000); // 2 bytes each -> 18000 bytes
        let capped = cap_index(&big);
        assert!(capped.len() < big.len());
        assert!(capped.ends_with("(index truncated)"));
        // Must not split a multi-byte char (String ops would have panicked already,
        // but keep the guarantee explicit).
        assert!(capped.is_char_boundary(capped.len()));
    }
}
