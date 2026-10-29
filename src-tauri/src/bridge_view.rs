//! Pure builders for what the mobile bridge tells a phone about the project tree and the
//! attached session. Kept free of `AppHandle` so every shape is unit-tested.
//!
//! The `projects` frame is a WHITELIST, never a dump of `Project`: those structs carry
//! `seedMemory`, `accountId`, filesystem paths, layouts and routes, none of which a phone
//! needs and some of which must not leave the Mac.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::{json, Value};

use crate::asks::AskView;
use crate::context_window::ContextUsage;
use crate::fleet::FleetStatus;
use crate::store::{Profile, Project, Session};

/// Longest `needs.text` the phone is sent.
const NEEDS_TEXT_MAX: usize = 120;

fn clip(s: &str) -> String {
    s.chars().take(NEEDS_TEXT_MAX).collect()
}

/// The first question of a pending ask, clipped. `questions` is Claude's
/// `AskUserQuestion` array of `{question, ...}`.
fn first_question(ask: &AskView) -> Option<String> {
    ask.questions
        .as_array()?
        .first()?
        .get("question")?
        .as_str()
        .map(clip)
}

/// Longest `lastMessage.text` the phone is sent.
const LAST_TEXT_MAX: usize = 160;
/// How much of a transcript's end is read to find its last bubble.
const TAIL_BYTES: u64 = 256 * 1024;

/// A bubble's text as one readable line: markdown marks dropped, links reduced to their
/// text, whitespace collapsed, a leading `★ Insight` rule block removed. Clipped to
/// [`LAST_TEXT_MAX`] characters.
pub fn plain_text(md: &str) -> String {
    let is_rule = |l: &str| {
        let t = l.trim();
        !t.is_empty() && t.chars().all(|c| c == '─' || c == '`' || c == '-')
    };
    let mut lines: Vec<&str> = md.lines().collect();
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    if lines.first().is_some_and(|l| l.contains("★ Insight")) {
        lines.remove(0);
        while lines.first().is_some_and(|l| is_rule(l)) {
            lines.remove(0);
        }
    }
    let mut out = String::new();
    for line in lines {
        if is_rule(line) {
            continue;
        }
        out.push_str(line.trim_start().trim_start_matches('#').trim_start());
        out.push(' ');
    }
    // Links `[text](url)` (and images `![alt](url)`) -> their text.
    let mut flat = String::with_capacity(out.len());
    let chars: Vec<char> = out.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(close) = chars[i..].iter().position(|&c| c == ']') {
                let c = i + close;
                if chars.get(c + 1) == Some(&'(') {
                    if let Some(p) = chars[c..].iter().position(|&c| c == ')') {
                        flat.extend(&chars[i + 1..c]);
                        i = c + p + 1;
                        continue;
                    }
                }
            }
        }
        flat.push(chars[i]);
        i += 1;
    }
    let flat = flat.replace("**", "").replace("__", "").replace('`', "");
    let collapsed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(LAST_TEXT_MAX).collect()
}

/// The `lastMessage` value for the last bubble in `body` (a transcript tail), or null.
pub fn last_message_from_text(body: &str) -> Value {
    for line in body.lines().rev() {
        if line.trim().is_empty() {
            continue;
        }
        for item in crate::transcript::parse_line(line).into_iter().rev() {
            if item.get("kind").and_then(|k| k.as_str()) != Some("bubble") {
                continue;
            }
            let text = plain_text(item.get("text").and_then(|t| t.as_str()).unwrap_or(""));
            if text.is_empty() {
                continue;
            }
            return json!({
                "role": item.get("role").and_then(|r| r.as_str()).unwrap_or("assistant"),
                "text": text,
                "at": item.get("at").cloned().unwrap_or(Value::Null),
            });
        }
    }
    Value::Null
}

/// Read the last [`TAIL_BYTES`] of a transcript and extract its last message. Any I/O
/// problem is null: a preview must never fail a `list`.
pub fn read_last_message(path: &Path) -> Value {
    let read = || -> std::io::Result<String> {
        let mut f = std::fs::File::open(path)?;
        let len = f.metadata()?.len();
        let start = len.saturating_sub(TAIL_BYTES);
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        f.take(TAIL_BYTES).read_to_end(&mut buf)?;
        let mut text = String::from_utf8_lossy(&buf).into_owned();
        if start > 0 {
            // Began mid-line: drop the partial first line.
            text = text
                .split_once('\n')
                .map(|x| x.1.to_string())
                .unwrap_or_default();
        }
        Ok(text)
    };
    read()
        .map(|t| last_message_from_text(&t))
        .unwrap_or(Value::Null)
}

/// Last-message previews keyed by `(path, len, mtime)`: a `list` with nothing new on disk
/// does no transcript reads, only a `stat`.
#[derive(Default)]
pub struct LastMessageCache {
    inner: Mutex<HashMap<PathBuf, CacheEntry>>,
}

/// `(len, mtime, preview)` of a transcript when it was last read.
type CacheEntry = (u64, Option<SystemTime>, Value);

impl LastMessageCache {
    /// The cached value if `(len, mtime)` still match, else `read()` and remember it.
    pub fn get_or_read(
        &self,
        path: &Path,
        len: u64,
        mtime: Option<SystemTime>,
        read: impl FnOnce() -> Value,
    ) -> Value {
        {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((l, m, v)) = g.get(path) {
                if *l == len && *m == mtime {
                    return v.clone();
                }
            }
        }
        let v = read();
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path.to_path_buf(), (len, mtime, v.clone()));
        v
    }

    /// Cached preview for a transcript file; null when it cannot be statted.
    pub fn for_path(&self, path: &Path) -> Value {
        let Ok(md) = std::fs::metadata(path) else {
            return Value::Null;
        };
        self.get_or_read(path, md.len(), md.modified().ok(), || {
            read_last_message(path)
        })
    }
}

/// The `projects` frame. `last_message` resolves a (non-silo, Claude) session's preview;
/// it is never called for a silo'd or non-Claude session.
pub fn projects_view(
    projects: &[Project],
    profiles: &[Profile],
    active_profile: Option<&str>,
    fleet: &HashMap<String, FleetStatus>,
    running: &HashSet<String>,
    asks: &[AskView],
    last_message: &dyn Fn(&Session) -> Value,
) -> Value {
    let mut profile_list = vec![json!({ "id": Value::Null, "name": "Default" })];
    profile_list.extend(
        profiles
            .iter()
            .map(|p| json!({ "id": p.id, "name": p.name })),
    );
    let projects: Vec<Value> = projects
        .iter()
        .map(|p| {
            let sessions: Vec<Value> = p
                .sessions
                .iter()
                .map(|s| {
                    let silo = s.silo || s.local_only;
                    let live = fleet.get(&s.id);
                    let status = live.map_or("idle", |f| f.status.as_str());
                    let ask = asks.iter().find(|a| a.session == s.id);
                    // A silo'd session is listed but nothing it is doing leaves the Mac.
                    let needs = if let Some(a) = ask {
                        let text = if silo { None } else { first_question(a) };
                        json!({ "kind": "ask", "text": text })
                    } else if status == "needsInput" {
                        json!({ "kind": "input", "text": Value::Null })
                    } else {
                        Value::Null
                    };
                    let activity = if silo {
                        None
                    } else {
                        live.and_then(|f| f.activity.clone())
                    };
                    let last = if silo || s.agent != crate::agent::AgentId::Claude {
                        Value::Null
                    } else {
                        last_message(s)
                    };
                    let updated_at = live.map(|f| f.updated_at).filter(|t| *t > 0);
                    json!({
                        "id": s.id,
                        "name": s.name,
                        "agent": s.agent,
                        "branch": s.branch,
                        "model": s.model,
                        "stopped": s.stopped,
                        "running": running.contains(&s.id),
                        "silo": silo,
                        "status": status,
                        "activity": activity,
                        "updatedAt": updated_at,
                        "needs": needs,
                        "lastMessage": last,
                    })
                })
                .collect();
            json!({
                "id": p.id,
                "name": p.name,
                "profileId": p.profile_id,
                "color": p.color,
                "sessions": sessions,
            })
        })
        .collect();
    json!({
        "type": "projects",
        "profiles": profile_list,
        "activeProfileId": active_profile,
        "projects": projects,
    })
}

/// The `context` frame for the attached session.
pub fn context_frame(session_id: &str, u: &ContextUsage) -> Value {
    json!({
        "type": "context",
        "sessionId": session_id,
        "used": u.used,
        "window": u.window,
        "fraction": u.fraction,
        "model": u.model,
    })
}

/// Install a new attachment and return the `(session, subscription id)` it displaced, which
/// the caller must unsubscribe. Dropping the old tuple without this leaked a PTY subscriber
/// (and its channel) for every re-attach on one socket.
pub fn replace_attached<R>(
    slot: &mut Option<(String, u64, R)>,
    new: (String, u64, R),
) -> Option<(String, u64)> {
    slot.replace(new).map(|(s, id, _)| (s, id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Session;

    fn sess(id: &str) -> Session {
        Session {
            id: id.into(),
            name: format!("n-{id}"),
            ..Default::default()
        }
    }

    fn project(id: &str, sessions: Vec<Session>) -> Project {
        serde_json::from_value(json!({
            "id": id, "name": "Conduit", "path": "/secret/repo",
            "sessions": serde_json::to_value(sessions).unwrap(),
        }))
        .unwrap()
    }

    fn keys(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    fn view(p: &[Project], fleet: &HashMap<String, FleetStatus>, asks: &[AskView]) -> Value {
        projects_view(p, &[], None, fleet, &HashSet::new(), asks, &|_| Value::Null)
    }

    #[test]
    fn projects_view_whitelists_fields() {
        let mut s = sess("s1");
        s.seed_memory = Some("TOP SECRET".into());
        s.account_id = Some("acct".into());
        s.worktree_path = Some("/secret/wt".into());
        let v = view(&[project("p1", vec![s])], &HashMap::new(), &[]);
        assert_eq!(
            keys(&v["projects"][0]),
            ["color", "id", "name", "profileId", "sessions"]
        );
        assert_eq!(
            keys(&v["projects"][0]["sessions"][0]),
            [
                "activity",
                "agent",
                "branch",
                "id",
                "lastMessage",
                "model",
                "name",
                "needs",
                "running",
                "silo",
                "status",
                "stopped",
                "updatedAt"
            ]
        );
        let text = v.to_string();
        for leak in ["TOP SECRET", "acct", "/secret"] {
            assert!(!text.contains(leak), "{leak} leaked");
        }
    }

    #[test]
    fn last_message_plain_text_and_clip() {
        let md = "`★ Insight ─────`\n**Bold** and __more__ with `code` and [a link](http://x.y)\n\n# Head\nline";
        assert_eq!(
            plain_text(md),
            "Bold and more with code and a link Head line"
        );
        assert_eq!(plain_text(&"a".repeat(500)).chars().count(), 160);
        let body = [
            json!({"type":"user","timestamp":"2026-10-29T20:00:00Z","message":{"content":"first"}}),
            json!({"type":"assistant","timestamp":"2026-10-29T20:01:00Z","message":{"content":[
                {"type":"text","text":"**done** it"},
                {"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}),
        ]
        .map(|v| v.to_string())
        .join("\n");
        assert_eq!(
            last_message_from_text(&body),
            json!({"role":"assistant","text":"done it","at":"2026-10-29T20:01:00Z"})
        );
        assert!(last_message_from_text("not json\n").is_null());
    }

    #[test]
    fn last_message_cache_reads_once_until_file_changes() {
        use std::cell::Cell;
        use std::time::Duration;
        let cache = LastMessageCache::default();
        let calls = Cell::new(0);
        let p = Path::new("/t/a.jsonl");
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
        let t1 = t0 + Duration::from_secs(1);
        let read = || {
            calls.set(calls.get() + 1);
            json!({ "n": calls.get() })
        };
        assert_eq!(cache.get_or_read(p, 5, Some(t0), read)["n"], 1);
        assert_eq!(cache.get_or_read(p, 5, Some(t0), read)["n"], 1);
        assert_eq!(calls.get(), 1);
        assert_eq!(cache.get_or_read(p, 6, Some(t0), read)["n"], 2);
        assert_eq!(cache.get_or_read(p, 6, Some(t1), read)["n"], 3);
        assert_eq!(cache.get_or_read(p, 6, Some(t1), read)["n"], 3);
    }

    #[test]
    fn silo_last_message_null_without_read() {
        let mut silo = sess("a");
        silo.silo = true;
        let mut local = sess("b");
        local.local_only = true;
        let mut other = sess("c");
        other.agent = crate::agent::AgentId::Hermes;
        let v = projects_view(
            &[project("p1", vec![silo, local, other])],
            &[],
            None,
            &HashMap::new(),
            &HashSet::new(),
            &[],
            &|s| panic!("read attempted for {}", s.id),
        );
        for i in 0..3 {
            assert!(v["projects"][0]["sessions"][i]["lastMessage"].is_null());
        }
    }

    #[test]
    fn projects_view_carries_last_message() {
        let v = projects_view(
            &[project("p1", vec![sess("a")])],
            &[],
            None,
            &HashMap::new(),
            &HashSet::new(),
            &[],
            &|s| json!({ "role": "user", "text": s.id, "at": null }),
        );
        assert_eq!(
            v["projects"][0]["sessions"][0]["lastMessage"],
            json!({ "role": "user", "text": "a", "at": null })
        );
    }

    #[test]
    fn projects_view_default_profile_first() {
        let profiles = vec![Profile {
            id: "w".into(),
            name: "Work".into(),
        }];
        let v = projects_view(
            &[],
            &profiles,
            Some("w"),
            &HashMap::new(),
            &HashSet::new(),
            &[],
            &|_| Value::Null,
        );
        assert_eq!(v["type"], "projects");
        assert_eq!(v["profiles"][0], json!({ "id": null, "name": "Default" }));
        assert_eq!(v["profiles"][1], json!({ "id": "w", "name": "Work" }));
        assert_eq!(v["activeProfileId"], "w");
        let none = projects_view(
            &[],
            &[],
            None,
            &HashMap::new(),
            &HashSet::new(),
            &[],
            &|_| Value::Null,
        );
        assert!(none["activeProfileId"].is_null());
    }

    #[test]
    fn status_and_needs_from_fleet_and_asks() {
        let p = project("p1", vec![sess("a"), sess("b"), sess("c"), sess("d")]);
        let mut fleet = HashMap::new();
        let st = |status: &str, at: u64| FleetStatus {
            status: status.into(),
            activity: Some("Editing".into()),
            updated_at: at,
            ..Default::default()
        };
        fleet.insert("a".to_string(), st("needsInput", 1234));
        fleet.insert("b".to_string(), st("needsInput", 0));
        fleet.insert("c".to_string(), st("running", 99));
        let long = "x".repeat(300);
        let asks = vec![AskView {
            id: "k".into(),
            session: "b".into(),
            tool_use_id: "t".into(),
            questions: json!([{ "question": long }, { "question": "second" }]),
            created_ms: 1,
        }];
        let v = view(&[p], &fleet, &asks);
        let s = &v["projects"][0]["sessions"];
        assert_eq!(s[0]["status"], "needsInput");
        assert_eq!(s[0]["updatedAt"], 1234);
        assert_eq!(s[0]["needs"], json!({ "kind": "input", "text": null }));
        assert_eq!(s[1]["needs"]["kind"], "ask");
        assert_eq!(s[1]["needs"]["text"].as_str().unwrap().chars().count(), 120);
        assert!(s[1]["updatedAt"].is_null());
        assert_eq!(s[2]["status"], "running");
        assert!(s[2]["needs"].is_null());
        assert_eq!(s[2]["activity"], "Editing");
        assert_eq!(s[3]["status"], "idle");
        assert!(s[3]["activity"].is_null() && s[3]["updatedAt"].is_null());
    }

    #[test]
    fn silo_session_has_no_preview_fields() {
        let mut a = sess("a");
        a.silo = true;
        let mut b = sess("b");
        b.local_only = true;
        let mut fleet = HashMap::new();
        for id in ["a", "b"] {
            fleet.insert(
                id.to_string(),
                FleetStatus {
                    status: "running".into(),
                    activity: Some("Reading payroll.csv".into()),
                    updated_at: 5,
                    ..Default::default()
                },
            );
        }
        let asks = vec![AskView {
            id: "k".into(),
            session: "a".into(),
            tool_use_id: "t".into(),
            questions: json!([{ "question": "Delete payroll?" }]),
            created_ms: 1,
        }];
        let v = view(&[project("p", vec![a, b])], &fleet, &asks);
        for i in 0..2 {
            assert_eq!(v["projects"][0]["sessions"][i]["silo"], true);
            assert!(v["projects"][0]["sessions"][i]["activity"].is_null());
        }
        assert!(v["projects"][0]["sessions"][0]["needs"]["text"].is_null());
        assert!(!v.to_string().contains("payroll"));
    }

    #[test]
    fn context_frame_shape() {
        let u = ContextUsage {
            used: 1000,
            window: 200000,
            fraction: 0.005,
            model: Some("claude-opus".into()),
            source: "claude".into(),
            observed_at: 1,
        };
        let f = context_frame("s1", &u);
        assert_eq!(
            keys(&f),
            ["fraction", "model", "sessionId", "type", "used", "window"]
        );
        assert_eq!(f["type"], "context");
        assert_eq!(f["sessionId"], "s1");
        assert_eq!(f["window"], 200000);
    }

    #[test]
    fn reattach_returns_previous_subscription() {
        let mut slot: Option<(String, u64, ())> = None;
        assert_eq!(replace_attached(&mut slot, ("a".into(), 1, ())), None);
        assert_eq!(
            replace_attached(&mut slot, ("b".into(), 2, ())),
            Some(("a".to_string(), 1))
        );
        assert_eq!(slot.as_ref().map(|s| s.1), Some(2));
    }
}
