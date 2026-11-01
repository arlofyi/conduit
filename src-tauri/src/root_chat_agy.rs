//! Antigravity general chats: one `agy` print-mode process per turn, its stream-json mapped
//! onto the same chat items a Claude turn publishes. Every flag and line shape here was
//! measured against agy 1.4.12 -- see
//! docs/superpowers/specs/2026-11-01-agy-print-mode-findings.md before changing any of it.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// The shell command for one turn. The prompt does NOT ride the command line: `-p` takes its
/// prompt as the flag's own value (a newline would end a cmd.exe line, a quote would be
/// re-parsed), so the turn is fed as ONE stream-json input line on stdin
/// ([`stdin_line`]) and the process exits at EOF.
pub fn build_command(
    settings_file: &str,
    conversation: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    add_dirs: &[String],
) -> String {
    let q = crate::pty::quote_cmdline_arg;
    let mut cmd = format!(
        "agy --output-format stream-json --input-format stream-json --settings {}",
        q(settings_file)
    );
    // Only a real UUID is replayed: it came from agy's own stream, but it reaches a command
    // line, so it is parsed and re-rendered rather than trusted.
    if let Some(id) = conversation.and_then(|c| uuid::Uuid::parse_str(c.trim()).ok()) {
        cmd.push_str(&format!(" --conversation {}", id.hyphenated()));
    }
    if let Some(m) = model.filter(|m| crate::root_chat_options::valid_model(m)) {
        cmd.push_str(&format!(" --model {}", q(m)));
    }
    if let Some(e) = effort.filter(|e| crate::root_chat_options::valid_effort(e)) {
        cmd.push_str(&format!(" --effort {e}"));
    }
    for d in add_dirs.iter().filter(|d| !d.trim().is_empty()) {
        cmd.push_str(&format!(" --add-dir {}", q(d)));
    }
    cmd
}

/// The one stdin line that carries the user's message (`--input-format stream-json`).
pub fn stdin_line(text: &str) -> String {
    let mut s = json!({
        "event": "user",
        "message": { "role": "user", "content": text },
    })
    .to_string();
    s.push('\n');
    s
}

/// `--settings` for an Antigravity chat: session-only permission rules (never saved to the
/// user's settings.json). Print mode cannot prompt, so an unallowed tool is auto-denied --
/// but the user's OWN `permissions.allow` still applies there (measured: theirs allows
/// `git commit`, `npx`, ...), so the chat's read-only policy is enforced with DENY rules,
/// which win: no shell, no file writes, no browser actions, no MCP tools, and no reads of a
/// registered project outside the chat's scope. `read_file(<dir>)` matches the whole tree.
pub fn settings_json(denied_read_paths: &[String]) -> String {
    let mut deny: Vec<String> = ["command(*)", "write_file(*)", "execute_url(*)", "mcp(*)"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for p in denied_read_paths {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/');
        // An EMPTY read_file() rule denies the working directory itself (measured).
        if !p.trim().is_empty() {
            deny.push(format!("read_file({p})"));
        }
    }
    json!({ "permissions": { "deny": deny } }).to_string()
}

/// What one agy stream-json stdout line means to the chat.
#[derive(Debug)]
pub enum AgyOut {
    /// The `init` line: the conversation this turn runs in (new on a first turn).
    Init(String),
    Items(Vec<Value>),
    /// The `result` line. `Ok` carries the `done` payload; `Err` the message of a failed
    /// turn (agy reports `status: "ERROR"` with an `error` string, and no reply).
    Done(Result<Value, String>),
    Nothing,
}

/// Folds one turn's `step_update` lines into chat items. A reply streams as `text_delta`
/// pieces of one `agent_response` step and is emitted whole when that step is DONE (the
/// Claude path also publishes a reply per message, not per token). A tool step is emitted
/// as its call the first time it is seen and as its result when it settles.
#[derive(Default)]
pub struct AgyStream {
    conversation: String,
    texts: HashMap<i64, String>,
    calls: HashSet<i64>,
}

impl AgyStream {
    pub fn line(&mut self, line: &str) -> AgyOut {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return AgyOut::Nothing;
        };
        match v.get("event").and_then(|e| e.as_str()) {
            Some("init") => match v.get("conversation_id").and_then(|c| c.as_str()) {
                Some(c) => {
                    self.conversation = c.to_string();
                    AgyOut::Init(c.to_string())
                }
                None => AgyOut::Nothing,
            },
            Some("step_update") => match v.get("step_update") {
                Some(s) => self.step(s),
                None => AgyOut::Nothing,
            },
            Some("result") => {
                let r = v.get("result").cloned().unwrap_or(Value::Null);
                let status = r.get("status").and_then(|s| s.as_str()).unwrap_or("");
                if status == "SUCCESS" {
                    AgyOut::Done(Ok(json!({
                        "isError": false,
                        "result": r.get("response").and_then(|x| x.as_str()).unwrap_or(""),
                        "costUsd": Value::Null,
                        "numTurns": r.get("num_turns").and_then(|n| n.as_i64()),
                    })))
                } else {
                    let msg = r
                        .get("error")
                        .and_then(|e| e.as_str())
                        .filter(|e| !e.is_empty())
                        .unwrap_or("Antigravity ended the turn with an error");
                    AgyOut::Done(Err(msg.to_string()))
                }
            }
            _ => AgyOut::Nothing,
        }
    }

    fn step(&mut self, s: &Value) -> AgyOut {
        let idx = s.get("step_index").and_then(|i| i.as_i64()).unwrap_or(-1);
        let state = s.get("state").and_then(|x| x.as_str()).unwrap_or("");
        let settled = matches!(state, "DONE" | "ERROR" | "CANCELED" | "CANCELLED");
        let mut lines: Vec<Value> = Vec::new();
        match s.get("step_type").and_then(|t| t.as_str()) {
            Some("agent_response") => {
                let text = self.texts.entry(idx).or_default();
                if let Some(d) = s.get("text_delta").and_then(|d| d.as_str()) {
                    text.push_str(d);
                }
                if settled {
                    let text = self.texts.remove(&idx).unwrap_or_default();
                    if !text.trim().is_empty() {
                        lines.push(json!({"type": "assistant", "message": {"content": [
                            {"type": "text", "text": text.trim_end()}
                        ]}}));
                    }
                }
            }
            Some("tool") => {
                let info = s.get("tool_info").cloned().unwrap_or(Value::Null);
                let name = info
                    .get("name")
                    .or_else(|| s.get("tool_name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool");
                let id = format!("agy-{}-{idx}", self.conversation);
                if self.calls.insert(idx) {
                    let args = info.get("parameters").cloned().unwrap_or(json!({}));
                    let (claude_name, input) = crate::agy_transcript::claude_tool(name, &args);
                    lines.push(json!({"type": "assistant", "message": {"content": [
                        {"type": "tool_use", "id": id, "name": claude_name, "input": input}
                    ]}}));
                }
                if settled {
                    let (is_error, text) = match state {
                        "DONE" => (
                            false,
                            info.get("output")
                                .and_then(|o| o.as_str())
                                .unwrap_or("")
                                .to_string(),
                        ),
                        "ERROR" => (
                            true,
                            info.pointer("/error/message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("Failed")
                                .to_string(),
                        ),
                        _ => (true, "Cancelled".to_string()),
                    };
                    lines.push(json!({"type": "user", "message": {"content": [
                        {"type": "tool_result", "tool_use_id": id, "is_error": is_error,
                         "content": text}
                    ]}}));
                }
            }
            _ => {}
        }
        let items: Vec<Value> = lines
            .iter()
            .flat_map(|l| crate::transcript::parse_line(&l.to_string()))
            .collect();
        if items.is_empty() {
            AgyOut::Nothing
        } else {
            AgyOut::Items(items)
        }
    }
}

/// The charter an Antigravity chat reads from `AGENTS.md` in its working directory (agy has
/// no system-prompt flag; measured: it follows an `AGENTS.md` in the cwd). Same role and
/// boundaries as a Claude chat's, minus what agy cannot do here.
pub fn charter(base: &str) -> String {
    format!(
        "{base}\n\n\
         Running on Antigravity: you have NO Conduit tools (no sessions_list, session_peek, \
         dispatch_work or chat tools) -- if the user asks for one, say it needs a Claude \
         chat. Shell commands, file writes, browser actions and MCP tools are all denied \
         by policy in this chat, so do not try them: use your file viewing, listing and \
         search tools to read, and search_web / read_url_content for the web. You cannot \
         write to the scratchpad or the shared memory from this chat -- put drafts and \
         briefs in your reply instead.\n\n\
         Each message runs as ONE turn that ends the moment you reply, so never start a \
         subagent, background task or anything that reports back later -- its result would \
         never reach the user. Do the reading yourself with list_dir, find_by_name, \
         grep_search and view_file, and answer in this reply. (Measured: a turn that \
         dispatched a research subagent ended with only a promise to report back.)\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONV: &str = "e5dde83e-e5b5-4d44-9f21-0fa68c5b11f5";

    fn feed(s: &mut AgyStream, lines: &[Value]) -> Vec<AgyOut> {
        lines.iter().map(|l| s.line(&l.to_string())).collect()
    }

    #[test]
    fn the_command_never_carries_the_prompt_and_replays_only_a_uuid() {
        let cmd = build_command(
            "/d/s.json",
            Some(CONV),
            Some("gemini-3.8-flash-low"),
            Some("high"),
            &["/w/app one".to_string(), "".to_string()],
        );
        assert!(cmd.starts_with("agy --output-format stream-json --input-format stream-json"));
        assert!(!cmd.contains(" -p"), "the prompt rides stdin: {cmd}");
        assert!(cmd.contains(&format!("--conversation {CONV}")));
        assert!(cmd.contains("--model gemini-3.8-flash-low"));
        assert!(cmd.contains("--effort high"));
        assert!(cmd.contains(&format!(
            "--add-dir {}",
            crate::pty::quote_cmdline_arg("/w/app one")
        )));
        assert_eq!(cmd.matches("--add-dir").count(), 1, "{cmd}");
        assert!(!cmd.contains("dangerously"));
        let bad = build_command("/s", Some("x && calc"), Some("a b"), Some("ultra"), &[]);
        assert!(!bad.contains("--conversation"));
        assert!(!bad.contains("--model"));
        assert!(!bad.contains("--effort"));
    }

    #[test]
    fn the_stdin_line_is_one_stream_json_user_message() {
        let l = stdin_line("line one\n\"two\"");
        assert!(l.ends_with('\n') && l.matches('\n').count() == 1);
        let v: Value = serde_json::from_str(l.trim()).unwrap();
        assert_eq!(v["event"], "user");
        assert_eq!(v["message"]["content"], "line one\n\"two\"");
    }

    #[test]
    fn settings_deny_shell_writes_and_out_of_scope_reads() {
        let v: Value = serde_json::from_str(&settings_json(&[
            "C:\\work\\other\\".to_string(),
            " ".into(),
        ]))
        .unwrap();
        let deny: Vec<&str> = v["permissions"]["deny"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d.as_str().unwrap())
            .collect();
        for rule in ["command(*)", "write_file(*)", "execute_url(*)", "mcp(*)"] {
            assert!(deny.contains(&rule), "{rule}");
        }
        assert!(deny.contains(&"read_file(C:/work/other)"));
        assert!(!deny
            .iter()
            .any(|d| *d == "read_file()" || d.ends_with("( )")));
        assert!(v["permissions"].get("allow").is_none());
    }

    #[test]
    fn a_turn_maps_to_init_items_and_done() {
        let mut s = AgyStream::default();
        let su = |v: Value| json!({"event": "step_update", "step_update": v});
        let out = feed(
            &mut s,
            &[
                json!({"event": "init", "conversation_id": CONV, "init": {"cwd": "x"}}),
                su(json!({"step_index": 0, "state": "DONE", "step_type": "user_input"})),
                su(
                    json!({"step_index": 1, "state": "ACTIVE", "step_type": "agent_response", "text_delta": "po"}),
                ),
                su(
                    json!({"step_index": 1, "state": "DONE", "step_type": "agent_response", "text_delta": "ng\n"}),
                ),
                su(
                    json!({"step_index": 2, "state": "ACTIVE", "step_type": "tool", "tool_name": "read_file",
                    "tool_info": {"name": "read_file", "parameters": {"Path": "C:/a.txt"}}}),
                ),
                su(
                    json!({"step_index": 2, "state": "DONE", "step_type": "tool", "tool_name": "read_file",
                    "tool_info": {"name": "read_file", "parameters": {"Path": "C:/a.txt"}, "output": "1 lines"}}),
                ),
                su(
                    json!({"step_index": 3, "state": "ERROR", "step_type": "tool", "tool_name": "run_command",
                    "tool_info": {"name": "run_command", "parameters": {"CommandLine": "echo hi"},
                    "error": {"type": "TOOL_ERROR", "message": "denied"}}}),
                ),
                json!({"event": "result", "result": {"conversation_id": CONV, "status": "SUCCESS",
                    "response": "pong\n", "num_turns": 1}}),
            ],
        );
        assert!(matches!(&out[0], AgyOut::Init(c) if c == CONV));
        assert!(matches!(out[1], AgyOut::Nothing));
        assert!(
            matches!(out[2], AgyOut::Nothing),
            "a reply is emitted whole, not per delta"
        );
        match &out[3] {
            AgyOut::Items(i) => {
                assert_eq!(i[0]["kind"], "bubble");
                assert_eq!(i[0]["role"], "assistant");
                assert_eq!(i[0]["text"], "pong");
            }
            o => panic!("{o:?}"),
        }
        match &out[4] {
            AgyOut::Items(i) => {
                assert_eq!(i[0]["kind"], "event");
                assert_eq!(i[0]["event"], "read");
                assert_eq!(i[0]["toolUseId"], format!("agy-{CONV}-2"));
            }
            o => panic!("{o:?}"),
        }
        match &out[5] {
            AgyOut::Items(i) => {
                assert_eq!(i.len(), 1, "the call is not re-emitted when it settles");
                assert_eq!(i[0]["kind"], "result");
                assert_eq!(i[0]["toolUseId"], format!("agy-{CONV}-2"));
            }
            o => panic!("{o:?}"),
        }
        match &out[6] {
            // First seen already settled: the call and its failed result together.
            AgyOut::Items(i) => {
                assert_eq!(i[0]["event"], "bash");
                assert_eq!(i[1]["kind"], "result");
                assert_eq!(i[1]["isError"], true);
            }
            o => panic!("{o:?}"),
        }
        match &out[7] {
            AgyOut::Done(Ok(d)) => {
                assert_eq!(d["isError"], false);
                assert_eq!(d["numTurns"], 1);
            }
            o => panic!("{o:?}"),
        }
        let err = s.line(
            &json!({"event": "result", "result": {"status": "ERROR", "error": "empty prompt"}})
                .to_string(),
        );
        assert!(matches!(err, AgyOut::Done(Err(m)) if m == "empty prompt"));
        assert!(matches!(s.line("not json"), AgyOut::Nothing));
    }

    #[test]
    fn the_charter_says_there_are_no_conduit_tools_and_no_shell() {
        let c = charter("BASE");
        assert!(c.starts_with("BASE"));
        assert!(c.contains("NO Conduit tools"));
        assert!(c.contains("Shell commands"));
    }
}
