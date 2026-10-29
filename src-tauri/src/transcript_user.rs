//! Classify a `type == "user"` transcript line.
//!
//! Claude Code writes far more than typed prompts as `user` lines: background-task
//! notifications, messages from other sessions, slash commands and their output, skill
//! bodies, scheduled prompts. Showing them all as "you said" bubbles misattributes text the
//! human never wrote, so each is mapped to its own item kind here (first matching rule wins).

use serde_json::{json, Value};

/// Largest base64 image payload (chars) passed through inline; bigger ones keep only the
/// media type so a screenshot does not bloat every poll of the transcript.
const MAX_INLINE_IMAGE: usize = 262_144;

/// Remove ANSI CSI escape sequences (`ESC [ params final-byte`) without a regex crate.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            // Parameter/intermediate bytes are 0x20..=0x3F; the final byte is 0x40..=0x7E.
            for n in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&n) {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The text between `<tag>` and `</tag>`, trimmed.
fn tag_text(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = s.find(&open)? + open.len();
    let end = s[start..].find(&close)? + start;
    Some(s[start..end].trim().to_string())
}

/// The opening tag name when `s` starts with `<[a-z][a-z0-9-]*>`.
fn leading_tag(s: &str) -> Option<&str> {
    let rest = s.strip_prefix('<')?;
    let end = rest.find('>')?;
    let name = &rest[..end];
    let mut bytes = name.bytes();
    let first = bytes.next()?;
    if !first.is_ascii_lowercase() {
        return None;
    }
    bytes
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        .then_some(name)
}

/// String content as-is; array content as its text blocks joined by newlines.
fn flat_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn bubble(text: &str) -> Value {
    json!({ "kind": "bubble", "role": "user", "text": text })
}

/// Rules 5-7: caveat preamble (dropped), slash/bash commands, command output.
/// `t` must already be left-trimmed.
fn known_tag(t: &str) -> Option<Vec<Value>> {
    if t.starts_with("<local-command-caveat>") {
        return Some(vec![]);
    }
    if t.starts_with("<command-name>") || t.starts_with("<command-message>") {
        let name = tag_text(t, "command-name")
            .or_else(|| tag_text(t, "command-message").map(|m| format!("/{m}")))
            .unwrap_or_default();
        let args = tag_text(t, "command-args").unwrap_or_default();
        return Some(vec![
            json!({ "kind": "command", "name": name, "args": args }),
        ]);
    }
    if t.starts_with("<bash-input>") {
        let args = tag_text(t, "bash-input").unwrap_or_default();
        return Some(vec![
            json!({ "kind": "command", "name": "!", "args": args }),
        ]);
    }
    command_output(t)
}

/// A command's output as Claude Code writes it: ONE string holding the stdout tag and then
/// the matching stderr tag (`<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`).
/// Each stream becomes its own item, stdout first, and only when it has visible text -- a
/// failed `!` command routinely has empty stdout and its whole story in stderr.
/// `t` must already be left-trimmed; `None` when it is not command output.
fn command_output(t: &str) -> Option<Vec<Value>> {
    let tags = if t.starts_with("<bash-stdout>") || t.starts_with("<bash-stderr>") {
        ["bash-stdout", "bash-stderr"]
    } else if t.starts_with("<local-command-stdout>") || t.starts_with("<local-command-stderr>") {
        ["local-command-stdout", "local-command-stderr"]
    } else {
        return None;
    };
    let mut items = Vec::new();
    for (tag, stream) in tags.into_iter().zip(["stdout", "stderr"]) {
        let body = strip_ansi(&tag_text(t, tag).unwrap_or_default());
        let body = body.trim();
        if !body.is_empty() {
            items.push(json!({ "kind": "command_output", "text": body, "stream": stream }));
        }
    }
    Some(items)
}

/// Rules 3, 5-7, 10, 11 for one piece of non-human text (a string line or an array's text
/// block): injected tags are classified, anything else is a typed prompt.
fn classify_text(t: &str) -> Vec<Value> {
    let lt = t.trim_start();
    if lt.starts_with("<task-notification>") {
        return vec![task_item(lt)];
    }
    if let Some(items) = known_tag(lt) {
        return items;
    }
    // 10. An unrecognised leading tag with no human origin is injected, not typed.
    if let Some(tag) = leading_tag(lt) {
        return vec![json!({ "kind": "note", "tag": tag, "text": t })];
    }
    if t.trim().is_empty() {
        return vec![];
    }
    // 11. Plain text: an older transcript's typed prompt.
    vec![bubble(t)]
}

/// Items for an array of content blocks. `classify` is false for a human origin, whose
/// text is taken verbatim; otherwise each text block goes through the tag rules.
fn parse_blocks(blocks: &[Value], classify: bool, tool_use_result: Option<&Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for b in blocks {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let t = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                if t.starts_with("[Request interrupted by user") {
                    out.push(json!({ "kind": "divider", "label": "Interrupted", "tone": "info" }));
                } else if classify {
                    out.extend(classify_text(t));
                } else if !t.trim().is_empty() {
                    out.push(bubble(t));
                }
            }
            Some("image") => {
                let src = b.get("source");
                let media = src
                    .and_then(|s| s.get("media_type"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("image/png");
                let data = src
                    .and_then(|s| s.get("data"))
                    .and_then(|d| d.as_str())
                    .filter(|d| d.len() <= MAX_INLINE_IMAGE);
                out.push(json!({ "kind": "image", "mediaType": media, "data": data }));
            }
            Some("tool_result") => out.push(result_item(b, tool_use_result)),
            _ => {}
        }
    }
    out
}

/// Longest `errorText`, in chars.
const MAX_ERROR_TEXT: usize = 200;
/// Rendered diff lines kept before the rest is summarised as `more`.
const MAX_DIFF_LINES: usize = 16;

/// First non-empty line of a failed result, skipping a leading `Exit code N` line (it says
/// nothing on its own) unless nothing else follows it. Cut to `MAX_ERROR_TEXT` chars.
fn error_text(content: &Value) -> Option<String> {
    let text = flat_text(content);
    let text = text.trim();
    let text = text.strip_prefix("<tool_use_error>").unwrap_or(text);
    let text = text.strip_suffix("</tool_use_error>").unwrap_or(text);
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next()?;
    let is_exit = first
        .strip_prefix("Exit code ")
        .is_some_and(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_digit() || c == '-'));
    let pick = if is_exit {
        // A shell failure's first stdout line is rarely the error: prefer a line that
        // reads like one, else the last line (where tools print what went wrong).
        const MARKERS: [&str; 7] = [
            "Error",
            "error:",
            "fatal:",
            "denied",
            "not found",
            "No such file",
            "failed",
        ];
        let rest: Vec<&str> = lines.collect();
        rest.iter()
            .find(|l| MARKERS.iter().any(|m| l.contains(m)))
            .or(rest.last())
            .copied()
            .unwrap_or(first)
    } else {
        first
    };
    Some(pick.chars().take(MAX_ERROR_TEXT).collect())
}

/// A `tool_result` block as a `result` item. `tool_use_result` is the same line's top-level
/// `toolUseResult`, the only place an edit's structured patch lives.
fn result_item(block: &Value, tool_use_result: Option<&Value>) -> Value {
    let is_error = block.get("is_error").and_then(|e| e.as_bool()) == Some(true);
    let error_text = if is_error {
        block.get("content").and_then(error_text)
    } else {
        None
    };
    json!({
        "kind": "result",
        "toolUseId": block.get("tool_use_id").and_then(|i| i.as_str()).unwrap_or(""),
        "isError": is_error,
        "errorText": error_text,
        "diff": tool_use_result.and_then(diff_from),
    })
}

type DiffRow = (&'static str, String, Option<i64>, Option<i64>);

fn push_gap(v: &mut Vec<DiffRow>) {
    if v.last().is_none_or(|l| l.0 != "gap") {
        v.push(("gap", String::new(), None, None));
    }
}

/// A compact diff from an edit's `toolUseResult`; `None` unless it is an object carrying a
/// non-empty `structuredPatch` or a `create`.
fn diff_from(r: &Value) -> Option<Value> {
    let file_path = r.get("filePath").and_then(|f| f.as_str()).unwrap_or("");
    if r.get("type").and_then(|t| t.as_str()) == Some("create") {
        let added = r
            .get("content")
            .and_then(|c| c.as_str())
            .map_or(0, |c| c.lines().count());
        return Some(json!({
            "filePath": file_path, "added": added, "removed": 0,
            "created": true, "lines": [], "more": 0,
        }));
    }
    let hunks = r.get("structuredPatch")?.as_array()?;
    if hunks.is_empty() {
        return None;
    }
    let (mut added, mut removed) = (0usize, 0usize);
    let mut rendered: Vec<DiffRow> = Vec::new();
    for (hi, h) in hunks.iter().enumerate() {
        let mut old = h.get("oldStart").and_then(|n| n.as_i64()).unwrap_or(1);
        let mut new = h.get("newStart").and_then(|n| n.as_i64()).unwrap_or(1);
        let raw: Vec<&str> = h
            .get("lines")
            .and_then(|l| l.as_array())
            .map(|a| a.iter().filter_map(|l| l.as_str()).collect())
            .unwrap_or_default();
        let changed = |l: &str| l.starts_with('+') || l.starts_with('-');
        if hi > 0 {
            push_gap(&mut rendered);
        }
        for (i, l) in raw.iter().enumerate() {
            let text: String = l.chars().skip(1).collect();
            let row: DiffRow = match l.chars().next() {
                Some('+') => {
                    added += 1;
                    new += 1;
                    ("add", text, None, Some(new - 1))
                }
                Some('-') => {
                    removed += 1;
                    old += 1;
                    ("del", text, Some(old - 1), None)
                }
                _ => {
                    old += 1;
                    new += 1;
                    let near = (i > 0 && changed(raw[i - 1]))
                        || raw.get(i + 1).is_some_and(|x| changed(x));
                    if !near {
                        push_gap(&mut rendered);
                        continue;
                    }
                    ("ctx", text, Some(old - 1), Some(new - 1))
                }
            };
            rendered.push(row);
        }
    }
    while rendered.last().is_some_and(|r| r.0 == "gap") {
        rendered.pop();
    }
    let lead = rendered.iter().take_while(|r| r.0 == "gap").count();
    rendered.drain(..lead);
    let more = rendered.len().saturating_sub(MAX_DIFF_LINES);
    let lines: Vec<Value> = rendered
        .into_iter()
        .take(MAX_DIFF_LINES)
        .map(|(k, t, o, n)| json!({ "kind": k, "text": t, "oldNo": o, "newNo": n }))
        .collect();
    Some(json!({
        "filePath": file_path, "added": added, "removed": removed,
        "created": false, "lines": lines, "more": more,
    }))
}

fn task_item(text: &str) -> Value {
    let summary = tag_text(text, "summary")
        .or_else(|| tag_text(text, "note"))
        .unwrap_or_default();
    json!({
        "kind": "task",
        "taskId": tag_text(text, "task-id"),
        "status": tag_text(text, "status").unwrap_or_else(|| "unknown".into()),
        "summary": summary,
    })
}

/// Classify a user line into chat items (possibly none).
pub fn parse_user(v: &Value) -> Vec<Value> {
    let Some(content) = v.pointer("/message/content") else {
        return vec![];
    };
    let origin = v.get("origin");
    let origin_kind = origin
        .and_then(|o| o.get("kind"))
        .and_then(|k| k.as_str())
        .unwrap_or("");
    let flag = |k: &str| v.get(k).and_then(|b| b.as_bool()).unwrap_or(false);
    let s = content.as_str();

    // 1. A human origin is authoritative, even over a leading tag in what they pasted.
    if origin_kind == "human" {
        return match (s, content.as_array()) {
            (Some(t), _) => vec![bubble(t)],
            (_, Some(blocks)) => parse_blocks(blocks, false, None),
            _ => vec![],
        };
    }
    // 2. The compact_boundary system line draws the divider; the summary text is noise.
    if flag("isCompactSummary") {
        return vec![];
    }
    let text = flat_text(content);
    let trimmed = text.trim_start();
    // 3. Background task notifications.
    if origin_kind == "task-notification" || trimmed.starts_with("<task-notification>") {
        return vec![task_item(&text)];
    }
    // 4. Messages from another session or subagent.
    if origin_kind == "peer" {
        let from = origin
            .and_then(|o| o.get("name").or_else(|| o.get("from")))
            .and_then(|f| f.as_str())
            .unwrap_or("another session");
        let body = origin
            .and_then(|o| o.get("body"))
            .and_then(|b| b.as_str())
            .unwrap_or(&text);
        return vec![json!({ "kind": "peer", "from": from, "text": body })];
    }
    // 5-7. Caveat, commands, command output (string content only; arrays go via rule 9).
    if let Some(t) = s {
        if let Some(items) = known_tag(t.trim_start()) {
            return items;
        }
    }
    // 8. Meta lines: skill bodies, otherwise a prompt Claude Code injected itself.
    if flag("isMeta") {
        if let Some(rest) = trimmed.strip_prefix("Base directory for this skill:") {
            let path = rest
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .trim_end_matches('/');
            let name = path.rsplit(['/', '\\']).next().unwrap_or("");
            return vec![json!({ "kind": "skill", "name": name })];
        }
        // A pasted screenshot is followed by a sizing note meant for the model
        // ("[Image: original 3600x1786, displayed at …"); the image itself is already shown.
        if text.trim().is_empty() || trimmed.starts_with("[Image") {
            return vec![];
        }
        let label: String = text
            .trim_start()
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(80)
            .collect();
        return vec![json!({ "kind": "auto", "label": label, "text": text })];
    }
    // 9. Array content: typed text, images, interrupts, tool results.
    if let Some(blocks) = content.as_array() {
        return parse_blocks(blocks, true, v.get("toolUseResult"));
    }
    match s {
        Some(t) => classify_text(t),
        None => vec![],
    }
}

/// Classify a `type == "system"` line by `subtype`. Only the ones a reader should see map to
/// an item; hook summaries, timings and the like are machinery and produce nothing.
pub fn parse_system(v: &Value) -> Vec<Value> {
    let content = v.get("content").and_then(|c| c.as_str()).unwrap_or("");
    let divider =
        |label: &str, tone: &str| json!({ "kind": "divider", "label": label, "tone": tone });
    match v.get("subtype").and_then(|s| s.as_str()).unwrap_or("") {
        "compact_boundary" => vec![divider("Conversation compacted", "info")],
        // The first paragraph is the human sentence; what follows is diagnostic detail.
        "model_refusal_fallback" => {
            vec![divider(
                content.split("\n\n").next().unwrap_or(""),
                "warning",
            )]
        }
        "informational" => vec![divider(content, "info")],
        // A `/command`'s output carried on a system line instead of a user one.
        "local_command" => command_output(content.trim_start()).unwrap_or_default(),
        // Dropped: the isMeta prompt the fire injects right after is already an `auto` note.
        "scheduled_task_fire" => vec![],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TASK: &str = "<task-notification>\n<task-id>b1276wxdl</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Background command \"sleep 20\" completed (exit code 0)</summary>\n</task-notification>";

    #[test]
    fn human_origin_wins_over_leading_tag() {
        let v = json!({"type":"user","origin":{"kind":"human"},"message":{"content":"<task-notification> pasted"}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "bubble");
        assert_eq!(items[0]["role"], "user");
    }

    #[test]
    fn task_notification_becomes_task() {
        let v = json!({"type":"user","origin":{"kind":"task-notification","producer":"session-task"},
          "message":{"content":TASK}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "task");
        assert_eq!(i["taskId"], "b1276wxdl");
        assert_eq!(i["status"], "completed");
        assert_eq!(
            i["summary"],
            "Background command \"sleep 20\" completed (exit code 0)"
        );
    }

    #[test]
    fn task_notification_without_origin_still_task() {
        let v = json!({"type":"user","message":{"content":TASK}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "task");
        assert_eq!(i["taskId"], "b1276wxdl");
    }

    #[test]
    fn task_notification_tolerates_missing_fields() {
        let v = json!({"type":"user","message":{"content":"<task-notification>\n<task-id>b2</task-id>\n<note>No completion record was found</note>\n</task-notification>"}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "task");
        assert_eq!(i["status"], "unknown");
        assert_eq!(i["summary"], "No completion record was found");
    }

    #[test]
    fn peer_message_uses_origin_name_and_body() {
        let v = json!({"type":"user","isMeta":true,
          "origin":{"kind":"peer","from":"a8b6","name":"general-purpose","body":"[Subagent hand-back] report"},
          "message":{"content":"<wrapped>[Subagent hand-back] report</wrapped>"}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "peer");
        assert_eq!(i["from"], "general-purpose");
        assert_eq!(i["text"], "[Subagent hand-back] report");
    }

    #[test]
    fn slash_command_becomes_command() {
        let v = json!({"type":"user","message":{"content":"<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>"}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "command");
        assert_eq!(i["name"], "/compact");
        assert_eq!(i["args"], "");
    }

    #[test]
    fn bash_input_becomes_bang_command() {
        let v = json!({"type":"user","message":{"content":"<bash-input>ls -la</bash-input>"}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "command");
        assert_eq!(i["name"], "!");
        assert_eq!(i["args"], "ls -la");
    }

    #[test]
    fn command_output_strips_ansi() {
        let v = json!({"type":"user","message":{"content":"<local-command-stdout>\u{1b}[2mCompacted (ctrl+o to see full summary)\u{1b}[22m</local-command-stdout>"}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "command_output");
        assert_eq!(i["stream"], "stdout");
        assert_eq!(i["text"], "Compacted (ctrl+o to see full summary)");
    }

    #[test]
    fn bang_command_empty_stdout_keeps_stderr() {
        let v = json!({"type":"user","message":{"content":"<bash-stdout></bash-stdout><bash-stderr>sudo: a terminal is required to read the password</bash-stderr>"}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "command_output");
        assert_eq!(items[0]["stream"], "stderr");
        assert_eq!(
            items[0]["text"],
            "sudo: a terminal is required to read the password"
        );
    }

    #[test]
    fn bang_command_stdout_and_stderr_are_two_items_stdout_first() {
        let v = json!({"type":"user","message":{"content":"<bash-stdout>ok\n</bash-stdout><bash-stderr>warning: x</bash-stderr>"}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["stream"], "stdout");
        assert_eq!(items[0]["text"], "ok");
        assert_eq!(items[1]["stream"], "stderr");
        assert_eq!(items[1]["text"], "warning: x");
    }

    #[test]
    fn bang_command_both_streams_empty_is_nothing() {
        let v = json!({"type":"user","message":{"content":"<bash-stdout></bash-stdout><bash-stderr></bash-stderr>"}});
        assert!(parse_user(&v).is_empty());
        let v = json!({"type":"user","message":{"content":"<local-command-stdout></local-command-stdout>"}});
        assert!(parse_user(&v).is_empty());
    }

    #[test]
    fn local_command_stdout_pairs_with_its_stderr() {
        let v = json!({"type":"user","message":{"content":"<local-command-stdout></local-command-stdout><local-command-stderr>\u{1b}[31mfailed\u{1b}[0m</local-command-stderr>"}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["stream"], "stderr");
        assert_eq!(items[0]["text"], "failed");
    }

    #[test]
    fn image_placeholder_meta_is_dropped() {
        let text = "[Image: original 3600x1786, displayed at 2000x992. Multiply coordinates by 1.80 to map to the original image.]";
        let v = json!({"type":"user","isMeta":true,"message":{"content":text}});
        assert!(parse_user(&v).is_empty());
        let v = json!({"type":"user","isMeta":true,"message":{"content":[{"type":"text","text":text}]}});
        assert!(parse_user(&v).is_empty());
    }

    #[test]
    fn system_local_command_maps_to_command_output() {
        let v = json!({"type":"system","subtype":"local_command",
            "content":"<local-command-stdout>Reloaded 3 plugins</local-command-stdout>"});
        let items = parse_system(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "command_output");
        assert_eq!(items[0]["stream"], "stdout");
        assert_eq!(items[0]["text"], "Reloaded 3 plugins");
        let v = json!({"type":"system","subtype":"local_command",
            "content":"<local-command-stdout></local-command-stdout><local-command-stderr>nope</local-command-stderr>"});
        let items = parse_system(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["stream"], "stderr");
    }

    #[test]
    fn scheduled_task_fire_is_dropped() {
        let v = json!({"type":"system","subtype":"scheduled_task_fire",
            "content":"Running scheduled task (Sep 13 3:00am)"});
        assert!(parse_system(&v).is_empty());
    }

    #[test]
    fn caveat_and_compact_summary_are_dropped() {
        let v = json!({"type":"user","isMeta":true,"message":{"content":"<local-command-caveat>Caveat: ignore</local-command-caveat>"}});
        assert!(parse_user(&v).is_empty());
        let v = json!({"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued..."}});
        assert!(parse_user(&v).is_empty());
    }

    #[test]
    fn skill_body_becomes_skill() {
        let v = json!({"type":"user","isMeta":true,"message":{"content":[{"type":"text","text":"Base directory for this skill: /Users/x/.claude/plugins/cache/p/superpowers/7.0.0/skills/brainstorming\n\n# Brainstorming"}]}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "skill");
        assert_eq!(items[0]["name"], "brainstorming");
    }

    #[test]
    fn meta_prompt_becomes_auto() {
        let content = "CONTINUITY RELAY TICK — Arlo Consumer plan session.\nmore";
        let v = json!({"type":"user","isMeta":true,"message":{"content":content}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "auto");
        assert_eq!(
            i["label"],
            "CONTINUITY RELAY TICK — Arlo Consumer plan session."
        );
        assert_eq!(i["text"], content);
    }

    #[test]
    fn interrupt_becomes_divider() {
        let v = json!({"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "divider");
        assert_eq!(i["label"], "Interrupted");
        assert_eq!(i["tone"], "info");
    }

    #[test]
    fn typed_text_with_images_is_bubble_plus_images() {
        let v = json!({"type":"user","origin":{"kind":"human"},"message":{"content":[
            {"type":"text","text":"look"},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], "bubble");
        assert_eq!(items[0]["text"], "look");
        assert_eq!(items[1]["kind"], "image");
        assert_eq!(items[1]["mediaType"], "image/png");
        assert_eq!(items[1]["data"], "AAAA");
    }

    #[test]
    fn large_image_drops_data() {
        let v = json!({"type":"user","message":{"content":[
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"A".repeat(262_145)}}]}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "image");
        assert!(i["data"].is_null());
    }

    #[test]
    fn unknown_tag_without_origin_is_note() {
        let v = json!({"type":"user","message":{"content":"<weird-tag>x</weird-tag>"}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "note");
        assert_eq!(i["tag"], "weird-tag");
        assert_eq!(i["text"], "<weird-tag>x</weird-tag>");
    }

    #[test]
    fn plain_string_without_origin_is_bubble() {
        let v = json!({"type":"user","message":{"content":"add rate limiting"}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "bubble");
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[0]["text"], "add rate limiting");
    }

    fn res(content: Value, is_error: Option<bool>, tur: Option<Value>) -> Value {
        let mut b = json!({"type":"tool_result","tool_use_id":"toolu_1","content":content});
        if let Some(e) = is_error {
            b["is_error"] = json!(e);
        }
        let mut v = json!({"type":"user","message":{"content":[b]}});
        if let Some(t) = tur {
            v["toolUseResult"] = t;
        }
        let items = parse_user(&v);
        assert_eq!(items.len(), 1);
        items.into_iter().next().unwrap()
    }

    #[test]
    fn tool_result_blocks_become_result_items() {
        let i = res(json!("ok"), None, None);
        assert_eq!(i["kind"], "result");
        assert_eq!(i["toolUseId"], "toolu_1");
        assert_eq!(i["isError"], false);
    }

    #[test]
    fn ok_result_has_no_error_text() {
        let i = res(json!("fine"), Some(false), None);
        assert_eq!(i["isError"], false);
        assert!(i["errorText"].is_null());
        assert!(i["diff"].is_null());
    }

    #[test]
    fn error_result_has_first_line() {
        let i = res(json!("Traceback\nline2"), Some(true), None);
        assert_eq!(i["isError"], true);
        assert_eq!(i["errorText"], "Traceback");
    }

    #[test]
    fn error_text_skips_exit_code_line() {
        let i = res(
            json!("Exit code 1\n\nnpm ERR! missing script"),
            Some(true),
            None,
        );
        assert_eq!(i["errorText"], "npm ERR! missing script");
        let i = res(json!("Exit code 2"), Some(true), None);
        assert_eq!(i["errorText"], "Exit code 2");
    }

    #[test]
    fn bash_error_prefers_error_line() {
        let i = res(
            json!("Exit code 1\n=== package.json ===\n{}\nnpm ERR! missing script: test"),
            Some(true),
            None,
        );
        assert_eq!(i["errorText"], "npm ERR! missing script: test");
    }

    #[test]
    fn bash_error_takes_matching_line() {
        let i = res(
            json!("Exit code 2\nSwitched to a new branch 'x'\nfatal: not a repository\nlast"),
            Some(true),
            None,
        );
        assert_eq!(i["errorText"], "fatal: not a repository");
    }

    #[test]
    fn bash_traceback_takes_last_line() {
        let i = res(
            json!("Exit code 1\nTraceback (most recent call last):\n  File \"x.py\", line 3\nAssertionError: MISSING: call-one"),
            Some(true),
            None,
        );
        assert_eq!(i["errorText"], "AssertionError: MISSING: call-one");
    }

    #[test]
    fn tool_use_error_tags_are_stripped() {
        let i = res(
            json!(
                "<tool_use_error>String to replace not found in file.\nString: x</tool_use_error>"
            ),
            Some(true),
            None,
        );
        assert_eq!(i["errorText"], "String to replace not found in file.");
        let i = res(
            json!("<tool_use_error>No scheduled job with id 'abc'</tool_use_error>"),
            Some(true),
            None,
        );
        assert_eq!(i["errorText"], "No scheduled job with id 'abc'");
    }

    #[test]
    fn error_text_from_block_array() {
        let i = res(
            json!([{"type":"image","source":{}},{"type":"text","text":"\nboom\nmore"}]),
            Some(true),
            None,
        );
        assert_eq!(i["errorText"], "boom");
    }

    #[test]
    fn error_text_capped_at_200() {
        let i = res(json!("x".repeat(500)), Some(true), None);
        assert_eq!(i["errorText"].as_str().unwrap().chars().count(), 200);
    }

    #[test]
    fn edit_result_has_diff() {
        let tur = json!({"filePath":"/a.rs","structuredPatch":[{"oldStart":61,"oldLines":5,
            "newStart":61,"newLines":5,"lines":[" a"," b","-c","+C"," d"," e"]}]});
        let i = res(json!("ok"), None, Some(tur));
        let d = &i["diff"];
        assert_eq!(d["filePath"], "/a.rs");
        assert_eq!(d["added"], 1);
        assert_eq!(d["removed"], 1);
        assert_eq!(d["created"], false);
        assert_eq!(d["more"], 0);
        let want = json!([
            {"kind":"ctx","text":"b","oldNo":62,"newNo":62},
            {"kind":"del","text":"c","oldNo":63,"newNo":null},
            {"kind":"add","text":"C","oldNo":null,"newNo":63},
            {"kind":"ctx","text":"d","oldNo":64,"newNo":64},
        ]);
        assert_eq!(d["lines"], want);
    }

    #[test]
    fn diff_has_no_edge_gaps_but_keeps_inner_ones() {
        let tur = json!({"filePath":"/a","structuredPatch":[
            {"oldStart":1,"newStart":1,"lines":[" a","-b","+B"," c"," d"]},
            {"oldStart":50,"newStart":50,"lines":[" e"," f"," g","-h"," i"]}]});
        let i = res(json!("ok"), None, Some(tur));
        let l = i["diff"]["lines"].as_array().unwrap();
        assert_ne!(l.first().unwrap()["kind"], "gap");
        assert_ne!(l.last().unwrap()["kind"], "gap");
        assert!(l.iter().any(|r| r["kind"] == "gap"));
    }

    #[test]
    fn diff_caps_at_16_lines_with_more() {
        let lines: Vec<String> = (0..20).map(|i| format!("+l{i}")).collect();
        let tur =
            json!({"filePath":"/a","structuredPatch":[{"oldStart":1,"newStart":1,"lines":lines}]});
        let i = res(json!("ok"), None, Some(tur));
        assert_eq!(i["diff"]["added"], 20);
        assert_eq!(i["diff"]["lines"].as_array().unwrap().len(), 16);
        assert_eq!(i["diff"]["more"], 4);
    }

    #[test]
    fn write_create_is_created_diff() {
        let tur =
            json!({"type":"create","filePath":"/n.txt","content":"a\nb\nc\n","structuredPatch":[]});
        let i = res(json!("ok"), None, Some(tur));
        let d = &i["diff"];
        assert_eq!(d["created"], true);
        assert_eq!(d["added"], 3);
        assert_eq!(d["removed"], 0);
        assert_eq!(d["lines"].as_array().unwrap().len(), 0);
        assert_eq!(d["more"], 0);
        assert_eq!(d["filePath"], "/n.txt");
    }

    #[test]
    fn non_object_tool_use_result_has_no_diff() {
        assert!(res(json!("ok"), None, Some(json!("a string")))["diff"].is_null());
        assert!(res(json!("ok"), None, Some(json!([1, 2])))["diff"].is_null());
        let empty = json!({"filePath":"/a","structuredPatch":[]});
        assert!(res(json!("ok"), None, Some(empty))["diff"].is_null());
    }

    #[test]
    fn array_text_with_unknown_tag_is_note() {
        let v = json!({"type":"user","message":{"content":[{"type":"text","text":"<system-reminder>x</system-reminder>"}]}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "note");
        assert_eq!(items[0]["tag"], "system-reminder");
    }

    #[test]
    fn array_task_notification_is_task() {
        let v = json!({"type":"user","message":{"content":[{"type":"text","text":TASK}]}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "task");
        assert_eq!(items[0]["taskId"], "b1276wxdl");
    }

    #[test]
    fn human_array_with_tag_stays_bubble() {
        let v = json!({"type":"user","origin":{"kind":"human"},"message":{"content":[{"type":"text","text":"<system-reminder>x</system-reminder>"}]}});
        let items = parse_user(&v);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "bubble");
    }

    #[test]
    fn leading_whitespace_before_command_tag() {
        let v =
            json!({"type":"user","message":{"content":"\n  <command-name>/clear</command-name>"}});
        let i = &parse_user(&v)[0];
        assert_eq!(i["kind"], "command");
        assert_eq!(i["name"], "/clear");
    }

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[1;31mred\u{1b}[0m ok"), "red ok");
        assert_eq!(strip_ansi("plain"), "plain");
    }
}
