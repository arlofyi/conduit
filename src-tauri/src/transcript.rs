//! Parse Claude transcript JSONL (`<id>.jsonl`) into the bridge's chat items.
//! One line → zero or more items: user/assistant text → "bubble"; tool_use →
//! "event" (mapped to the same kinds the RN app renders); everything else skipped.

use serde_json::{json, Value};

/// Every item `kind` this parser can emit, shared with the mobile client so it can tell a
/// kind it renders from one it must ignore. A test keeps it in step with the parser.
// Read only by the manifest test until the bridge serves it to the mobile client.
#[allow(dead_code)]
pub const ITEM_KINDS_JSON: &str = include_str!("transcript_item_kinds.json");

/// Map a Claude tool name to the RN timeline event kind + verb (mirror of
/// mobile/src/logic/status.ts `eventKindFor` / labels).
fn tool_event(name: &str, input: &Value) -> Value {
    let (kind, label, mono) = match name {
        "Read" => (
            "read",
            "read",
            input.get("file_path").and_then(|v| v.as_str()),
        ),
        "Bash" => ("bash", "ran", input.get("command").and_then(|v| v.as_str())),
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => (
            "edit",
            "edited",
            input.get("file_path").and_then(|v| v.as_str()),
        ),
        "Grep" | "Glob" => (
            "search",
            "searched",
            input.get("pattern").and_then(|v| v.as_str()),
        ),
        "WebFetch" | "WebSearch" => ("web", "browsed", input.get("url").and_then(|v| v.as_str())),
        "Agent" | "Task" => (
            "subagent",
            "subagent",
            input.get("description").and_then(|v| v.as_str()),
        ),
        _ => ("generic", "used a tool", None),
    };
    json!({ "kind": "event", "event": kind, "label": label, "mono": mono })
}

/// `AskUserQuestion` → a `question` item, copied from `input.questions` with every field
/// defaulted so a half-written call still renders.
fn question_item(id: &str, input: &Value) -> Value {
    let str_of = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let questions: Vec<Value> = input
        .get("questions")
        .and_then(|q| q.as_array())
        .map(|qs| {
            qs.iter()
                .map(|q| {
                    let options: Vec<Value> = q
                        .get("options")
                        .and_then(|o| o.as_array())
                        .map(|os| {
                            os.iter()
                                .map(|o| {
                                    json!({
                                        "label": str_of(o, "label"),
                                        "description": str_of(o, "description"),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    json!({
                        "question": str_of(q, "question"),
                        "header": str_of(q, "header"),
                        "multiSelect": q.get("multiSelect").and_then(|b| b.as_bool()).unwrap_or(false),
                        "options": options,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "kind": "question", "toolUseId": id, "questions": questions })
}

/// Parse one transcript line into chat items (possibly empty).
pub fn parse_line(line: &str) -> Vec<Value> {
    let Ok(v): Result<Value, _> = serde_json::from_str(line) else {
        return vec![];
    };
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let content = v.pointer("/message/content");
    let mut out = Vec::new();
    match kind {
        "user" => {
            // Not every user line is the human: see `transcript_user` for the split.
            out.extend(crate::transcript_user::parse_user(&v));
        }
        "assistant" => {
            // SPEC-G, §7.6: real token usage per line, including cache-read vs fresh
            // input -- the honest signal that prompt caching (90% off cache reads) is
            // actually working. `message.usage` is a standard field on Claude API
            // responses; this doesn't disturb the existing bubble/tool_use items below.
            if let Some(usage) = v.pointer("/message/usage") {
                out.push(json!({
                    "kind": "usage",
                    "model": v.pointer("/message/model").and_then(|m| m.as_str()),
                    "inputTokens": usage.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0),
                    "outputTokens": usage.get("output_tokens").and_then(|x| x.as_i64()).unwrap_or(0),
                    "cacheReadTokens": usage.get("cache_read_input_tokens").and_then(|x| x.as_i64()).unwrap_or(0),
                    "cacheCreationTokens": usage.get("cache_creation_input_tokens").and_then(|x| x.as_i64()).unwrap_or(0),
                }));
            }
            if let Some(arr) = content.and_then(|c| c.as_array()) {
                for block in arr {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                if !t.trim().is_empty() {
                                    out.push(
                                        json!({ "kind": "bubble", "role": "assistant", "text": t }),
                                    );
                                }
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            let empty = json!({});
                            let input = block.get("input").unwrap_or(&empty);
                            out.push(match name {
                                "AskUserQuestion" => question_item(
                                    block.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                                    input,
                                ),
                                "ExitPlanMode" => json!({
                                    "kind": "plan",
                                    "markdown": input.get("plan").and_then(|p| p.as_str()).unwrap_or(""),
                                }),
                                _ => tool_event(name, input),
                            });
                        }
                        _ => {}
                    }
                }
            }
        }
        "system" => out.extend(crate::transcript_user::parse_system(&v)),
        _ => {}
    }
    out
}

/// How many transcript items the rich session view asks for by default.
///
/// A conversation view, not an archive: the terminal above it still holds the full
/// scrollback, and rendering ten thousand markdown blocks to show the last twenty is how a
/// chat pane becomes the slowest thing in the app.
pub const VIEW_LIMIT: usize = 400;

/// Tauri command: a session's transcript, parsed into chat items, newest-last.
///
/// Claude only, and that is stated rather than silently returned as empty: `parse_line`
/// reads Claude's JSONL schema, and Command Code writes `.jsonl` too but with a shape
/// nobody has verified. Rendering an unverified schema would produce a confidently wrong
/// conversation, which is worse than an honest "not supported yet".
///
/// Returns an empty vec (never an error) when there is simply nothing yet -- a session that
/// has not spoken, or one whose transcript has not been written. The view treats empty as
/// "nothing to show", so an error here would only turn a normal state into a red banner.
#[tauri::command(async)]
pub fn session_transcript(
    session_id: String,
    limit: Option<usize>,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Vec<Value> {
    if store.session_agent(&session_id) != crate::agent::AgentId::Claude {
        return Vec::new();
    }
    let Some(dir) = crate::pty::session_projects_dir(&store, &session_id) else {
        return Vec::new();
    };
    let conversation = store.claude_conversation_id(&session_id);
    let Some(path) = crate::pty::transcript_path(&conversation, &dir) else {
        return Vec::new();
    };
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let items: Vec<Value> = body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .flat_map(parse_line)
        .collect();
    tail(items, limit.unwrap_or(VIEW_LIMIT))
}

/// The last `limit` items. Split out so the boundary is testable without a Store.
///
/// The TAIL, not the head: a conversation view is read from the bottom, so truncating the
/// end would show an old conversation and hide the part someone opened the panel to read.
fn tail(items: Vec<Value>, limit: usize) -> Vec<Value> {
    if limit == 0 || items.len() <= limit {
        // limit 0 means "no cap", not "show nothing" -- a caller asking for zero items has
        // almost certainly forgotten to pass one.
        return items;
    }
    items[items.len() - limit..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tail_keeps_the_end_of_the_conversation() {
        let items: Vec<Value> = (0..10).map(|i| json!({ "n": i })).collect();
        let last3 = tail(items.clone(), 3);
        assert_eq!(last3.len(), 3);
        // The newest items, not the oldest -- truncating the other end would show an old
        // conversation and hide what the panel was opened to read.
        assert_eq!(last3[0]["n"], 7);
        assert_eq!(last3[2]["n"], 9);
    }

    #[test]
    fn tail_is_a_no_op_when_it_has_nothing_to_cut() {
        let items: Vec<Value> = (0..3).map(|i| json!({ "n": i })).collect();
        assert_eq!(tail(items.clone(), 3).len(), 3, "exactly at the limit");
        assert_eq!(tail(items.clone(), 99).len(), 3, "under the limit");
        assert_eq!(tail(vec![], 5).len(), 0, "nothing to show yet");
        // 0 means "no cap" rather than "show nothing": a caller passing zero has almost
        // certainly forgotten to supply one, and an empty pane hides that mistake.
        assert_eq!(tail(items, 0).len(), 3);
    }

    #[test]
    fn parses_user_text_bubble() {
        let items = parse_line(
            &json!({"type":"user","message":{"role":"user","content":"add rate limiting"}})
                .to_string(),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "bubble");
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[0]["text"], "add rate limiting");
    }

    #[test]
    fn parses_assistant_text_and_tool_use() {
        let line = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"On it."},
            {"type":"tool_use","name":"Bash","input":{"command":"npm test"}}
        ]}})
        .to_string();
        let items = parse_line(&line);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], "bubble");
        assert_eq!(items[0]["role"], "assistant");
        assert_eq!(items[0]["text"], "On it.");
        assert_eq!(items[1]["kind"], "event");
        assert_eq!(items[1]["event"], "bash");
        assert_eq!(items[1]["mono"], "npm test");
    }

    #[test]
    fn parse_line_captures_usage_kind_on_assistant_lines() {
        let line = json!({"type":"assistant","message":{
            "model": "claude-opus-4-8",
            "usage": {
                "input_tokens": 120,
                "output_tokens": 45,
                "cache_read_input_tokens": 900,
                "cache_creation_input_tokens": 30
            },
            "content":[{"type":"text","text":"On it."}]
        }})
        .to_string();
        let items = parse_line(&line);
        let usage = items
            .iter()
            .find(|i| i["kind"] == "usage")
            .expect("usage item present");
        assert_eq!(usage["model"], "claude-opus-4-8");
        assert_eq!(usage["inputTokens"], 120);
        assert_eq!(usage["outputTokens"], 45);
        assert_eq!(usage["cacheReadTokens"], 900);
        assert_eq!(usage["cacheCreationTokens"], 30);
        // The existing bubble item for the same line is unaffected (regression guard).
        let bubble = items
            .iter()
            .find(|i| i["kind"] == "bubble")
            .expect("bubble item still present");
        assert_eq!(bubble["text"], "On it.");
    }

    #[test]
    fn parse_line_has_no_usage_item_when_message_usage_is_absent() {
        let line = json!({"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}})
            .to_string();
        let items = parse_line(&line);
        assert!(!items.iter().any(|i| i["kind"] == "usage"));
    }

    #[test]
    fn skips_tool_result_and_meta_lines() {
        assert!(parse_line(
            &json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}})
                .to_string()
        )
        .is_empty());
        assert!(parse_line("not json").is_empty());
        assert!(parse_line(&json!({"type":"summary"}).to_string()).is_empty());
    }

    #[test]
    fn compact_boundary_is_divider() {
        let l = json!({"type":"system","subtype":"compact_boundary","content":"Conversation compacted","level":"info"}).to_string();
        let i = &parse_line(&l)[0];
        assert_eq!(i["kind"], "divider");
        assert_eq!(i["label"], "Conversation compacted");
        assert_eq!(i["tone"], "info");
    }

    #[test]
    fn refusal_fallback_is_warning_divider() {
        let l = json!({"type":"system","subtype":"model_refusal_fallback",
            "content":"Opus 5.5's safeguards flagged this session. Continuing on Sonnet.\n\nDetails: `[cyber]`"})
        .to_string();
        let i = &parse_line(&l)[0];
        assert_eq!(i["kind"], "divider");
        assert_eq!(i["tone"], "warning");
        let label = i["label"].as_str().unwrap();
        assert!(label.starts_with("Opus 5.5's safeguards"));
        assert!(!label.contains("Details"));
    }

    #[test]
    fn informational_is_info_divider() {
        let l = json!({"type":"system","subtype":"informational","content":"Switched model"})
            .to_string();
        let i = &parse_line(&l)[0];
        assert_eq!(i["kind"], "divider");
        assert_eq!(i["label"], "Switched model");
        assert_eq!(i["tone"], "info");
    }

    #[test]
    fn scheduled_fire_is_dropped() {
        // The isMeta prompt that follows the fire is already an `auto` note; two notes per
        // fire would say the same thing twice.
        let l = json!({"type":"system","subtype":"scheduled_task_fire",
            "content":"Running scheduled task (Sep 13 3:00am)"})
        .to_string();
        assert!(parse_line(&l).is_empty());
    }

    #[test]
    fn noise_system_lines_are_dropped() {
        for st in ["stop_hook_summary", "turn_duration", "away_summary"] {
            let l = json!({"type":"system","subtype":st,"content":"x"}).to_string();
            assert!(parse_line(&l).is_empty(), "{st}");
        }
    }

    fn tool_line(name: &str, input: Value) -> String {
        json!({"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"toolu_01Bw","name":name,"input":input}]}})
        .to_string()
    }

    #[test]
    fn ask_user_question_becomes_question() {
        let l = tool_line(
            "AskUserQuestion",
            json!({"questions":[{"question":"What do you see in the menu bar right now?",
                "header":"Symptom","multiSelect":false,
                "options":[{"label":"No icon at all","description":"The ring is gone"}]}]}),
        );
        let i = &parse_line(&l)[0];
        assert_eq!(i["kind"], "question");
        assert_eq!(i["toolUseId"], "toolu_01Bw");
        assert_eq!(i["questions"][0]["header"], "Symptom");
        assert_eq!(i["questions"][0]["multiSelect"], false);
        assert_eq!(i["questions"][0]["options"][0]["label"], "No icon at all");
        assert_eq!(
            i["questions"][0]["options"][0]["description"],
            "The ring is gone"
        );
    }

    #[test]
    fn ask_user_question_defaults_missing_fields() {
        let i = &parse_line(&tool_line("AskUserQuestion", json!({"questions":[{}]})))[0];
        let q = &i["questions"][0];
        assert_eq!(q["question"], "");
        assert_eq!(q["header"], "");
        assert_eq!(q["multiSelect"], false);
        assert_eq!(q["options"], json!([]));
    }

    #[test]
    fn exit_plan_mode_becomes_plan() {
        let i = &parse_line(&tool_line("ExitPlanMode", json!({"plan":"# Plan\n- a"})))[0];
        assert_eq!(i["kind"], "plan");
        assert_eq!(i["markdown"], "# Plan\n- a");
        let i = &parse_line(&tool_line("ExitPlanMode", json!({})))[0];
        assert_eq!(i["markdown"], "");
    }

    #[test]
    fn agent_tool_is_subagent_event() {
        for name in ["Agent", "Task"] {
            let i = &parse_line(&tool_line(name, json!({"description":"Builder check"})))[0];
            assert_eq!(i["kind"], "event");
            assert_eq!(i["event"], "subagent");
            assert_eq!(i["label"], "subagent");
            assert_eq!(i["mono"], "Builder check");
        }
    }

    #[test]
    fn thinking_blocks_are_dropped() {
        let l =
            json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"}]}})
                .to_string();
        assert!(parse_line(&l).is_empty());
    }

    #[test]
    fn every_emitted_kind_is_in_the_manifest() {
        let kinds: Vec<String> = serde_json::from_str(ITEM_KINDS_JSON).unwrap();
        let fixtures: Vec<String> = vec![
            json!({"type":"user","message":{"content":"add rate limiting"}}),
            json!({"type":"assistant","message":{"usage":{"input_tokens":1},"content":[]}}),
            json!({"type":"user","message":{"content":"<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>"}}),
            json!({"type":"user","isMeta":true,"origin":{"kind":"peer","name":"general-purpose","body":"hi"},"message":{"content":"hi"}}),
            json!({"type":"user","isMeta":true,"message":{"content":"CONTINUITY RELAY TICK"}}),
            json!({"type":"user","message":{"content":"<command-name>/compact</command-name>"}}),
            json!({"type":"user","message":{"content":"<local-command-stdout>ok</local-command-stdout>"}}),
            json!({"type":"user","isMeta":true,"message":{"content":[{"type":"text","text":"Base directory for this skill: /x/skills/brainstorming\n\n# B"}]}}),
            json!({"type":"user","origin":{"kind":"human"},"message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}}),
            json!({"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}),
            json!({"type":"user","message":{"content":"<weird-tag>x</weird-tag>"}}),
        ]
        .into_iter()
        .map(|v| v.to_string())
        .chain([
            tool_line("Bash", json!({"command":"ls"})),
            tool_line("AskUserQuestion", json!({"questions":[]})),
            tool_line("ExitPlanMode", json!({"plan":"p"})),
        ])
        .collect();
        let mut seen = std::collections::BTreeSet::new();
        for f in &fixtures {
            for item in parse_line(f) {
                let k = item["kind"].as_str().unwrap().to_string();
                assert!(kinds.contains(&k), "kind {k} missing from manifest");
                seen.insert(k);
            }
        }
        for k in &kinds {
            assert!(seen.contains(k), "manifest kind {k} never produced");
        }
    }
}
