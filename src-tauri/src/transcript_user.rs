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
    for (open, tag, stream) in [
        ("<local-command-stdout>", "local-command-stdout", "stdout"),
        ("<bash-stdout>", "bash-stdout", "stdout"),
        ("<local-command-stderr>", "local-command-stderr", "stderr"),
        ("<bash-stderr>", "bash-stderr", "stderr"),
    ] {
        if t.starts_with(open) {
            let body = strip_ansi(&tag_text(t, tag).unwrap_or_default());
            let body = body.trim();
            if body.is_empty() {
                return Some(vec![]);
            }
            return Some(vec![
                json!({ "kind": "command_output", "text": body, "stream": stream }),
            ]);
        }
    }
    None
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
fn parse_blocks(blocks: &[Value], classify: bool) -> Vec<Value> {
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
            _ => {}
        }
    }
    out
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
            (_, Some(blocks)) => parse_blocks(blocks, false),
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
        if text.trim().is_empty() {
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
    // 9. Array content: typed text, images, interrupts; tool results are dropped.
    if let Some(blocks) = content.as_array() {
        return parse_blocks(blocks, true);
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
        "scheduled_task_fire" => vec![json!({ "kind": "auto", "label": content, "text": content })],
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
    fn command_output_stderr_and_empty() {
        let v = json!({"type":"user","message":{"content":"<bash-stderr>boom</bash-stderr>"}});
        assert_eq!(parse_user(&v)[0]["stream"], "stderr");
        let v = json!({"type":"user","message":{"content":"<local-command-stdout></local-command-stdout>"}});
        assert!(parse_user(&v).is_empty());
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

    #[test]
    fn tool_result_blocks_are_dropped() {
        let v =
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}});
        assert!(parse_user(&v).is_empty());
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
