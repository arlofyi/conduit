//! Read an Antigravity (`agy`) conversation as the bridge's chat items.
//!
//! agy keeps each conversation in `<home>/.gemini/antigravity-cli/conversations/<uuid>.db`, a
//! SQLite file (WAL mode) whose `steps` table holds one protobuf-encoded "trajectory step" per
//! row. The format is undocumented; the field numbers below were reverse-engineered from real
//! conversations (agy 1.4.5) and are recorded in
//! `docs/superpowers/specs/2026-10-31-agy-conversation-format-findings.md`.
//!
//! The output is EXACTLY the item shape `transcript.rs` produces for Claude, and that is
//! guaranteed by construction rather than by copying: every step is rewritten as the Claude
//! JSONL line that would have meant the same thing, and that line goes through
//! `transcript::parse_line`. A future change to how Claude lines render therefore reaches agy
//! sessions too, and the phone needs no agy-specific code.
//!
//! Everything degrades: an unreadable file is `Err`, an unknown step type or a blob that is not
//! the protobuf we expect is skipped, never a panic.

// Read only by the tests until the bridge's history/tail path serves agy sessions.

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

// --- step types (`steps.step_type`, also payload field 1) -------------------------------
const USER_INPUT: i64 = 14;
const PLANNER_RESPONSE: i64 = 15;
const ERROR_MESSAGE: i64 = 17;
const CHECKPOINT: i64 = 23;
const SYSTEM_MESSAGE: i64 = 101;

// --- step status (`steps.status`, also payload field 4) ---------------------------------
const STATUS_DONE: i64 = 3;
const STATUS_CANCELED: i64 = 6;
const STATUS_ERROR: i64 = 7;

/// How long a read waits for agy's writer before giving up (it holds the lock only briefly).
const BUSY_TIMEOUT: Duration = Duration::from_millis(750);

/// `<home>/.gemini/antigravity-cli/conversations/<id>.db`, or `None` when `conversation_id` is
/// not a UUID or the file does not exist (yet).
///
/// The id comes from the store, but it was captured from agy's own filesystem; it is parsed as
/// a UUID and re-rendered rather than joined raw, so nothing like `..` or a separator can reach
/// the path.
pub fn conversation_db(home: &Path, conversation_id: &str) -> Option<PathBuf> {
    let id = uuid::Uuid::parse_str(conversation_id.trim()).ok()?;
    let path = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("conversations")
        .join(format!("{}.db", id.hyphenated()));
    path.is_file().then_some(path)
}

/// A cheap change marker for a tail loop: the size + mtime of the database and its `-wal`.
///
/// Every agy write (a new step, or a step updated in place from running to done) lands in the
/// WAL while agy is running and in the main file after a checkpoint, so either moving means
/// "read again". No SQLite connection is opened. `None` when the database cannot be stat'ed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgyVersion {
    db: (u64, Option<SystemTime>),
    wal: Option<(u64, Option<SystemTime>)>,
}

pub fn version(db: &Path) -> Option<AgyVersion> {
    let stat = |p: &Path| {
        std::fs::metadata(p)
            .ok()
            .map(|m| (m.len(), m.modified().ok()))
    };
    Some(AgyVersion {
        db: stat(db)?,
        wal: stat(&sidecar(db, "-wal")),
    })
}

/// Every step of the conversation as chat items, oldest first.
pub fn read_items(db: &Path) -> Result<Vec<Value>, String> {
    let conn = open_read_only(db)?;
    let mut stmt = conn
        .prepare(
            "SELECT idx, step_type, status, metadata, error_details, step_payload \
             FROM steps ORDER BY idx",
        )
        .map_err(|e| format!("agy steps: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Row {
                step_type: r.get(1)?,
                status: r.get(2)?,
                metadata: r.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
                error_details: r.get::<_, Option<Vec<u8>>>(4)?.unwrap_or_default(),
                payload: r.get::<_, Option<Vec<u8>>>(5)?.unwrap_or_default(),
            })
        })
        .map_err(|e| format!("agy steps: {e}"))?;
    let mut items = Vec::new();
    for row in rows.flatten() {
        items.extend(step_items(&row));
    }
    Ok(items)
}

/// `steps.status` of a tool step agy is holding for the user's yes/no (measured live: a
/// `run_command` step sits at 9 while the TUI shows "Run this command?", then moves to running
/// / done on a yes, 6 on Esc, 7 on "No").
pub const STATUS_WAITING: i64 = 9;

/// A tool call agy is waiting on the user to allow.
#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub idx: i64,
    /// agy's tool name (`run_command`, `write_to_file`, ...).
    pub tool: String,
    /// The call's arguments as agy sent them (JSON object; `{}` when unreadable).
    pub args: Value,
}

/// Every step currently waiting on the user, oldest first.
pub fn waiting_steps(db: &Path) -> Result<Vec<Waiting>, String> {
    let conn = open_read_only(db)?;
    let mut stmt = conn
        .prepare("SELECT idx, metadata, step_payload FROM steps WHERE status = ?1 ORDER BY idx")
        .map_err(|e| format!("agy steps: {e}"))?;
    let rows = stmt
        .query_map([STATUS_WAITING], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<Vec<u8>>>(1)?.unwrap_or_default(),
                r.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default(),
            ))
        })
        .map_err(|e| format!("agy steps: {e}"))?;
    let mut out = Vec::new();
    for (idx, metadata, payload) in rows.flatten() {
        let payload_msg = Msg::parse(&payload);
        let meta = Msg::parse(&metadata).or_else(|| payload_msg.as_ref().and_then(|p| p.msg(5)));
        let call = meta.as_ref().and_then(|m| m.msg(4));
        let tool = call
            .as_ref()
            .and_then(|c| c.str(2))
            .unwrap_or("tool")
            .to_string();
        let args = call
            .as_ref()
            .and_then(|c| c.str(3))
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        out.push(Waiting { idx, tool, args });
    }
    Ok(out)
}

/// One step's status, or None when it cannot be read.
pub fn step_status(db: &Path, idx: i64) -> Option<i64> {
    let conn = open_read_only(db).ok()?;
    conn.query_row("SELECT status FROM steps WHERE idx = ?1", [idx], |r| {
        r.get(0)
    })
    .ok()
}

/// Open without ever writing agy's directory.
///
/// While agy runs, its `-wal`/`-shm` exist and hold the newest steps, so a normal read-only open
/// is required to see them. When agy is not running there is no `-wal`, and a read-only open of a
/// WAL database would CREATE the sidecars (measured) -- so that case opens `immutable=1`, which
/// takes no locks and creates nothing. If agy starts between the check and the open, the read is
/// a snapshot and the tail loop's next `version` change re-reads.
fn open_read_only(db: &Path) -> Result<Connection, String> {
    if !db.is_file() {
        return Err(format!("no agy conversation at {}", db.display()));
    }
    let live = sidecar(db, "-wal").is_file();
    let uri = format!(
        "{}?mode=ro{}",
        file_uri(db),
        if live { "" } else { "&immutable=1" }
    );
    let conn = Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open agy conversation: {e}"))?;
    let _ = conn.busy_timeout(BUSY_TIMEOUT);
    let _ = conn.pragma_update(None, "query_only", true);
    Ok(conn)
}

fn sidecar(db: &Path, suffix: &str) -> PathBuf {
    let mut s = db.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// `file:` URI for a path, percent-encoding everything but unreserved characters so a space,
/// `#` or `?` in a user's directory cannot change what SQLite opens.
fn file_uri(p: &Path) -> String {
    let raw = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file:");
    // `C:/x` must become `file:///C:/x`; a unix `/x` becomes `file:///x` via the extra `//`.
    if raw.starts_with('/') {
        out.push_str("//");
    } else {
        out.push_str("///");
    }
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

struct Row {
    step_type: i64,
    status: i64,
    metadata: Vec<u8>,
    error_details: Vec<u8>,
    payload: Vec<u8>,
}

/// One step -> the Claude lines that mean the same thing -> `transcript::parse_line`.
fn step_items(row: &Row) -> Vec<Value> {
    let Some(payload) = Msg::parse(&row.payload) else {
        return vec![];
    };
    let meta = Msg::parse(&row.metadata).or_else(|| payload.msg(5));
    let at = meta
        .as_ref()
        .and_then(|m| m.msg(1))
        .and_then(|t| timestamp(&t));
    let mut summaries: Vec<(String, String)> = Vec::new();
    let mut lines: Vec<Value> = Vec::new();

    // A tool's execution step carries the call it answers in metadata field 4, whatever its
    // own type (RUN_COMMAND, VIEW_FILE, GENERIC, even ERROR_MESSAGE for a rejected call).
    let answered = meta
        .as_ref()
        .and_then(|m| m.msg(4))
        .and_then(|c| c.str(1).map(str::to_string));
    if let (Some(id), false) = (
        answered,
        matches!(row.step_type, USER_INPUT | PLANNER_RESPONSE),
    ) {
        if let Some(line) = result_line(&id, row, &payload) {
            lines.push(line);
        }
    } else {
        match row.step_type {
            USER_INPUT => {
                let input = payload.msg(19);
                let text = input
                    .as_ref()
                    .and_then(|u| u.str(2).map(str::to_string))
                    .or_else(|| input.as_ref()?.msg(3)?.str(1).map(str::to_string));
                if let Some(text) = text.filter(|t| !t.trim().is_empty()) {
                    // agy records only what the human typed here, so it is always a bubble.
                    lines.push(json!({"type": "user", "origin": {"kind": "human"},
                        "message": {"content": text}}));
                }
            }
            PLANNER_RESPONSE => {
                if let Some(resp) = payload.msg(20) {
                    let mut content = Vec::new();
                    // Field 1 is the reply; 8 is the same text after agy's own rewriting.
                    // Field 3 is thinking, dropped exactly as Claude's thinking blocks are.
                    if let Some(t) = resp.str(1).or_else(|| resp.str(8)) {
                        content.push(json!({"type": "text", "text": t}));
                    }
                    for call in resp.msgs(7) {
                        let Some(id) = call.str(1) else { continue };
                        let name = call.str(2).unwrap_or("");
                        let args: Value = call
                            .str(3)
                            .and_then(|a| serde_json::from_str(a).ok())
                            .unwrap_or_else(|| json!({}));
                        if let Some(s) = summary_of(&args) {
                            summaries.push((id.to_string(), s));
                        }
                        let (claude_name, input) = claude_tool(name, &args);
                        content.push(json!({"type": "tool_use", "id": id,
                            "name": claude_name, "input": input}));
                    }
                    if !content.is_empty() {
                        lines.push(json!({"type": "assistant", "message": {"content": content}}));
                    }
                }
            }
            ERROR_MESSAGE => {
                if let Some(text) = error_message_text(&payload) {
                    // A model/API error the turn ran into: not a tool, so a divider.
                    let label: String = first_line(&text, 160);
                    return stamp(
                        vec![json!({"kind": "divider", "label": label, "tone": "warning"})],
                        at.as_deref(),
                    );
                }
            }
            CHECKPOINT => {
                // Every conversation opens with a checkpoint that summarises nothing; only one
                // carrying a summary (field 5) is a real compaction.
                if payload.msg(30).and_then(|c| c.bytes(5)).is_some() {
                    lines.push(json!({"type": "system", "subtype": "compact_boundary",
                        "content": "Conversation compacted"}));
                }
            }
            SYSTEM_MESSAGE => {
                if let Some(line) = system_line(&payload) {
                    lines.push(line);
                }
            }
            _ => {}
        }
    }

    let mut items: Vec<Value> = Vec::new();
    for mut line in lines {
        if let (Some(at), Some(obj)) = (&at, line.as_object_mut()) {
            obj.insert("timestamp".into(), json!(at));
        }
        items.extend(crate::transcript::parse_line(&line.to_string()));
    }
    // A tool Claude has no name for renders as a bare "used a tool"; agy writes a one-line
    // summary of every call, which is better than nothing.
    for item in items.iter_mut() {
        if item["kind"] == "event" && item["event"] == "generic" && item["mono"].is_null() {
            let id = item["toolUseId"].as_str().unwrap_or("").to_string();
            if let Some((_, s)) = summaries.iter().find(|(i, _)| *i == id) {
                item["mono"] = json!(s);
            }
        }
    }
    items
}

fn stamp(mut items: Vec<Value>, at: Option<&str>) -> Vec<Value> {
    if let Some(at) = at {
        for item in items.iter_mut() {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("at".into(), json!(at));
            }
        }
    }
    items
}

/// The `tool_result` line for a tool's execution step, or `None` while it is still running.
fn result_line(id: &str, row: &Row, payload: &Msg) -> Option<Value> {
    let (is_error, text) = match row.status {
        STATUS_CANCELED => (true, "Cancelled".to_string()),
        STATUS_ERROR => (
            true,
            error_text(row, payload).unwrap_or_else(|| "Failed".into()),
        ),
        STATUS_DONE if row.step_type == ERROR_MESSAGE => (
            true,
            error_message_text(payload).unwrap_or_else(|| "Failed".into()),
        ),
        STATUS_DONE => match command_exit(payload) {
            // Claude's own shape for a failed command, so `transcript_user::error_text` picks
            // the line that reads like an error out of the output.
            Some((code, output)) if code != 0 => (true, format!("Exit code {code}\n{output}")),
            _ => (false, String::new()),
        },
        // Queued, generating, waiting on permission: no result yet, so the call shows running.
        _ => return None,
    };
    Some(json!({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": id, "is_error": is_error, "content": text}
    ]}}))
}

/// A `run_command`'s exit code and output: payload field 28 on a RUN_COMMAND step, or the same
/// step nested in a GENERIC step's result (`140.2.6`, a `google.protobuf.Any`).
fn command_exit(payload: &Msg) -> Option<(u64, String)> {
    let cmd = payload.msg(28).or_else(|| {
        let any = payload.msg(140)?.msg(2)?.msg(6)?;
        Msg::parse(any.bytes(2)?)?.msg(28)
    })?;
    let code = cmd.varint(6).unwrap_or(0);
    let output = cmd
        .msg(21)
        .and_then(|o| o.str(1).map(str::to_string))
        .unwrap_or_default();
    Some((code, output))
}

fn error_text(row: &Row, payload: &Msg) -> Option<String> {
    Msg::parse(&row.error_details)
        .and_then(|e| e.str(2).or_else(|| e.str(3)).map(str::to_string))
        .or_else(|| payload.msg(31)?.str(2).map(str::to_string))
        .or_else(|| error_message_text(payload))
        .filter(|t| !t.trim().is_empty())
}

fn error_message_text(payload: &Msg) -> Option<String> {
    payload
        .msg(24)?
        .msg(3)?
        .str(2)
        .map(str::to_string)
        .filter(|t| !t.trim().is_empty())
}

/// A SYSTEM_MESSAGE step (field 114): a background task finishing becomes Claude's
/// `<task-notification>`; any other notice becomes an info divider.
fn system_line(payload: &Msg) -> Option<Value> {
    let sys = payload.msg(114)?;
    let header = sys.msg(2);
    let title = header.as_ref().and_then(|h| h.str(1)).unwrap_or("");
    if sys.str(3) == Some("task_notification") {
        let task_id = sys.msg(4).and_then(|m| m.str(3).map(str::to_string));
        let text = format!(
            "<task-notification>\n<task-id>{}</task-id>\n<status>completed</status>\n<summary>{}</summary>\n</task-notification>",
            task_id.unwrap_or_default(),
            title
        );
        return Some(json!({"type": "user", "message": {"content": text}}));
    }
    let notice = header
        .as_ref()
        .and_then(|h| h.msg(10))
        .and_then(|n| n.str(1).map(str::to_string))
        .or_else(|| header.as_ref()?.str(2).map(str::to_string))
        .unwrap_or_else(|| title.to_string());
    let label = first_line(notice.trim_start_matches("[Notice]").trim(), 160);
    (!label.is_empty())
        .then(|| json!({"type": "system", "subtype": "informational", "content": label}))
}

fn first_line(s: &str, max: usize) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(max)
        .collect()
}

/// agy writes `toolSummary` (and `toolAction`) into every call's arguments.
fn summary_of(args: &Value) -> Option<String> {
    ["toolSummary", "toolAction"]
        .iter()
        .find_map(|k| args.get(*k).and_then(|v| v.as_str()))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Map an agy tool call onto the Claude tool whose rendering fits it, carrying across the one
/// argument that renderer shows. Unknown tools keep their own name and render as generic.
pub(crate) fn claude_tool(name: &str, args: &Value) -> (String, Value) {
    let s = |keys: &[&str]| -> Value {
        keys.iter()
            .find_map(|k| args.get(*k).and_then(|v| v.as_str()))
            .map(|v| json!(v))
            .unwrap_or(Value::Null)
    };
    let (claude, input) = match name {
        "run_command" => ("Bash", json!({ "command": s(&["CommandLine"]) })),
        "view_file" | "read_file" => ("Read", json!({ "file_path": s(&["AbsolutePath", "Path"]) })),
        "write_to_file" => ("Write", json!({ "file_path": s(&["TargetFile"]) })),
        "replace_file_content" | "multi_replace_file_content" => {
            ("Edit", json!({ "file_path": s(&["TargetFile"]) }))
        }
        "grep_search" => ("Grep", json!({ "pattern": s(&["Query"]) })),
        "find_by_name" => (
            "Glob",
            json!({ "pattern": s(&["Pattern", "SearchDirectory", "toolSummary"]) }),
        ),
        "list_dir" => ("Glob", json!({ "pattern": s(&["DirectoryPath"]) })),
        "read_url_content" => ("WebFetch", json!({ "url": s(&["Url", "URL", "url"]) })),
        "search_web" => (
            "WebSearch",
            json!({ "url": s(&["query", "Query", "toolSummary"]) }),
        ),
        "invoke_subagent" => (
            "Agent",
            json!({ "description": s(&["toolSummary", "Description", "toolAction"]) }),
        ),
        other => return (other.to_string(), args.clone()),
    };
    (claude.to_string(), input)
}

/// A `google.protobuf.Timestamp` ({1: seconds, 2: nanos}) as RFC 3339 UTC with milliseconds,
/// the same form Claude's lines carry.
fn timestamp(t: &Msg) -> Option<String> {
    let secs = t.varint(1)? as i64;
    let nanos = t.varint(2).unwrap_or(0);
    Some(rfc3339(secs, nanos))
}

pub(crate) fn rfc3339(secs: i64, nanos: u64) -> String {
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        sod / 3600,
        sod % 3600 / 60,
        sod % 60,
        (nanos / 1_000_000).min(999)
    )
}

// --- a minimal schema-less protobuf reader ----------------------------------------------

#[derive(Clone, Copy)]
enum Wire<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed,
}

/// One decoded message: its fields in wire order. `parse` fails on anything that is not
/// well-formed protobuf, which is what lets a caller treat an unexpected blob as "skip".
struct Msg<'a>(Vec<(u64, Wire<'a>)>);

impl<'a> Msg<'a> {
    fn parse(b: &'a [u8]) -> Option<Msg<'a>> {
        let mut i = 0;
        let mut out = Vec::new();
        while i < b.len() {
            let key = varint(b, &mut i)?;
            let (field, wire) = (key >> 3, key & 7);
            if field == 0 {
                return None;
            }
            let v = match wire {
                0 => Wire::Varint(varint(b, &mut i)?),
                1 | 5 => {
                    i = i.checked_add(if wire == 1 { 8 } else { 4 })?;
                    Wire::Fixed
                }
                2 => {
                    let len = usize::try_from(varint(b, &mut i)?).ok()?;
                    let end = i.checked_add(len)?;
                    let v = b.get(i..end)?;
                    i = end;
                    Wire::Bytes(v)
                }
                _ => return None,
            };
            out.push((field, v));
        }
        (i == b.len()).then_some(Msg(out))
    }

    fn bytes(&self, n: u64) -> Option<&'a [u8]> {
        self.0.iter().find_map(|(f, w)| match w {
            Wire::Bytes(b) if *f == n => Some(*b),
            _ => None,
        })
    }

    fn str(&self, n: u64) -> Option<&'a str> {
        std::str::from_utf8(self.bytes(n)?).ok()
    }

    fn msg(&self, n: u64) -> Option<Msg<'a>> {
        Msg::parse(self.bytes(n)?)
    }

    fn msgs(&self, n: u64) -> Vec<Msg<'a>> {
        self.0
            .iter()
            .filter_map(|(f, w)| match w {
                Wire::Bytes(b) if *f == n => Msg::parse(b),
                _ => None,
            })
            .collect()
    }

    fn varint(&self, n: u64) -> Option<u64> {
        self.0.iter().find_map(|(f, w)| match w {
            Wire::Varint(v) if *f == n => Some(*v),
            _ => None,
        })
    }
}

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut r = 0u64;
    for shift in (0..64).step_by(7) {
        let x = *b.get(*i)?;
        *i += 1;
        r |= u64::from(x & 0x7f) << shift;
        if x < 0x80 {
            return Some(r);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- a tiny protobuf writer, enough to build steps shaped like agy's ------------------
    fn enc_varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }
    fn vi(n: u64, v: u64) -> Vec<u8> {
        let mut o = Vec::new();
        enc_varint(n << 3, &mut o);
        enc_varint(v, &mut o);
        o
    }
    fn by(n: u64, b: &[u8]) -> Vec<u8> {
        let mut o = Vec::new();
        enc_varint((n << 3) | 2, &mut o);
        enc_varint(b.len() as u64, &mut o);
        o.extend_from_slice(b);
        o
    }
    fn s(n: u64, v: &str) -> Vec<u8> {
        by(n, v.as_bytes())
    }
    fn m(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.concat()
    }
    fn ts(secs: u64) -> Vec<u8> {
        by(1, &m(&[vi(1, secs), vi(2, 250_000_000)]))
    }
    fn call(id: &str, name: &str, args: Value) -> Vec<u8> {
        m(&[s(1, id), s(2, name), s(3, &args.to_string()), s(9, name)])
    }
    /// metadata for a tool's execution step: created-at + the call it answers.
    fn tool_meta(id: &str, name: &str) -> Vec<u8> {
        m(&[
            ts(1_788_061_283),
            vi(3, 2),
            by(4, &call(id, name, json!({}))),
        ])
    }
    fn plain_meta() -> Vec<u8> {
        m(&[ts(1_788_061_283), vi(3, 2)])
    }

    struct Step {
        ty: i64,
        status: i64,
        meta: Vec<u8>,
        err: Vec<u8>,
        body: Vec<u8>,
    }
    fn step(ty: i64, meta: Vec<u8>, body: Vec<u8>) -> Step {
        Step {
            ty,
            status: STATUS_DONE,
            meta,
            err: vec![],
            body,
        }
    }

    const SCHEMA: &str = "CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`));
CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));
CREATE INDEX `idx_steps_status` ON `steps`(`status`);
CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));";

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "conduit-agy-transcript-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn insert(conn: &Connection, idx: i64, st: &Step) {
        // The real payload repeats type (1), status (4) and metadata (5) ahead of its body.
        let payload = m(&[
            vi(1, st.ty as u64),
            vi(4, st.status as u64),
            by(5, &st.meta),
            st.body.clone(),
        ]);
        conn.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, error_details, step_payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                idx,
                st.ty,
                st.status,
                st.meta,
                if st.err.is_empty() { None } else { Some(st.err.clone()) },
                payload
            ],
        )
        .unwrap();
    }

    fn make_db(dir: &Path, steps: &[Step]) -> (PathBuf, Connection) {
        let path = dir.join("conv.db");
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for (i, st) in steps.iter().enumerate() {
            insert(&conn, i as i64, st);
        }
        (path, conn)
    }

    fn conversation() -> Vec<Step> {
        let planner = |parts: &[Vec<u8>]| by(20, &m(parts));
        vec![
            step(
                USER_INPUT,
                m(&[ts(1_788_061_283), vi(3, 4)]),
                by(
                    19,
                    &m(&[s(2, "add rate limiting"), by(3, &s(1, "add rate limiting"))]),
                ),
            ),
            step(98, plain_meta(), s(111, "")),
            step(
                PLANNER_RESPONSE,
                plain_meta(),
                planner(&[
                    s(1, "On it."),
                    s(3, "thinking that must not show"),
                    s(6, "bot-1"),
                    by(
                        7,
                        &call(
                            "c1",
                            "run_command",
                            json!({"CommandLine":"npm test","toolSummary":"Run tests"}),
                        ),
                    ),
                    vi(12, 2),
                ]),
            ),
            step(
                21,
                tool_meta("c1", "run_command"),
                by(
                    28,
                    &m(&[
                        vi(6, 1),
                        by(21, &s(1, "compiling\nerror: boom\n")),
                        s(23, "npm test"),
                    ]),
                ),
            ),
            step(
                PLANNER_RESPONSE,
                plain_meta(),
                planner(&[
                    by(
                        7,
                        &call("c2", "view_file", json!({"AbsolutePath":"C:/x/a.rs"})),
                    ),
                    by(
                        7,
                        &call(
                            "c3",
                            "manage_task",
                            json!({"Action":"status","toolSummary":"Check task"}),
                        ),
                    ),
                    by(7, &call("c4", "list_dir", json!({"DirectoryPath":"C:/x"}))),
                    by(
                        7,
                        &call("c5", "write_to_file", json!({"TargetFile":"C:/x/b.rs"})),
                    ),
                ]),
            ),
            step(
                8,
                tool_meta("c2", "view_file"),
                by(14, &s(4, "fn main() {}")),
            ),
            Step {
                status: STATUS_CANCELED,
                ..step(
                    132,
                    tool_meta("c3", "manage_task"),
                    by(140, &by(1, &m(&[s(1, "Action"), s(2, "status")]))),
                )
            },
            // Still waiting on permission: no result yet.
            Step {
                status: 9,
                ..step(132, tool_meta("c4", "list_dir"), by(140, &[]))
            },
            Step {
                status: STATUS_ERROR,
                err: m(&[s(2, "file does not exist"), s(3, "file does not exist")]),
                ..step(
                    132,
                    tool_meta("c5", "write_to_file"),
                    by(31, &s(2, "file does not exist")),
                )
            },
            step(
                ERROR_MESSAGE,
                plain_meta(),
                by(
                    24,
                    &by(
                        3,
                        &m(&[
                            s(2, "API error (attempt 1): UNAVAILABLE (code 503)\nmore"),
                            s(6, "x"),
                        ]),
                    ),
                ),
            ),
            // The opening checkpoint summarises nothing; the second is a real compaction.
            step(
                CHECKPOINT,
                plain_meta(),
                by(30, &m(&[s(4, "Initiating New Conversation"), s(19, "hi")])),
            ),
            step(
                CHECKPOINT,
                plain_meta(),
                by(30, &m(&[s(5, "# Continuation Summary\n..."), vi(12, 11)])),
            ),
            step(
                SYSTEM_MESSAGE,
                plain_meta(),
                by(
                    114,
                    &m(&[
                        s(1, "[Message] ..."),
                        by(
                            2,
                            &m(&[
                                s(1, "Cargo test finished"),
                                s(2, "Task id finished with result"),
                            ]),
                        ),
                        s(3, "task_notification"),
                        by(4, &m(&[s(1, "m1"), s(2, "conv"), s(3, "conv/task-68")])),
                    ]),
                ),
            ),
            step(
                SYSTEM_MESSAGE,
                plain_meta(),
                by(
                    114,
                    &m(&[by(
                        2,
                        &m(&[
                            s(1, "System Message"),
                            by(
                                10,
                                &s(1, "[Notice] All your subagents were stopped.\nDetails"),
                            ),
                        ]),
                    )]),
                ),
            ),
            // Thinking only: nothing to show.
            step(
                PLANNER_RESPONSE,
                plain_meta(),
                planner(&[s(3, "hm"), s(6, "bot-2"), vi(12, 2)]),
            ),
            // Not protobuf at all: skipped, not an error.
            Step {
                body: vec![0xff, 0xff, 0xff],
                ..step(PLANNER_RESPONSE, vec![0xff], vec![])
            },
            step(
                PLANNER_RESPONSE,
                plain_meta(),
                planner(&[s(1, "Done."), s(8, "Done.")]),
            ),
        ]
    }

    fn read(tag: &str) -> Vec<Value> {
        let dir = temp_home(tag);
        let (path, conn) = make_db(&dir, &conversation());
        drop(conn);
        let items = read_items(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        items
    }

    #[test]
    fn finds_the_step_waiting_on_permission_with_its_tool_and_status() {
        let dir = temp_home("waiting");
        let (path, conn) = make_db(&dir, &conversation());
        drop(conn);
        let w = waiting_steps(&path).unwrap();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].tool, "list_dir");
        assert_eq!(step_status(&path, w[0].idx), Some(STATUS_WAITING));
        assert_eq!(step_status(&path, 9999), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn maps_a_conversation_to_claude_items() {
        let items = read("map");
        let kinds: Vec<&str> = items.iter().map(|i| i["kind"].as_str().unwrap()).collect();
        assert_eq!(
            kinds,
            [
                "bubble", "bubble", "event", "result", "event", "event", "event", "event",
                "result", "result", "result", "divider", "divider", "task", "divider", "bubble"
            ]
        );
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[0]["text"], "add rate limiting");
        assert_eq!(items[0]["at"], "2026-08-30T03:41:23.250Z");
        assert_eq!(items[1]["role"], "assistant");
        assert_eq!(items[1]["text"], "On it.");
        assert!(
            !items
                .iter()
                .any(|i| i.to_string().contains("thinking that must")),
            "thinking is dropped as Claude's is"
        );
        assert_eq!(items[2]["event"], "bash");
        assert_eq!(items[2]["mono"], "npm test");
        assert_eq!(items[2]["toolUseId"], "c1");
        // A non-zero exit is a failed result, and the error line is picked out of the output.
        assert_eq!(items[3]["toolUseId"], "c1");
        assert_eq!(items[3]["isError"], true);
        assert_eq!(items[3]["errorText"], "error: boom");
        // view_file -> read, manage_task -> generic with agy's own summary, list_dir -> search.
        assert_eq!(items[4]["event"], "read");
        assert_eq!(items[4]["mono"], "C:/x/a.rs");
        assert_eq!(items[5]["event"], "generic");
        assert_eq!(items[5]["mono"], "Check task");
        assert_eq!(items[6]["event"], "search");
        assert_eq!(items[7]["event"], "edit");
        assert_eq!(items[8]["toolUseId"], "c2");
        assert_eq!(items[8]["isError"], false);
        assert_eq!(items[9]["toolUseId"], "c3");
        assert_eq!(items[9]["errorText"], "Cancelled");
        // c4 is waiting on permission, so it has no result and renders as running.
        assert!(!items
            .iter()
            .any(|i| i["kind"] == "result" && i["toolUseId"] == "c4"));
        assert_eq!(items[10]["toolUseId"], "c5");
        assert_eq!(items[10]["errorText"], "file does not exist");
        assert_eq!(items[11]["tone"], "warning");
        assert_eq!(
            items[11]["label"],
            "API error (attempt 1): UNAVAILABLE (code 503)"
        );
        assert_eq!(items[12]["label"], "Conversation compacted");
        assert_eq!(items[13]["taskId"], "conv/task-68");
        assert_eq!(items[13]["status"], "completed");
        assert_eq!(items[13]["summary"], "Cargo test finished");
        assert_eq!(items[14]["label"], "All your subagents were stopped.");
        assert_eq!(items[14]["tone"], "info");
        assert_eq!(items[15]["text"], "Done.");
    }

    #[test]
    fn every_kind_is_in_the_manifest() {
        let kinds: Vec<String> = serde_json::from_str(crate::transcript::ITEM_KINDS_JSON).unwrap();
        for item in read("manifest") {
            let k = item["kind"].as_str().unwrap();
            assert!(
                kinds.iter().any(|x| x == k),
                "kind {k} missing from manifest"
            );
        }
    }

    #[test]
    fn a_live_conversation_is_read_through_its_wal_and_version_moves() {
        let dir = temp_home("live");
        // The writer stays open, as agy does while running: the newest steps live in the WAL.
        let (path, conn) = make_db(&dir, &conversation()[..1]);
        assert!(sidecar(&path, "-wal").is_file(), "writer keeps a WAL");
        let v1 = version(&path).unwrap();
        assert_eq!(read_items(&path).unwrap().len(), 1);
        insert(
            &conn,
            1,
            &step(PLANNER_RESPONSE, plain_meta(), by(20, &s(1, "reply"))),
        );
        let v2 = version(&path).unwrap();
        assert_ne!(v1, v2, "a new step must move the marker");
        let items = read_items(&path).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1]["text"], "reply");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_closed_conversation_is_read_without_creating_sidecars() {
        let dir = temp_home("closed");
        let (path, conn) = make_db(&dir, &conversation()[..1]);
        drop(conn); // last connection checkpoints and removes the WAL
        assert!(!sidecar(&path, "-wal").exists());
        assert_eq!(read_items(&path).unwrap().len(), 1);
        assert!(
            !sidecar(&path, "-wal").exists(),
            "read must not create a -wal"
        );
        assert!(
            !sidecar(&path, "-shm").exists(),
            "read must not create a -shm"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_files_are_errors_not_panics() {
        let dir = temp_home("bad");
        assert!(read_items(&dir.join("missing.db")).is_err());
        let junk = dir.join("junk.db");
        std::fs::write(&junk, b"not a database at all, just bytes").unwrap();
        assert!(read_items(&junk).is_err());
        let empty = dir.join("empty.db");
        Connection::open(&empty)
            .unwrap()
            .execute_batch("CREATE TABLE other (x)")
            .unwrap();
        assert!(read_items(&empty).is_err(), "no steps table");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn paths_with_spaces_and_uri_characters_open() {
        let dir = temp_home("a dir #1 %20 &x");
        let (path, conn) = make_db(&dir, &conversation()[..1]);
        drop(conn);
        assert_eq!(read_items(&path).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn conversation_db_validates_the_id() {
        let home = temp_home("home");
        let id = "1fd01cb4-0298-47a2-9efb-88ed983febe2";
        let dir = home
            .join(".gemini")
            .join("antigravity-cli")
            .join("conversations");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            conversation_db(&home, id),
            None,
            "absent until agy writes it"
        );
        std::fs::write(dir.join(format!("{id}.db")), b"").unwrap();
        assert_eq!(
            conversation_db(&home, id),
            Some(dir.join(format!("{id}.db")))
        );
        assert_eq!(
            conversation_db(&home, &id.to_uppercase()),
            Some(dir.join(format!("{id}.db"))),
            "re-rendered, not joined raw"
        );
        for bad in [
            "",
            "../../etc/passwd",
            "1fd01cb4",
            "x/1fd01cb4-0298-47a2-9efb-88ed983febe2",
        ] {
            assert_eq!(conversation_db(&home, bad), None, "{bad}");
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn rfc3339_formats_utc() {
        assert_eq!(rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(951_782_400, 5_000_000), "2000-02-29T00:00:00.005Z");
        assert_eq!(
            rfc3339(1_788_061_283, 71_456_200),
            "2026-08-30T03:41:23.071Z"
        );
    }

    #[test]
    fn protobuf_reader_rejects_malformed_input() {
        assert!(
            Msg::parse(&[0x0a, 0x05, b'a']).is_none(),
            "length past the end"
        );
        assert!(Msg::parse(&[0x00]).is_none(), "field 0");
        assert!(Msg::parse(&[0x0b]).is_none(), "group wire type");
        assert!(Msg::parse(&[0x08, 0xff]).is_none(), "truncated varint");
        let ok = m(&[vi(1, 300), s(2, "hi")]);
        let msg = Msg::parse(&ok).unwrap();
        assert_eq!(msg.varint(1), Some(300));
        assert_eq!(msg.str(2), Some("hi"));
    }
}

/// How a re-read conversation reaches a phone that already holds `old`.
#[derive(Debug, PartialEq)]
pub enum Update {
    Nothing,
    /// Only new items at the end: send them as `chat` frames.
    Append(Vec<Value>),
    /// An earlier item changed (a step updated in place): re-send the whole `history`.
    Replace(Vec<Value>),
}

pub fn diff(old: &[Value], new: Vec<Value>) -> Update {
    if new.len() >= old.len() && new[..old.len()] == *old {
        if new.len() == old.len() {
            Update::Nothing
        } else {
            Update::Append(new[old.len()..].to_vec())
        }
    } else {
        Update::Replace(new)
    }
}

/// The phone's view of one agy session's conversation: where it lives, the last version read
/// and the items the phone holds. `db` is None until agy has captured its conversation id.
#[derive(Default)]
pub struct Tail {
    pub session_id: String,
    pub db: Option<PathBuf>,
    pub version: Option<AgyVersion>,
    pub items: Vec<Value>,
}

impl Tail {
    pub fn new(session_id: &str) -> Self {
        Tail {
            session_id: session_id.to_string(),
            ..Default::default()
        }
    }

    /// Re-read if the database moved since the last read (or appeared); what to send.
    pub fn poll(&mut self, resolve: impl FnOnce() -> Option<PathBuf>) -> Update {
        if self.db.is_none() {
            self.db = resolve();
        }
        let Some(db) = self.db.clone() else {
            return Update::Nothing;
        };
        let v = version(&db);
        if v.is_some() && v == self.version {
            return Update::Nothing;
        }
        let Ok(items) = read_items(&db) else {
            return Update::Nothing;
        };
        self.version = v;
        let update = diff(&self.items, items.clone());
        self.items = items;
        update
    }
}

#[cfg(test)]
mod diff_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn appends_only_new_items_and_replaces_on_an_edit() {
        let a = json!({"k": 1});
        let b = json!({"k": 2});
        let c = json!({"k": 3});
        assert_eq!(
            diff(std::slice::from_ref(&a), vec![a.clone()]),
            Update::Nothing
        );
        assert_eq!(
            diff(std::slice::from_ref(&a), vec![a.clone(), b.clone()]),
            Update::Append(vec![b.clone()])
        );
        assert_eq!(
            diff(&[a.clone(), b.clone()], vec![a.clone(), c.clone()]),
            Update::Replace(vec![a.clone(), c.clone()])
        );
        assert_eq!(
            diff(&[a.clone(), b], vec![a.clone()]),
            Update::Replace(vec![a])
        );
    }
}
