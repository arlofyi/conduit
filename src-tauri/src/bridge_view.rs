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
/// Characters of a bubble considered when building its preview.
const PLAIN_INPUT_MAX: usize = 2048;
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
    // The preview shows 160 chars; anything past a couple of KB can never reach it, and
    // bounding the input bounds every pass below.
    let md: String = md.chars().take(PLAIN_INPUT_MAX).collect();
    let lines: Vec<&str> = md.lines().collect();
    let mut at = 0;
    while lines.get(at).is_some_and(|l| l.trim().is_empty()) {
        at += 1;
    }
    if lines.get(at).is_some_and(|l| l.contains("★ Insight")) {
        at += 1;
        while lines.get(at).is_some_and(|l| is_rule(l)) {
            at += 1;
        }
    }
    let mut out = String::new();
    for line in &lines[at..] {
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
/// problem is null: a preview must never fail a `list`. A transcript whose last line is
/// longer than the window has no complete line in it (the cut-off first line is dropped),
/// so it also yields null: a missing preview beats a half-parsed one.
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
    /// Paths asked for since the last [`sweep`](Self::sweep).
    seen: Mutex<HashSet<PathBuf>>,
    /// Resolved transcript paths by `(session id, conversation id)`.
    paths: Mutex<HashMap<(String, String), PathBuf>>,
    /// Keys of `paths` asked for since the last sweep.
    seen_paths: Mutex<HashSet<(String, String)>>,
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

    /// End of a `list` pass: forget entries whose path was not asked for during it (a
    /// deleted session, a conversation that moved on), then start a fresh pass.
    pub fn sweep(&self) {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|p, _| seen.contains(p));
        seen.clear();
        let mut seen_paths = self.seen_paths.lock().unwrap_or_else(|e| e.into_inner());
        self.paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|k, _| seen_paths.contains(k));
        seen_paths.clear();
    }

    /// The transcript path for `(session, conversation)`, resolved once and then remembered:
    /// `pty::transcript_path` lists the whole projects directory, which a 10 s `list` poll
    /// would otherwise repeat for every session. A cached path that no longer exists is
    /// resolved again; a miss is not cached (the transcript may simply not exist yet).
    pub fn path_for(
        &self,
        session_id: &str,
        conversation: &str,
        resolve: impl FnOnce() -> Option<PathBuf>,
    ) -> Option<PathBuf> {
        let key = (session_id.to_string(), conversation.to_string());
        self.seen_paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.clone());
        let cached = self
            .paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned();
        if let Some(p) = cached.filter(|p| p.exists()) {
            return Some(p);
        }
        let found = resolve();
        let mut paths = self.paths.lock().unwrap_or_else(|e| e.into_inner());
        match &found {
            Some(p) => {
                paths.insert(key, p.clone());
            }
            None => {
                paths.remove(&key);
            }
        }
        found
    }

    /// Cached preview for a transcript file; null when it cannot be statted.
    pub fn for_path(&self, path: &Path) -> Value {
        self.seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path.to_path_buf());
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

/// Is this session private (silo'd or local-only)? A private session is listed on the phone
/// but nothing about it may be read or driven from there: the bridge refuses every
/// session-scoped request for it, from any peer, loopback included. An unknown id is not
/// private (the request then fails on its own as "no such session").
pub fn session_is_private(projects: &[Project], session_id: &str) -> bool {
    projects
        .iter()
        .flat_map(|p| p.sessions.iter())
        .find(|s| s.id == session_id)
        .is_some_and(|s| s.silo || s.local_only)
}

/// The one reply to a refused private-session request. Tagged with the session it is
/// about, so a phone that has already left that chat can ignore a late refusal.
pub fn private_session_error(session_id: &str) -> Value {
    json!({ "type": "error", "message": "private session", "sessionId": session_id })
}

/// One pending item pushed to phones: its id (what a connection diffs on) and the wire
/// object (`AskPush`; Task 3 adds `PermissionPush`, told apart by `kind`).
#[derive(Clone, Debug, PartialEq)]
pub struct PushItem {
    pub id: String,
    pub item: Value,
}

/// An ask as a phone sees it. A private (silo / local-only) session's question carries
/// only that it EXISTS -- never its text or options.
pub fn ask_push(view: &AskView, private: bool) -> Value {
    if private {
        return json!({ "kind": "ask", "id": view.id, "sessionId": view.session, "private": true });
    }
    json!({
        "kind": "ask",
        "id": view.id,
        "sessionId": view.session,
        "toolUseId": view.tool_use_id,
        "questions": view.questions,
        "createdMs": view.created_ms,
    })
}

/// The pending asks as push items, oldest first, each classified private or not.
pub fn ask_push_items(views: &[AskView], is_private: impl Fn(&str) -> bool) -> Vec<PushItem> {
    views
        .iter()
        .map(|v| PushItem {
            id: v.id.clone(),
            item: ask_push(v, is_private(&v.session)),
        })
        .collect()
}

/// The full list, sent once right after auth (and on a loopback connect).
pub fn pending_frame(items: &[PushItem]) -> Value {
    let of = |kind: &str| -> Vec<Value> {
        items
            .iter()
            .filter(|i| i.item.get("kind").and_then(Value::as_str) == Some(kind))
            .map(|i| i.item.clone())
            .collect()
    };
    json!({ "type": "pending", "asks": of("ask"), "permissions": of("permission") })
}

pub fn pending_added_frame(item: &PushItem) -> Value {
    json!({ "type": "pendingAdded", "item": item.item })
}

/// An item left the pending list; `by` names who resolved it (`asks::By`, lowercase).
pub fn resolved_frame(id: &str, by: &str) -> Value {
    json!({ "type": "resolved", "id": id, "by": by })
}

/// The reply to a phone's `answer`: `ok: false` = already answered elsewhere, refused
/// (private session) or invalid -- nothing was sent to the agent.
pub fn answer_result_frame(ask_id: &str, ok: bool) -> Value {
    json!({ "type": "answerResult", "askId": ask_id, "ok": ok })
}

/// The frames one connection sends for the pending list now, and the id set it has then
/// sent. `prev` None = nothing pushed yet: the whole list as one `pending`. Otherwise
/// `pendingAdded` for each new item, then `resolved` for each one gone, `by` read from the
/// resolution ring (`Asks::recent_resolutions`, oldest first, so its LAST entry for an id
/// wins); an id that fell out of the ring reads `cancelled`.
pub fn push_frames(
    prev: Option<&HashSet<String>>,
    items: &[PushItem],
    recent: &[(String, crate::asks::By)],
) -> (Vec<Value>, HashSet<String>) {
    let ids: HashSet<String> = items.iter().map(|i| i.id.clone()).collect();
    let Some(prev) = prev else {
        return (vec![pending_frame(items)], ids);
    };
    let (added, gone) = diff_pending(prev, items);
    let mut frames: Vec<Value> = added.iter().map(pending_added_frame).collect();
    for id in &gone {
        let by = recent
            .iter()
            .rev()
            .find(|(i, _)| i == id)
            .map_or(crate::asks::By::Cancelled, |(_, by)| *by);
        frames.push(resolved_frame(id, by.as_str()));
    }
    (frames, ids)
}

/// What changed since this connection last pushed: items it has not sent yet (in `now`'s
/// order), and ids it sent that are no longer pending. Each connection keeps its own
/// `prev`, so two phones each learn of the same resolution.
pub fn diff_pending(prev: &HashSet<String>, now: &[PushItem]) -> (Vec<PushItem>, Vec<String>) {
    let added: Vec<PushItem> = now
        .iter()
        .filter(|i| !prev.contains(&i.id))
        .cloned()
        .collect();
    let still: HashSet<&str> = now.iter().map(|i| i.id.as_str()).collect();
    let mut gone: Vec<String> = prev
        .iter()
        .filter(|id| !still.contains(id.as_str()))
        .cloned()
        .collect();
    gone.sort();
    (added, gone)
}

/// A transcript's non-blank lines.
pub fn read_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|s| {
            s.lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// `chat` frames for every line appended to `path` since `cursor`, advancing it. Used by
/// the regular tail AND just before the tail switches transcript after a `/clear`, so
/// lines the old conversation wrote since the last pass are not lost.
pub fn tail_frames(path: &Path, cursor: &mut usize, session_id: &str) -> Vec<Value> {
    let lines = read_lines(path);
    if lines.len() <= *cursor {
        return Vec::new();
    }
    let frames = lines[*cursor..]
        .iter()
        .flat_map(|l| crate::transcript::parse_line(l))
        .map(|item| chat_frame(session_id, &item))
        .collect();
    *cursor = lines.len();
    frames
}

/// A `chat` frame: one transcript item of `session_id`. The id lets the phone drop a frame
/// that belongs to a chat it has already left.
pub fn chat_frame(session_id: &str, item: &Value) -> Value {
    json!({ "type": "chat", "sessionId": session_id, "item": item })
}

/// Should the tail re-resolve the attached session's transcript on this tick? Only when it
/// has none yet (attached before the transcript existed -- a chat opened the moment it was
/// spawned) or its conversation id moved (a `/clear`). Anything else is a wasted directory scan.
pub fn needs_resolve(
    tailing_conversation: Option<&str>,
    have_path: bool,
    conversation: &str,
) -> bool {
    !have_path || tailing_conversation != Some(conversation)
}

/// Switch the tail to `resolved`? Only for a path that was found and differs from the one
/// being tailed; a failed lookup keeps the current tail rather than going dark.
pub fn should_switch_tail(current: Option<&Path>, resolved: Option<&Path>) -> bool {
    matches!(resolved, Some(r) if current != Some(r))
}

/// Drop the current attachment (an `attach` that failed or was refused): return the
/// `(session, subscription id)` the caller must unsubscribe, and clear everything that would
/// otherwise keep streaming the OLD session into the chat the phone just opened.
pub fn clear_attachment<R, T>(
    slot: &mut Option<(String, u64, R)>,
    transcript: &mut Option<T>,
    context_path: &mut Option<PathBuf>,
) -> Option<(String, u64)> {
    *transcript = None;
    *context_path = None;
    slot.take().map(|(s, id, _)| (s, id))
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

    fn tmp_file(tag: &str, bytes: &[u8]) -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("conduit-tail-{tag}-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn assistant(text: &str) -> String {
        json!({"type":"assistant","timestamp":"2026-10-29T20:01:00Z",
            "message":{"content":[{"type":"text","text":text}]}})
        .to_string()
    }

    #[test]
    fn tail_reader_survives_a_line_straddling_the_cut() {
        // A big first line crosses the 256 KiB boundary; the small last line is intact.
        let mut body = assistant(&"x".repeat(300 * 1024));
        body.push('\n');
        body.push_str(&assistant("the end"));
        body.push('\n');
        let p = tmp_file("straddle", body.as_bytes());
        assert_eq!(read_last_message(&p)["text"], "the end");
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn tail_reader_handles_a_multibyte_char_at_the_cut() {
        // "é" is 2 bytes; make the cut land between them.
        let last = format!("{}\n", assistant("fin"));
        let filler_len = TAIL_BYTES as usize - last.len();
        let mut body = String::from("é");
        body.push_str(&"a".repeat(filler_len - 2));
        body.push('\n');
        body.push_str(&last);
        // The window starts one byte in: inside the "é", not after it.
        assert_eq!(body.len() as u64 - TAIL_BYTES, 1);
        assert!(!body.is_char_boundary(1));
        let p = tmp_file("utf8", body.as_bytes());
        assert_eq!(read_last_message(&p)["text"], "fin");
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn tail_reader_handles_crlf() {
        let body = format!("{}\r\n{}\r\n", assistant("one"), assistant("two"));
        let p = tmp_file("crlf", body.as_bytes());
        assert_eq!(read_last_message(&p)["text"], "two");
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn tail_reader_gives_null_for_a_single_line_longer_than_the_window() {
        let p = tmp_file("huge", assistant(&"y".repeat(300 * 1024)).as_bytes());
        assert!(read_last_message(&p).is_null());
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn cache_sweep_drops_unseen_paths() {
        let c = LastMessageCache::default();
        let a = tmp_file("sa", assistant("a").as_bytes());
        let b = tmp_file("sb", assistant("b").as_bytes());
        c.for_path(&a);
        c.for_path(&b);
        c.sweep();
        assert_eq!(c.inner.lock().unwrap().len(), 2);
        c.for_path(&a);
        c.sweep();
        let g = c.inner.lock().unwrap();
        assert!(g.contains_key(&a) && !g.contains_key(&b));
        std::fs::remove_file(a).ok();
        std::fs::remove_file(b).ok();
    }

    #[test]
    fn plain_text_bounds_a_huge_input() {
        let t = plain_text(&"[a](b) ".repeat(500_000));
        assert_eq!(t.chars().count(), 160);
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
    fn private_sessions_are_silo_or_local_only() {
        let mut silo = sess("a");
        silo.silo = true;
        let mut local = sess("b");
        local.local_only = true;
        let ps = [project("p", vec![silo, local, sess("c")])];
        assert!(session_is_private(&ps, "a"));
        assert!(session_is_private(&ps, "b"));
        assert!(!session_is_private(&ps, "c"));
        assert!(!session_is_private(&ps, "missing"));
        assert_eq!(
            private_session_error("a"),
            json!({ "type": "error", "message": "private session", "sessionId": "a" })
        );
    }

    fn ask(id: &str, session: &str) -> AskView {
        AskView {
            id: id.into(),
            session: session.into(),
            tool_use_id: "tu".into(),
            questions: json!([{"question":"Q?","options":[{"label":"A"}]}]),
            created_ms: 7,
        }
    }

    fn item(id: &str) -> PushItem {
        PushItem {
            id: id.into(),
            item: ask_push(&ask(id, "s"), false),
        }
    }

    #[test]
    fn ask_push_shape_and_private_shape() {
        let open = ask_push(&ask("ask-1", "s1"), false);
        assert_eq!(
            keys(&open),
            [
                "createdMs",
                "id",
                "kind",
                "questions",
                "sessionId",
                "toolUseId"
            ]
        );
        assert_eq!(open["kind"], "ask");
        assert_eq!(open["id"], "ask-1");
        assert_eq!(open["sessionId"], "s1");
        assert_eq!(open["toolUseId"], "tu");
        assert_eq!(open["createdMs"], 7);
        assert_eq!(open["questions"][0]["question"], "Q?");
        // A private session's question: that it exists, nothing of what it says.
        let private = ask_push(&ask("ask-2", "s2"), true);
        assert_eq!(
            private,
            json!({ "kind": "ask", "id": "ask-2", "sessionId": "s2", "private": true })
        );
        // The frames that carry them.
        let items = [PushItem {
            id: "ask-1".into(),
            item: open.clone(),
        }];
        assert_eq!(
            pending_frame(&items),
            json!({ "type": "pending", "asks": [open.clone()], "permissions": [] })
        );
        assert_eq!(
            pending_added_frame(&items[0]),
            json!({ "type": "pendingAdded", "item": open })
        );
        assert_eq!(
            resolved_frame("ask-1", "phone"),
            json!({ "type": "resolved", "id": "ask-1", "by": "phone" })
        );
        assert_eq!(
            answer_result_frame("ask-1", false),
            json!({ "type": "answerResult", "askId": "ask-1", "ok": false })
        );
    }

    #[test]
    fn push_frames_sends_pending_first_then_diffs_named_by_the_ring() {
        use crate::asks::By;
        let item = |id: &str| PushItem {
            id: id.to_string(),
            item: json!({ "kind": "ask", "id": id }),
        };
        // First call: the whole list, as one `pending`.
        let (frames, sent) = push_frames(None, &[item("a"), item("b")], &[]);
        assert_eq!(frames, vec![pending_frame(&[item("a"), item("b")])]);
        assert_eq!(sent, ["a", "b"].iter().map(|s| s.to_string()).collect());

        // Later: additions first, then each resolution with `by` from the ring (its LATEST
        // entry for that id); one that fell out of the ring reads `cancelled`.
        let ring = vec![
            ("b".to_string(), By::Desktop),
            ("x".to_string(), By::Timeout),
            ("b".to_string(), By::Phone),
        ];
        let (frames, sent) = push_frames(Some(&sent), &[item("c")], &ring);
        assert_eq!(
            frames,
            vec![
                pending_added_frame(&item("c")),
                resolved_frame("a", "cancelled"),
                resolved_frame("b", "phone"),
            ]
        );
        assert_eq!(sent, ["c"].iter().map(|s| s.to_string()).collect());

        // Nothing changed: nothing to send, the same set back.
        let (frames, again) = push_frames(Some(&sent), &[item("c")], &ring);
        assert!(frames.is_empty());
        assert_eq!(again, sent);

        // An empty first push is still a `pending` (the phone learns the list is empty).
        let (frames, sent) = push_frames(None, &[], &[]);
        assert_eq!(frames, vec![pending_frame(&[])]);
        assert!(sent.is_empty());
    }

    #[test]
    fn diff_pending_added_and_gone() {
        let none: HashSet<String> = HashSet::new();
        let (added, gone) = diff_pending(&none, &[item("a"), item("b")]);
        assert_eq!(
            added.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(gone.is_empty());
        // Two phones, each with its own view of what it was sent: one answers `a`, both
        // see it gone on their next diff, and only `c` is new to either.
        let phone1: HashSet<String> = ["a".to_string(), "b".to_string()].into();
        let phone2 = phone1.clone();
        let now = [item("b"), item("c")];
        for prev in [&phone1, &phone2] {
            let (added, gone) = diff_pending(prev, &now);
            assert_eq!(
                added.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
                ["c"]
            );
            assert_eq!(gone, ["a"]);
        }
        let (added, gone) = diff_pending(&phone1, &[item("a"), item("b")]);
        assert!(added.is_empty() && gone.is_empty(), "no change, no frames");
    }

    #[test]
    fn tail_flush_sends_only_what_was_appended() {
        let dir = std::env::temp_dir().join(format!("conduit-tail-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.jsonl");
        let line = |t: &str| {
            json!({"type":"user","message":{"role":"user","content":t},"uuid":t}).to_string()
        };
        std::fs::write(&path, format!("{}\n", line("one"))).unwrap();
        let mut cursor = 1;
        // Appended after the last tail pass, just before the `/clear` moved the session.
        std::fs::write(&path, format!("{}\n{}\n", line("one"), line("two"))).unwrap();
        let frames = tail_frames(&path, &mut cursor, "s1");
        assert_eq!(cursor, 2);
        assert!(!frames.is_empty(), "the late line reaches the phone");
        assert!(frames
            .iter()
            .all(|f| f["sessionId"] == "s1" && f["type"] == "chat"));
        assert!(
            tail_frames(&path, &mut cursor, "s1").is_empty(),
            "nothing twice"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chat_frame_names_its_session() {
        let f = chat_frame("s1", &json!({ "kind": "bubble" }));
        assert_eq!(keys(&f), ["item", "sessionId", "type"]);
        assert_eq!(f["sessionId"], "s1");
        assert_eq!(f["item"]["kind"], "bubble");
    }

    #[test]
    fn tail_resolves_only_when_missing_or_moved() {
        assert!(needs_resolve(None, false, "c1"), "no transcript yet");
        assert!(
            needs_resolve(Some("c1"), false, "c1"),
            "attached before it existed"
        );
        assert!(
            needs_resolve(Some("c1"), true, "c2"),
            "a /clear moved the conversation"
        );
        assert!(
            !needs_resolve(Some("c1"), true, "c1"),
            "nothing changed: no scan"
        );
    }

    #[test]
    fn tail_switches_only_to_a_different_found_path() {
        let a = Path::new("/t/a.jsonl");
        let b = Path::new("/t/b.jsonl");
        assert!(should_switch_tail(None, Some(a)));
        assert!(should_switch_tail(Some(a), Some(b)));
        assert!(!should_switch_tail(Some(a), Some(a)));
        assert!(
            !should_switch_tail(Some(a), None),
            "a failed lookup keeps the tail"
        );
        assert!(!should_switch_tail(None, None));
    }

    #[test]
    fn failed_attach_clears_the_old_stream() {
        let mut slot: Option<(String, u64, ())> = Some(("old".into(), 7, ()));
        let mut transcript = Some((PathBuf::from("/t/old.jsonl"), 12usize));
        let mut ctx = Some(PathBuf::from("/t/old.jsonl"));
        assert_eq!(
            clear_attachment(&mut slot, &mut transcript, &mut ctx),
            Some(("old".to_string(), 7))
        );
        assert!(slot.is_none() && transcript.is_none() && ctx.is_none());
        // Nothing attached: nothing to release, still cleared.
        assert_eq!(clear_attachment(&mut slot, &mut transcript, &mut ctx), None);
    }

    #[test]
    fn path_cache_resolves_once_per_conversation() {
        use std::cell::Cell;
        let c = LastMessageCache::default();
        let f = tmp_file("pc", assistant("a").as_bytes());
        let calls = Cell::new(0);
        let resolve = || {
            calls.set(calls.get() + 1);
            Some(f.clone())
        };
        assert_eq!(c.path_for("s", "c1", resolve), Some(f.clone()));
        assert_eq!(c.path_for("s", "c1", resolve), Some(f.clone()));
        assert_eq!(calls.get(), 1, "a cached path is not resolved again");
        c.path_for("s", "c2", resolve);
        assert_eq!(calls.get(), 2, "a new conversation resolves");
        // A miss is not cached.
        let misses = Cell::new(0);
        let miss = || {
            misses.set(misses.get() + 1);
            None
        };
        assert_eq!(c.path_for("t", "c", miss), None);
        assert_eq!(c.path_for("t", "c", miss), None);
        assert_eq!(misses.get(), 2);
        // A cached path that vanished is resolved again.
        std::fs::remove_file(&f).ok();
        c.path_for("s", "c1", resolve);
        assert_eq!(calls.get(), 3);
        // Sweep keeps keys asked for in the pass and forgets the rest.
        c.sweep();
        assert!(c
            .paths
            .lock()
            .unwrap()
            .contains_key(&("s".into(), "c1".into())));
        c.sweep(); // a pass that asked for nothing
        assert!(c.paths.lock().unwrap().is_empty());
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
