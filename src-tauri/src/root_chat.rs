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

    /// End every streaming turn. Called on app exit: these children live outside the PTY
    /// manager, so `kill_all` never reached them and a mid-turn chat outlived the app.
    pub fn kill_all(&self) {
        let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut child) in map.drain() {
            crate::pty::kill_process_tree(&mut child);
        }
    }

    /// True if any turn is mid-stream. Reaps exited children first so a finished child
    /// can't hold the quit guard open.
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
    // An EMPTY scope (every new chat: nothing attached yet) denies every registered project.
    let scoped = chat.scope.is_some();
    let all_paths: Vec<String> = store.list().into_iter().map(|p| p.path).collect();
    let inside: Vec<String> = in_scope.iter().map(|p| p.path.clone()).collect();
    let mut denied_paths = out_of_scope_paths(scoped, &all_paths, &inside);
    // EVERY chat, scoped or not, is also kept out of private sessions' worktrees and the
    // transcript stores (Claude's per config root, agy's per home): either would hand a
    // chat -- and a phone streaming it -- the output of a session marked private.
    let account_dirs: Vec<String> = store
        .list_accounts()
        .into_iter()
        .map(|a| a.config_dir)
        .collect();
    let private = private_read_denies(
        &store.list(),
        &claude_config_roots(&account_dirs),
        &agy_homes(&account_dirs),
        &inside,
    );
    denied_paths.extend(private.dirs);
    let denied_files = private.files;
    // Scratch + shared memory exist before the child looks for them; the memory index
    // is injected fresh each spawn, so a write from any chat is visible to all on
    // their very next turn.
    let dirs = dirs_for(&chat_id);
    let _ = std::fs::create_dir_all(&dirs.scratch);
    let _ = std::fs::create_dir_all(&dirs.memory);
    let memory_index =
        cap_index(&std::fs::read_to_string(dirs.memory.join("MEMORY.md")).unwrap_or_default());
    let agy = chat.agent == crate::agent::AgentId::Antigravity;
    let effort = crate::root_chat_options::effective_effort(chat.effort.as_deref(), chat.research);
    // This turn's `--mcp-config`, deleted once its child is gone.
    let mut mcp_file: Option<PathBuf> = None;
    let (cmd, run_dir, stdin_text) = if agy {
        // agy has no system-prompt flag, but it follows an `AGENTS.md` in its working
        // directory (measured), and an Antigravity chat runs IN its own scratchpad.
        let base = build_charter_for(
            true,
            &cwd.to_string_lossy(),
            &roster,
            scoped,
            &dirs,
            &memory_index,
            false,
        );
        let mut charter = crate::root_chat_agy::charter(&base);
        if chat.research {
            charter.push_str(RESEARCH_BRIEF);
        }
        std::fs::write(dirs.scratch.join("AGENTS.md"), &charter)
            .map_err(|e| format!("write charter: {e}"))?;
        let settings_path = dirs.scratch.join("agy-settings.json");
        std::fs::write(
            &settings_path,
            crate::root_chat_agy::settings_json(&[denied_paths.clone(), denied_files].concat()),
        )
        .map_err(|e| format!("write agy settings: {e}"))?;
        // Resume only a conversation that still exists: replaying a vanished id would fail
        // every turn from now on, so a missing one starts fresh (and is re-captured).
        let conversation = chat.agy_conversation_id.as_deref().filter(|cid| {
            crate::agy_usage::resolve_agy_home(config_dir.as_deref())
                .and_then(|home| crate::agy_transcript::conversation_db(&home, cid))
                .is_some()
        });
        let add_dirs: Vec<String> = in_scope.iter().map(|p| p.path.clone()).collect();
        let cmd = crate::root_chat_agy::build_command(
            &settings_path.to_string_lossy(),
            conversation,
            chat.model.as_deref(),
            effort.as_deref(),
            &add_dirs,
        );
        (
            cmd,
            dirs.scratch.clone(),
            crate::root_chat_agy::stdin_line(text),
        )
    } else {
        // One --mcp-config file: Conduit's root server (when it is up) plus the user MCP
        // servers this chat opted into, read from the chat's own profile. Only servers that
        // are still defined are loaded AND allowed.
        let port = crate::root_mcp::port();
        let root = (port != 0).then_some((port, chat_id.as_str()));
        let user = if chat.mcps.is_empty() {
            serde_json::Map::new()
        } else {
            let claude_json = crate::root_chat_options::claude_profile_paths(config_dir.as_deref())
                .and_then(|(j, _)| std::fs::read_to_string(j).ok())
                .unwrap_or_default();
            crate::root_chat_options::chosen_mcp_servers(&claude_json, &chat.mcps)
        };
        let user_mcps: Vec<String> = user.keys().cloned().collect();
        let mcp_config = crate::root_chat_options::merged_mcp_config(root, &user).and_then(|doc| {
            let path = mcp_config_path(&chat_id, &uuid::Uuid::new_v4().to_string());
            write_private(&path, &doc).ok()?;
            mcp_file = Some(path.clone());
            Some(path.to_string_lossy().into_owned())
        });
        let mut charter = build_charter(
            &cwd.to_string_lossy(),
            &roster,
            scoped,
            &dirs,
            &memory_index,
            root.is_some() && mcp_config.is_some(),
        );
        if mcp_config.is_some() && !user_mcps.is_empty() {
            charter.push_str(&format!(
                "\n\nAlso connected: the user's MCP servers {} -- their tools (named \
                 `mcp__<server>__<tool>`) are allowed in this chat.",
                user_mcps.join(", ")
            ));
        }
        if chat.research {
            charter.push_str(RESEARCH_BRIEF);
        }
        // The charter rides a FILE: it is many lines, and a newline ends a cmd.exe command
        // line, so on Windows an inline charter cut the command short and the rest of it
        // reached claude as stray arguments (`--session-id` was lost, the chat never resumed).
        let charter_path = dirs.scratch.join("charter.md");
        std::fs::write(&charter_path, &charter).map_err(|e| format!("write charter: {e}"))?;
        let no_mcps: Vec<String> = Vec::new();
        let cmd = build_command_with(
            &chat_id,
            resume,
            &charter_path.to_string_lossy(),
            &dirs,
            mcp_config.as_deref(),
            &denied_paths,
            &TurnFlags {
                model: chat.model.as_deref(),
                effort: effort.as_deref(),
                user_mcps: if mcp_config.is_some() {
                    &user_mcps
                } else {
                    &no_mcps
                },
                denied_files: &denied_files,
            },
        );
        (cmd, cwd.clone(), text.to_string())
    };
    let agent_name = if agy { "agy" } else { "claude" };

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
        .current_dir(&run_dir)
        .env_remove("npm_config_prefix")
        .no_window()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cfg) = config_dir.as_deref().filter(|s| !s.is_empty()) {
        // The chat's own agent decides the redirect (an agy chat is pinned to an agy login).
        let agent = if agy {
            crate::agent::AgentId::Antigravity
        } else {
            crate::agent::AgentId::Claude
        };
        for (k, v) in crate::agent::adapter_for(agent).account_env(cfg) {
            builder.env(k, v);
        }
    }

    let mut child = match builder.spawn() {
        Ok(c) => c,
        Err(e) => {
            remove_file_opt(mcp_file.as_deref());
            crate::diag::error("root-chat", format!("spawn {agent_name} failed: {e}"));
            return Err(format!("spawn {agent_name}: {e}"));
        }
    };
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
        let _ = stdin.write_all(stdin_text.as_bytes());
        // Dropped here -> EOF, so `claude -p` reads the full prompt (titler pattern) and
        // agy's stream-json input ends after this one turn.
    }
    let Some(stdout) = child.stdout.take() else {
        crate::pty::kill_process_tree(&mut child);
        remove_file_opt(mcp_file.as_deref());
        return Err("child stdout unavailable".into());
    };
    // Drained on its own thread from the start: read only after stdout's EOF, a chatty
    // stderr filled the pipe, the child blocked writing it, and the turn hung forever.
    let stderr_tail = child
        .stderr
        .take()
        .map(|err| std::thread::spawn(move || drain_tail(err, STDERR_TAIL_BYTES)));

    let state_arc = Arc::clone(state.inner());
    let store_arc = Arc::clone(store.inner());
    let app = app.clone();
    let pid = child.id();
    state_arc
        .children
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(chat_id.clone(), child);

    let mut classify: Box<dyn FnMut(&str) -> TurnOut + Send> = if agy {
        use crate::root_chat_agy::AgyOut;
        let mut stream = crate::root_chat_agy::AgyStream::default();
        Box::new(move |l| match stream.line(l) {
            AgyOut::Init(c) => TurnOut::Conversation(c),
            AgyOut::Items(i) => TurnOut::Items(i),
            AgyOut::Done(Ok(d)) => TurnOut::Done(d),
            AgyOut::Done(Err(m)) => TurnOut::Failed(m),
            AgyOut::Nothing => TurnOut::Nothing,
        })
    } else {
        Box::new(|l| match classify_line(l) {
            LineOut::Items(i) => TurnOut::Items(i),
            LineOut::Done(d) => TurnOut::Done(d),
            LineOut::Nothing => TurnOut::Nothing,
        })
    };

    std::thread::spawn(move || {
        let mut saw_done = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match classify(&line) {
                TurnOut::Conversation(cid) => {
                    let known = store_arc
                        .root_chat(&chat_id)
                        .and_then(|c| c.agy_conversation_id);
                    if known.as_deref() != Some(cid.as_str()) {
                        store_arc.set_root_chat_agy_conversation(&chat_id, &cid);
                    }
                }
                TurnOut::Failed(message) => {
                    saw_done = true;
                    state_arc.publish(
                        json!({ "event": "error", "chatId": chat_id, "message": message }),
                    );
                    let _ = app.emit(
                        "root-chat-error",
                        json!({ "chatId": chat_id, "message": message }),
                    );
                }
                TurnOut::Items(items) => {
                    for item in items {
                        state_arc.publish(
                            json!({ "event": "item", "chatId": chat_id, "item": item.clone() }),
                        );
                        let _ =
                            app.emit("root-chat-item", json!({ "chatId": chat_id, "item": item }));
                    }
                }
                TurnOut::Done(mut done) => {
                    saw_done = true;
                    done["chatId"] = json!(chat_id);
                    let mut ev = done.clone();
                    ev["event"] = json!("done");
                    state_arc.publish(ev);
                    let _ = app.emit("root-chat-done", done);
                }
                TurnOut::Nothing => {}
            }
        }
        // Stream over: reap the child and surface silent failures (spawn errors land in
        // stderr with no `result` line — e.g. claude not on PATH, bad --resume).
        // Only OUR child: once it has exited, `send_turn`'s reap lets the next turn in, and
        // removing by chat id alone would take that turn's child out of the map.
        let ours = {
            let mut map = state_arc.children.lock().unwrap_or_else(|e| e.into_inner());
            if map.get(&chat_id).is_some_and(|c| c.id() == pid) {
                map.remove(&chat_id)
            } else {
                None
            }
        };
        let status = ours.and_then(|mut c| c.wait().ok());
        // The child is gone: its MCP config (which may carry a user server's tokens) has
        // no reader left, so it does not outlive the turn. Per-turn file name, so this
        // never deletes the config of a turn that started after ours ended.
        remove_file_opt(mcp_file.as_deref());
        if !saw_done {
            // Joined only when the message needs it: a grandchild still holding stderr
            // open would otherwise park this thread after a turn that went fine. Left
            // unjoined, the drain thread simply ends at that EOF.
            let stderr_text = stderr_tail.and_then(|h| h.join().ok()).unwrap_or_default();
            let trimmed = stderr_text.trim();
            let cut = trimmed
                .char_indices()
                .rev()
                .nth(499)
                .map(|(i, _)| i)
                .unwrap_or(0);
            let tail = trimmed[cut..].to_string();
            let message = match status {
                Some(s) if s.success() => format!("{agent_name} exited without a result"),
                Some(s) => format!("{agent_name} exited with {s}: {tail}"),
                None => format!("{agent_name} terminated: {tail}"),
            };
            // The status only: the stderr tail can echo the conversation, and chat text
            // never goes to the log.
            let outcome = match status {
                Some(s) if s.success() => "exited without a result".to_string(),
                Some(s) => format!("exited with {s}"),
                None => "terminated".to_string(),
            };
            crate::diag::warn("root-chat", format!("turn failed: {agent_name} {outcome}"));
            state_arc.publish(json!({ "event": "error", "chatId": chat_id, "message": message }));
            let _ = app.emit(
                "root-chat-error",
                json!({ "chatId": chat_id, "message": message }),
            );
        }
    });
    Ok(())
}

/// One stdout line of either agent's turn, as the reader thread acts on it.
enum TurnOut {
    Items(Vec<Value>),
    Done(Value),
    /// The turn ended with an error the agent reported itself (agy `status: ERROR`).
    Failed(String),
    /// agy's conversation id (its `init` line): stored so the next turn resumes it.
    Conversation(String),
    Nothing,
}

/// How much of a turn's stderr is kept for its error message (the tail; the rest is read
/// and dropped so the pipe never fills).
const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// Read `r` to EOF keeping only its last `max` bytes, as lossy UTF-8 (a cut that lands
/// inside a character costs that character, nothing else).
pub(crate) fn drain_tail(mut r: impl Read, max: usize) -> String {
    let mut tail: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > max {
                    let excess = tail.len() - max;
                    tail.drain(..excess);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&tail).into_owned()
}

/// Where one turn of a Claude chat writes its `--mcp-config`. It may carry a user MCP
/// server's env/headers, so it lives only while that turn's child does.
fn mcp_config_path(chat_id: &str, turn: &str) -> PathBuf {
    crate::store::data_dir().join(format!("rootchat-mcp-{chat_id}-{turn}.json"))
}

fn remove_file_opt(path: Option<&std::path::Path>) {
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }
}

/// Is `name` one of `chat_id`'s MCP config files: a per-turn one, or the single
/// `rootchat-mcp-<id>.json` older builds wrote and never deleted?
fn is_mcp_config_of(name: &str, chat_id: &str) -> bool {
    let Some(rest) = name
        .strip_prefix("rootchat-mcp-")
        .and_then(|r| r.strip_prefix(chat_id))
    else {
        return false;
    };
    rest == ".json" || (rest.starts_with('-') && rest.ends_with(".json"))
}

/// Delete every MCP config file a chat left behind (the chat was deleted).
pub fn remove_mcp_configs(chat_id: &str) {
    remove_mcp_configs_in(&crate::store::data_dir(), chat_id);
}

/// Delete every chat's leftover MCP config. Called at startup, before any turn can run:
/// a crash or End task mid-turn skips the reader thread's cleanup.
pub fn remove_all_mcp_configs() {
    remove_matching(&crate::store::data_dir(), |n| {
        n.starts_with("rootchat-mcp-") && n.ends_with(".json")
    });
}

fn remove_mcp_configs_in(dir: &std::path::Path, chat_id: &str) {
    remove_matching(dir, |n| is_mcp_config_of(n, chat_id));
}

fn remove_matching(dir: &std::path::Path, matches: impl Fn(&str) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if matches(&entry.file_name().to_string_lossy()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Write a file only its owner can read where the platform allows it (the MCP config may
/// carry a user server's tokens). On Windows the data dir's inherited ACL is already
/// per-user. Never logged.
fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(text.as_bytes())
}

// Async: a tree kill runs `taskkill` and waits for it under the children lock, which must
// never happen on the UI thread (see "Architecture gotchas" in CLAUDE.md).
#[tauri::command(async)]
pub fn root_chat_stop(chat_id: String, state: State<Arc<RootChatState>>) {
    // A tree kill: the child is the `cmd.exe /C` wrapper, and killing only it on Windows
    // left the real `claude -p` running the turn to the end.
    state.stop(&chat_id);
}

/// Parse a chat's transcript into renderable items. Shared by the `root_chat_history`
/// command and root_mcp's `chat_read`, so the two can never drift.
pub fn history_items(store: &crate::store::Store, chat_id: &str) -> Vec<Value> {
    // An Antigravity chat's history is agy's own conversation database, read by the same
    // decoder a phone uses for an agy session.
    if let Some(chat) = store
        .root_chat(chat_id)
        .filter(|c| c.agent == crate::agent::AgentId::Antigravity)
    {
        let cfg = store.root_chat_config_dir(chat_id);
        return chat
            .agy_conversation_id
            .as_deref()
            .and_then(|cid| {
                let home = crate::agy_usage::resolve_agy_home(cfg.as_deref())?;
                crate::agy_transcript::conversation_db(&home, cid)
            })
            .and_then(|db| crate::agy_transcript::read_items(&db).ok())
            .unwrap_or_default();
    }
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
/// the root MCP server is up and its config was written) — the charter must never promise tools
/// the process cannot reach.
pub fn build_charter(
    workspace_root: &str,
    projects: &[(String, String)],
    scoped: bool,
    dirs: &Dirs,
    memory_index: &str,
    has_tools: bool,
) -> String {
    build_charter_for(
        false,
        workspace_root,
        projects,
        scoped,
        dirs,
        memory_index,
        has_tools,
    )
}

/// What a Claude chat can run, stated exactly. `-p` refuses every unallowed call before it
/// runs, and a model never told it has no shell keeps trying one: measured in a real chat,
/// 3 of 24 calls were refusals (`Bash` with `$var`, PowerShell scripts, `pwsh -File`).
/// This must match `build_command`'s allow list -- the test pins both halves.
pub const TOOL_POLICY: &str = "Tools -- exactly what this chat can run. Anything else is \
     refused before it runs, so never try it:\n\
     - Files: Read, Glob and Grep, anywhere you are allowed to look. Glob returns matches \
     NEWEST FIRST (by modification time), so a Glob over a project (e.g. `**/*.md` with \
     the project's path) is how to answer \"what changed recently\".\n\
     - Web: WebSearch and WebFetch.\n\
     - Writing: Write and Edit, ONLY inside your scratchpad and the shared memory below.\n\
     - Bash: ONLY the `gh` CLI, one plain command at a time (`gh pr list --repo o/r`, \
     `gh issue view 12`, `gh run view`). No pipes, `&&`, `;`, redirects, `$VAR` or \
     `$(...)` -- a command containing any of them is refused.\n\
     - There is NO general shell: no other Bash command, no PowerShell, no `pwsh -File`, \
     no scripts, no git, no package managers. Do not try to work around this. If \
     something truly needs a shell, say so and write a brief for a coding session \
     instead.";

/// Appended to the charter for a deep-research chat.
pub const RESEARCH_BRIEF: &str = "\n\nDeep research mode: the user wants a thorough, sourced \
     answer, not a quick one. Search broadly -- many queries, phrased different ways. Read \
     the primary sources themselves (WebFetch the page; do not stop at search snippets), \
     cross-check every important claim against at least one independent source, cite the \
     links you relied on next to the claims they support, and say plainly what is \
     uncertain, disputed or could not be verified.";

/// What a scoped chat with nothing attached is told instead of a roster. Every chat the phone
/// starts begins this way, so a question about a project must lead the user to attach it,
/// never to a guess.
pub const NOTHING_ATTACHED: &str = "No projects are attached to this chat; if the user asks \
     about a project, tell them to attach it from the chat's settings.";

/// The registered project paths a SCOPED chat may not read (Read/Glob/Grep denies for
/// Claude, `read_file` denies for agy): every one outside the scope, but never a folder that
/// CONTAINS an in-scope project -- a deny would win over it too. An unscoped chat (None: a
/// chat from before scopes) denies nothing; an EMPTY scope denies every registered project.
pub fn out_of_scope_paths(scoped: bool, all: &[String], in_scope: &[String]) -> Vec<String> {
    if !scoped {
        return Vec::new();
    }
    all.iter()
        .filter(|path| !in_scope.iter().any(|i| contains_path(path, i)))
        .cloned()
        .collect()
}

/// Read denies every chat carries, scoped or not: `dirs` are trees, `files` single files.
#[derive(Debug, Default, PartialEq)]
pub struct PrivateDenies {
    pub dirs: Vec<String>,
    pub files: Vec<String>,
}

/// What no chat may read: the worktree of every private (`silo || local_only`) session, and
/// the transcript stores -- under each Claude config root `projects/`, `file-history/`,
/// `todos/` and `history.jsonl`; under each agy home its `conversations/`. Never all of a
/// config root (skills live there), never a path that CONTAINS an in-scope project (a deny
/// would win over it too), never an empty path, and each path once.
pub fn private_read_denies(
    projects: &[crate::store::Project],
    claude_roots: &[PathBuf],
    agy_homes: &[PathBuf],
    in_scope: &[String],
) -> PrivateDenies {
    let mut dirs: Vec<String> = projects
        .iter()
        .flat_map(|p| p.sessions.iter())
        .filter(|s| s.silo || s.local_only)
        .filter_map(|s| s.worktree_path.clone())
        .collect();
    let mut files = Vec::new();
    for root in claude_roots {
        for sub in ["projects", "file-history", "todos"] {
            dirs.push(root.join(sub).to_string_lossy().into_owned());
        }
        files.push(root.join("history.jsonl").to_string_lossy().into_owned());
    }
    for home in agy_homes {
        let conv = home
            .join(".gemini")
            .join("antigravity-cli")
            .join("conversations");
        dirs.push(conv.to_string_lossy().into_owned());
    }
    let keep = |list: Vec<String>| -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        list.into_iter()
            .filter(|p| !p.trim().is_empty())
            .filter(|p| !in_scope.iter().any(|i| contains_path(p, i)))
            .filter(|p| seen.insert(p.replace('\\', "/").trim_end_matches('/').to_lowercase()))
            .collect()
    };
    PrivateDenies {
        dirs: keep(dirs),
        files: keep(files),
    }
}

/// Every Claude config root a chat could read transcripts under: the ambient one
/// (`CLAUDE_CONFIG_DIR`, else `~/.claude`), `~/.claude` itself, and each account's.
pub fn claude_config_roots(account_dirs: &[String]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = crate::pty::claude_projects_dir()
        .and_then(|p| p.parent().map(|r| r.to_path_buf()))
        .into_iter()
        .collect();
    roots.extend(dirs::home_dir().map(|h| h.join(".claude")));
    roots.extend(
        account_dirs
            .iter()
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from),
    );
    roots
}

/// Every agy home a chat could read conversations under: the ambient one and each account's,
/// resolved exactly as a spawn resolves it (`agy_usage::resolve_agy_home`).
pub fn agy_homes(account_dirs: &[String]) -> Vec<PathBuf> {
    let mut homes: Vec<PathBuf> = crate::agy_usage::resolve_agy_home(None)
        .into_iter()
        .collect();
    homes.extend(
        account_dirs
            .iter()
            .filter(|d| !d.trim().is_empty())
            .filter_map(|d| crate::agy_usage::resolve_agy_home(Some(d))),
    );
    homes
}

/// The charter, for a Claude chat (`agy == false`) or the shared base of an Antigravity
/// chat's (`root_chat_agy::charter` adds what differs there): the Claude-only tool policy,
/// GitHub powers and writable dirs are left out of the latter. `scoped` = the chat has a
/// scope, so `projects` is what is ATTACHED to it rather than everything registered.
pub fn build_charter_for(
    agy: bool,
    workspace_root: &str,
    projects: &[(String, String)],
    scoped: bool,
    dirs: &Dirs,
    memory_index: &str,
    has_tools: bool,
) -> String {
    let heading = if scoped {
        "Projects attached to this chat (the only ones you know about or may read)"
    } else {
        "Registered Conduit projects"
    };
    let roster = if projects.is_empty() && scoped {
        NOTHING_ATTACHED.to_string()
    } else if projects.is_empty() {
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
    if agy {
        return format!(
            "You are Conduit's general chat: a project-management and ideation partner for \
             the user's whole workspace. You are not a code agent: you never modify project \
             files or write code into repositories. When a conversation lands on something \
             that should be built, produce a concise implementation brief the user can hand \
             to a coding session in the relevant project.\n\n\
             Shared memory (written by the user's other chats; read it when useful):\n\
             {memory}\nThe current index:\n{index}\n\n\
             Workspace root: {workspace_root}\n\n\
             {heading}:\n{roster}"
        );
    }
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
         {TOOL_POLICY}\n\n\
         Scratchpad (private to THIS chat — drafts, notes, working files):\n{scratch}\n\n\
         Shared memory (every root chat reads and writes it):\n{memory}\n\
         `MEMORY.md` there is the index — one line per fact file. To remember something \
         durable, write one focused markdown file per fact and add or refresh its index \
         line; update or delete entries that turn out stale. The current index:\n\
         {index}\n\
         {orchestration}\n\n\
         Workspace root: {workspace_root}\n\n\
         {heading}:\n{roster}"
    )
}

/// The full shell command for one message. `resume` = a transcript for this chat id
/// already exists (decided by the caller via `pty::transcript_exists`). `mcp_config` is
/// the path to the per-chat `--mcp-config` file (`root_chat_options::merged_mcp_config`), or `None`
/// when the root MCP server never bound a port.
///
/// The tests' shorthand for [`build_command_with`] with no per-chat choices.
#[cfg(test)]
pub fn build_command(
    chat_id: &str,
    resume: bool,
    charter_file: &str,
    dirs: &Dirs,
    mcp_config: Option<&str>,
    denied_paths: &[String],
) -> String {
    build_command_with(
        chat_id,
        resume,
        charter_file,
        dirs,
        mcp_config,
        denied_paths,
        &TurnFlags::default(),
    )
}

/// A Claude chat's per-turn choices (`RootChat` model / effort / MCP servers).
#[derive(Default)]
pub struct TurnFlags<'a> {
    pub model: Option<&'a str>,
    /// Already raised for deep research (`root_chat_options::effective_effort`).
    pub effort: Option<&'a str>,
    /// User MCP servers written into `mcp_config` beside Conduit's: each must ALSO be on
    /// `--allowedTools`, or `-p` denies its every call (same rule as the root namespace).
    pub user_mcps: &'a [String],
    /// Single FILES the file tools may not read (`Read(<file>)`; `denied_paths` are trees).
    pub denied_files: &'a [String],
}

pub fn build_command_with(
    chat_id: &str,
    resume: bool,
    charter_file: &str,
    dirs: &Dirs,
    mcp_config: Option<&str>,
    denied_paths: &[String],
    flags: &TurnFlags,
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
    let mut root_tools = if mcp_config.is_some() {
        format!(",{}", crate::root_mcp::TOOL_NAMESPACE)
    } else {
        String::new()
    };
    if mcp_config.is_some() {
        for name in flags
            .user_mcps
            .iter()
            .filter(|n| crate::root_chat_options::valid_mcp_name(n))
        {
            root_tools.push_str(&format!(",mcp__{name}"));
        }
    }
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
    // Every chat is denied private worktrees and the transcript stores (`private_read_denies`).
    let mut out_of_scope: String = denied_paths
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            let r = permission_path(p);
            format!(",Read({r}/**),Glob({r}/**),Grep({r}/**)")
        })
        .collect();
    for f in flags.denied_files.iter().filter(|f| !f.trim().is_empty()) {
        out_of_scope.push_str(&format!(",Read({})", permission_path(f)));
    }
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
    let mut choice = String::new();
    if let Some(m) = flags
        .model
        .filter(|m| crate::root_chat_options::valid_model(m))
    {
        choice.push_str(&format!(" --model {}", crate::pty::quote_cmdline_arg(m)));
    }
    if let Some(e) = flags
        .effort
        .filter(|e| crate::root_chat_options::valid_effort(e))
    {
        choice.push_str(&format!(" --effort {e}"));
    }
    format!(
        "claude -p --output-format stream-json --verbose \
         --allowedTools {allow} \
         --disallowedTools {deny} \
         --add-dir {add}{mcp} \
         --strict-mcp-config{choice} \
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
    fn every_chat_is_denied_private_worktrees_and_transcript_stores() {
        use std::path::Path;
        let project: crate::store::Project = serde_json::from_value(json!({
            "id": "p", "name": "p", "path": "/w/p",
            "sessions": [
                { "id": "a", "name": "a", "worktreePath": "/w/p/.claude/worktrees/a", "silo": true },
                { "id": "b", "name": "b", "worktreePath": "/w/p/.claude/worktrees/b", "localOnly": true },
                { "id": "c", "name": "c", "worktreePath": "/w/p/.claude/worktrees/c" },
                { "id": "d", "name": "d", "silo": true }
            ]
        }))
        .unwrap();
        let roots = [
            Path::new("/h/.claude").to_path_buf(),
            Path::new("/h/.claude/").to_path_buf(),
        ];
        let homes = [Path::new("/h").to_path_buf()];
        let d = private_read_denies(&[project], &roots, &homes, &["/w/p".to_string()]);
        let norm: Vec<String> = d.dirs.iter().map(|p| p.replace('\\', "/")).collect();
        for want in [
            "/w/p/.claude/worktrees/a",
            "/w/p/.claude/worktrees/b",
            "/h/.claude/projects",
            "/h/.claude/file-history",
            "/h/.claude/todos",
            "/h/.gemini/antigravity-cli/conversations",
        ] {
            assert!(norm.iter().any(|p| p == want), "{want} in {norm:?}");
        }
        assert!(
            !norm.iter().any(|p| p.ends_with("/worktrees/c")),
            "a public worktree stays readable"
        );
        assert!(
            !norm.iter().any(|p| p == "/h/.claude"),
            "skills live in the config root"
        );
        assert_eq!(norm.len(), 6, "each path once: {norm:?}");
        assert_eq!(d.files.len(), 1);
        assert!(d.files[0]
            .replace('\\', "/")
            .ends_with("/h/.claude/history.jsonl"));
        // A store that CONTAINS an in-scope project is never denied.
        let held = private_read_denies(&[], &roots, &homes, &["/h/.claude/projects/x".to_string()]);
        assert!(!held
            .dirs
            .iter()
            .any(|p| p.replace('\\', "/") == "/h/.claude/projects"));

        // Claude: trees as Read/Glob/Grep(<p>/**), the history file as Read(<p>).
        let dd = Dirs::under(Path::new("/data"), "x");
        let files = vec!["C:\\Users\\me\\.claude\\history.jsonl".to_string()];
        let cmd = build_command_with(
            "x",
            false,
            "c",
            &dd,
            None,
            &["C:\\Users\\me\\.claude\\projects".to_string(), " ".into()],
            &TurnFlags {
                denied_files: &files,
                ..Default::default()
            },
        );
        for rule in [
            "Read(//c/Users/me/.claude/projects/**)",
            "Glob(//c/Users/me/.claude/projects/**)",
            "Grep(//c/Users/me/.claude/projects/**)",
            "Read(//c/Users/me/.claude/history.jsonl)",
        ] {
            assert!(cmd.contains(rule), "{rule}: {cmd}");
        }
        assert!(
            !cmd.contains("Read(///**)") && !cmd.contains("Read(/ /**)"),
            "{cmd}"
        );
        assert!(!cmd.contains("history.jsonl/**"));
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
            false,
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
        let empty = build_charter("/Users/u", &[], false, &d, "", false);
        assert!(empty.contains("(none registered yet)"));
        assert!(empty.contains("(empty — no memories yet)"));
    }

    #[test]
    fn an_empty_scope_attaches_nothing_and_denies_every_project() {
        let all = vec!["/w/a".to_string(), "/w/b".to_string(), "/w".to_string()];
        // None (a chat from before scopes) = everything: no denies.
        assert!(out_of_scope_paths(false, &all, &[]).is_empty());
        // An empty scope (every new phone chat) = nothing: every registered project denied.
        assert_eq!(out_of_scope_paths(true, &all, &[]), all);
        // Attaching one keeps it and the folder holding it readable.
        assert_eq!(
            out_of_scope_paths(true, &all, &["/w/a".to_string()]),
            vec!["/w/b".to_string()]
        );
        // The charter says plainly that nothing is attached, for both agents.
        let d = tdirs();
        for agy in [false, true] {
            let c = build_charter_for(agy, "/w", &[], true, &d, "", false);
            assert!(c.contains(NOTHING_ATTACHED), "{c}");
            assert!(!c.contains("(none registered yet)"));
        }
        let attached = build_charter("/w", &[("a".into(), "/w/a".into())], true, &d, "", false);
        assert!(attached.contains("Projects attached to this chat"));
        assert!(attached.contains("- a: /w/a"));
        assert!(!attached.contains(NOTHING_ATTACHED));
    }

    #[test]
    fn charter_explains_the_orchestration_tools_only_when_they_exist() {
        let d = tdirs();
        let with = build_charter("/w", &[], false, &d, "", true);
        assert!(with.contains("dispatch_work"));
        assert!(
            with.contains("approve"),
            "the charter must say the user approves: {with}"
        );
        let without = build_charter("/w", &[], false, &d, "", false);
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
    fn charter_states_exactly_what_the_chat_can_run() {
        let c = build_charter("/w", &[], false, &tdirs(), "", true);
        assert!(
            c.contains(TOOL_POLICY),
            "the tool policy must be in every Claude charter"
        );
        // The measured failures: a shell the model believed it had.
        for must in [
            "NO general shell",
            "PowerShell",
            "pwsh -File",
            "$VAR",
            "Glob",
            "NEWEST FIRST",
        ] {
            assert!(TOOL_POLICY.contains(must), "policy must mention {must}");
        }
        // And it must agree with the allow list: everything it names as runnable is allowed,
        // and Bash is allowed ONLY as `gh`.
        let cmd = build_command("x", false, "c", &tdirs(), None, &[]);
        for tool in [
            "Read",
            "Glob",
            "Grep",
            "WebSearch",
            "WebFetch",
            "Bash(gh:*)",
        ] {
            assert!(cmd.contains(tool), "{tool} must be allowed: {cmd}");
        }
        for not_allowed in ["Bash,", "Bash(*", "PowerShell", "Bash(git", "Bash(pwsh"] {
            assert!(
                !cmd.contains(not_allowed),
                "{not_allowed} must stay unallowed: {cmd}"
            );
        }
        // An Antigravity chat gets neither the Claude tool policy nor the writable dirs.
        let agy = build_charter_for(true, "/w", &[], false, &tdirs(), "", false);
        assert!(!agy.contains(TOOL_POLICY));
        assert!(!agy.contains("Bash"));
        assert!(agy.contains("never modify project files"));
    }

    #[test]
    fn chat_choices_become_flags_and_user_mcps_are_allowed() {
        let d = tdirs();
        let mcps = vec!["github".to_string(), "bad,name".to_string()];
        let cmd = build_command_with(
            "x",
            false,
            "c",
            &d,
            Some("/cfg.json"),
            &[],
            &TurnFlags {
                model: Some("opus"),
                effort: Some("max"),
                user_mcps: &mcps,
                ..Default::default()
            },
        );
        assert!(
            cmd.contains(&format!(
                " --model {}",
                crate::pty::quote_cmdline_arg("opus")
            )),
            "{cmd}"
        );
        assert!(cmd.contains(" --effort max"), "{cmd}");
        assert!(cmd.contains(",mcp__github"), "{cmd}");
        assert!(
            !cmd.contains("bad,name"),
            "an unusable name never reaches the allow list"
        );
        assert!(cmd.contains(crate::root_mcp::TOOL_NAMESPACE));
        assert!(cmd.contains("--strict-mcp-config"));
        // Garbage never reaches the command line.
        let bad = build_command_with(
            "x",
            false,
            "c",
            &d,
            None,
            &[],
            &TurnFlags {
                model: Some("a\" && calc"),
                effort: Some("turbo"),
                user_mcps: &mcps,
                ..Default::default()
            },
        );
        assert!(
            !bad.contains("--model") && !bad.contains("--effort"),
            "{bad}"
        );
        assert!(!bad.contains("mcp__"), "no config, nothing to allow: {bad}");
        // No choices: exactly the old command.
        assert_eq!(
            build_command("x", false, "c", &d, None, &[]),
            build_command_with("x", false, "c", &d, None, &[], &TurnFlags::default())
        );
        assert!(!build_command("x", false, "c", &d, None, &[]).contains("--model"));
    }

    #[test]
    fn research_brief_asks_for_sources() {
        for must in ["WebFetch", "cite", "uncertain"] {
            assert!(RESEARCH_BRIEF.contains(must), "{must}");
        }
    }

    #[test]
    fn stderr_is_drained_whole_and_only_its_tail_kept() {
        // Far past a pipe buffer: the reader must keep consuming, holding only the tail.
        let mut input = vec![b'x'; 1 << 20];
        input.extend_from_slice(b"the real error");
        let tail = drain_tail(std::io::Cursor::new(input), 64);
        assert_eq!(tail.len(), 64);
        assert!(tail.ends_with("the real error"));
        assert_eq!(
            drain_tail(std::io::Cursor::new(b"short".to_vec()), 64),
            "short"
        );
        assert_eq!(drain_tail(std::io::empty(), 64), "");
    }

    #[test]
    fn a_deleted_chat_takes_its_mcp_configs_and_only_its_own() {
        let dir = std::env::temp_dir().join(format!("conduit-rcmcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mine = ["rootchat-mcp-abc.json", "rootchat-mcp-abc-t1.json"];
        let others = [
            "rootchat-mcp-abcd.json",
            "rootchat-mcp-abcd-t1.json",
            "rootchat-mcp-xyz-t1.json",
            "state.json",
        ];
        for n in mine.iter().chain(others.iter()) {
            std::fs::write(dir.join(n), "{}").unwrap();
        }
        remove_mcp_configs_in(&dir, "abc");
        for n in mine {
            assert!(!dir.join(n).exists(), "{n} removed");
        }
        for n in others {
            assert!(dir.join(n).exists(), "{n} kept");
        }
        let _ = std::fs::remove_dir_all(&dir);
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
