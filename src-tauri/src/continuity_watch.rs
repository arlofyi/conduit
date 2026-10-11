//! Live change feed over continuity's database, for the Continuity view's pulses.
//!
//! One app-wide thread, one READ-ONLY connection. `PRAGMA data_version` changes only when
//! ANOTHER connection commits — i.e. continuity — so an idle tick is one integer read.
//! On a change it reports the messages newer than a `(created_at, id)` cursor; that is the
//! only cursor, because only a NEW message becomes a pulse. Everything else just refetches
//! on the event. Continuity's timestamps are ISO-8601 `…Z` strings, which order as text.

use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const TICK: Duration = Duration::from_millis(500);
pub const RETRY: Duration = Duration::from_secs(10);
/// How many ticks between file-identity checks. An open connection keeps a deleted or
/// renamed-over DB's old inode alive and `data_version` keeps answering from it, so without
/// this the view freezes until restart. Unix compares the path's (dev, ino) every ~10 s;
/// Windows has no inode to compare, so it simply drops and re-opens every ~30 s.
pub const IDENTITY_CHECK_EVERY: u32 = if cfg!(windows) { 60 } else { 20 };
/// A burst cap: a continuity backfill must not turn into a pulse storm.
const MAX_MESSAGES_PER_TICK: usize = 200;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchedMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ChangedPayload {
    pub messages: Vec<WatchedMessage>,
}

#[derive(Debug, PartialEq)]
pub enum Tick {
    Unavailable,
    Unchanged,
    Changed(ChangedPayload),
}

pub struct Watcher {
    path: PathBuf,
    conn: Option<rusqlite::Connection>,
    version: Option<i64>,
    cursor: Option<(String, String)>,
    /// What the open connection was opened on (unix only; `None` elsewhere or when unread).
    identity: Option<FileIdentity>,
    ticks_since_check: u32,
    /// The connection was dropped because the file under it changed: the first successful
    /// re-open reports a change even when no new message survived the cursor.
    replaced: bool,
}

#[cfg(unix)]
type FileIdentity = (u64, u64);
#[cfg(not(unix))]
type FileIdentity = ();

#[cfg(unix)]
fn file_identity(path: &std::path::Path) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn file_identity(_path: &std::path::Path) -> Option<FileIdentity> {
    None
}

impl Watcher {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            conn: None,
            version: None,
            cursor: None,
            identity: None,
            ticks_since_check: 0,
            replaced: false,
        }
    }

    /// Every `IDENTITY_CHECK_EVERY` ticks: has the file under the open connection gone away
    /// or been replaced? (On Windows, always "yes" — a blind periodic re-open.)
    fn file_changed_under_us(&mut self) -> bool {
        self.ticks_since_check += 1;
        if self.ticks_since_check < IDENTITY_CHECK_EVERY {
            return false;
        }
        self.ticks_since_check = 0;
        if cfg!(unix) {
            let now = file_identity(&self.path);
            now.is_none() || now != self.identity
        } else {
            true
        }
    }

    pub fn tick(&mut self) -> Tick {
        if self.conn.is_some() && self.file_changed_under_us() {
            self.conn = None;
            // A blind Windows re-open is not evidence of a change; a moved inode is.
            self.replaced |= cfg!(unix);
        }
        if self.conn.is_none() {
            self.conn = crate::continuity_read::open_ro(&self.path);
            self.version = None;
            self.identity = file_identity(&self.path);
            self.ticks_since_check = 0;
        }
        let Some(conn) = self.conn.as_ref() else {
            return Tick::Unavailable;
        };
        let version = match conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0)) {
            Ok(v) => v,
            Err(_) => {
                self.conn = None;
                return Tick::Unavailable;
            }
        };
        let Some(prev) = self.version.replace(version) else {
            // First look: baseline the cursor at "now" so history never pulses.
            let Some((at, id)) = self.cursor.clone() else {
                let now: String = conn
                    .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                        r.get(0)
                    })
                    .unwrap_or_default();
                self.cursor = Some((now, String::new()));
                return Tick::Unchanged;
            };
            // A re-open keeps the cursor: the new version is only a baseline, but a message
            // written past the cursor while we were away is still a pulse — never lost, and
            // never one from before the cursor.
            let replaced = std::mem::take(&mut self.replaced);
            return match read_messages_after(conn, &at, &id) {
                Ok(messages) => {
                    if let Some(last) = messages.last() {
                        self.cursor = Some((last.created_at.clone(), last.id.clone()));
                    }
                    if messages.is_empty() && !replaced {
                        Tick::Unchanged
                    } else {
                        Tick::Changed(ChangedPayload { messages })
                    }
                }
                Err(_) => {
                    self.conn = None;
                    self.replaced = replaced;
                    Tick::Unavailable
                }
            };
        };
        if prev == version {
            return Tick::Unchanged;
        }
        let (at, id) = self.cursor.clone().unwrap_or_default();
        match read_messages_after(conn, &at, &id) {
            Ok(messages) => {
                if let Some(last) = messages.last() {
                    self.cursor = Some((last.created_at.clone(), last.id.clone()));
                }
                Tick::Changed(ChangedPayload { messages })
            }
            Err(_) => {
                self.conn = None;
                Tick::Unavailable
            }
        }
    }
}

fn read_messages_after(
    conn: &rusqlite::Connection,
    at: &str,
    id: &str,
) -> rusqlite::Result<Vec<WatchedMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, from_agent_session_id, to_agent_session_id, kind, created_at FROM messages \
         WHERE created_at > ?1 OR (created_at = ?1 AND id > ?2) \
         ORDER BY created_at, id LIMIT ?3",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![at, id, MAX_MESSAGES_PER_TICK as i64],
        |r| {
            Ok(WatchedMessage {
                id: r.get(0)?,
                from: r.get(1)?,
                to: r.get(2)?,
                kind: r.get(3)?,
                created_at: r.get(4)?,
            })
        },
    )?;
    rows.collect()
}

/// Run forever on a background thread. Never writes, never panics the app.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut watcher = Watcher::new(crate::continuity_read::db_path());
        loop {
            match watcher.tick() {
                Tick::Changed(payload) => {
                    let _ = app.emit("continuity-changed", &payload);
                    std::thread::sleep(TICK);
                }
                Tick::Unchanged => std::thread::sleep(TICK),
                Tick::Unavailable => std::thread::sleep(RETRY),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuity_fixture::{insert_message, temp_db};

    #[test]
    fn first_tick_baselines_without_a_history_storm() {
        let path = temp_db("watch-baseline");
        let w = rusqlite::Connection::open(&path).unwrap();
        insert_message(&w, "old", "a", "b", "2000-01-01T00:00:00.000Z");
        let mut watcher = Watcher::new(path.clone());
        assert_eq!(watcher.tick(), Tick::Unchanged);
    }

    #[test]
    fn a_new_commit_reports_only_newer_messages() {
        let path = temp_db("watch-new");
        let mut watcher = Watcher::new(path.clone());
        assert_eq!(watcher.tick(), Tick::Unchanged);
        let w = rusqlite::Connection::open(&path).unwrap();
        insert_message(&w, "m1", "a", "b", "2999-01-01T00:00:00.000Z");
        insert_message(&w, "stale", "a", "b", "2000-01-01T00:00:00.000Z");
        match watcher.tick() {
            Tick::Changed(p) => {
                let ids: Vec<&str> = p.messages.iter().map(|m| m.id.as_str()).collect();
                assert_eq!(ids, vec!["m1"]);
                assert_eq!(p.messages[0].from, "a");
                assert_eq!(p.messages[0].to, "b");
            }
            other => panic!("expected Changed, got {other:?}"),
        }
        assert_eq!(watcher.tick(), Tick::Unchanged, "nothing new since");
    }

    #[test]
    fn a_commit_with_no_new_message_still_reports_a_change() {
        let path = temp_db("watch-other-table");
        let mut watcher = Watcher::new(path.clone());
        watcher.tick();
        let w = rusqlite::Connection::open(&path).unwrap();
        w.execute(
            "INSERT INTO decisions (id, decision_key, content, created_at) VALUES ('d','k','c','t')",
            [],
        )
        .unwrap();
        assert_eq!(
            watcher.tick(),
            Tick::Changed(ChangedPayload { messages: vec![] })
        );
    }

    #[test]
    fn equal_timestamps_break_ties_by_id() {
        let path = temp_db("watch-tie");
        let mut watcher = Watcher::new(path.clone());
        watcher.tick();
        let w = rusqlite::Connection::open(&path).unwrap();
        insert_message(&w, "a1", "x", "y", "2999-01-01T00:00:00.000Z");
        let Tick::Changed(first) = watcher.tick() else {
            panic!()
        };
        assert_eq!(first.messages.len(), 1);
        insert_message(&w, "a2", "x", "y", "2999-01-01T00:00:00.000Z");
        let Tick::Changed(second) = watcher.tick() else {
            panic!()
        };
        let ids: Vec<&str> = second.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["a2"], "same instant, later id, reported once");
    }

    #[test]
    fn a_missing_database_is_unavailable_then_recovers() {
        let path =
            std::env::temp_dir().join(format!("conduit-watch-missing-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut watcher = Watcher::new(path.clone());
        assert_eq!(watcher.tick(), Tick::Unavailable);
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(crate::continuity_fixture::DDL).unwrap();
        drop(c);
        assert_eq!(watcher.tick(), Tick::Unchanged, "re-opens and baselines");
        let _ = std::fs::remove_file(&path);
    }

    /// Tick until something other than Unchanged comes back, at most `n` times.
    fn tick_until_event(watcher: &mut Watcher, n: u32) -> Tick {
        for _ in 0..n {
            match watcher.tick() {
                Tick::Unchanged => continue,
                other => return other,
            }
        }
        Tick::Unchanged
    }

    #[test]
    fn an_identity_check_on_an_unchanged_file_emits_nothing() {
        let path = temp_db("watch-steady");
        let mut watcher = Watcher::new(path.clone());
        assert_eq!(watcher.tick(), Tick::Unchanged);
        assert_eq!(
            tick_until_event(&mut watcher, IDENTITY_CHECK_EVERY * 3 + 2),
            Tick::Unchanged,
            "a check (or a periodic re-open) must not pulse or refetch on its own"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_database_is_reopened_and_its_new_messages_reported() {
        let path = temp_db("watch-replace");
        let mut watcher = Watcher::new(path.clone());
        assert_eq!(watcher.tick(), Tick::Unchanged);
        // Write a brand-new DB beside it and rename it over the watched path: the watcher's
        // open connection still holds the old, now-unlinked inode.
        let fresh = path.with_extension("fresh.db");
        let _ = std::fs::remove_file(&fresh);
        let c = rusqlite::Connection::open(&fresh).unwrap();
        c.execute_batch(crate::continuity_fixture::DDL).unwrap();
        drop(c);
        for suffix in ["-wal", "-shm"] {
            let mut side = path.clone().into_os_string();
            side.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(side));
        }
        std::fs::rename(&fresh, &path).unwrap();
        let w = rusqlite::Connection::open(&path).unwrap();
        insert_message(&w, "after-swap", "a", "b", "2999-01-01T00:00:00.000Z");
        drop(w);
        match tick_until_event(&mut watcher, IDENTITY_CHECK_EVERY + 2) {
            Tick::Changed(p) => {
                let ids: Vec<&str> = p.messages.iter().map(|m| m.id.as_str()).collect();
                assert_eq!(ids, vec!["after-swap"]);
            }
            other => panic!("expected Changed after the swap, got {other:?}"),
        }
        assert_eq!(
            tick_until_event(&mut watcher, IDENTITY_CHECK_EVERY + 2),
            Tick::Unchanged,
            "the cursor survived the re-open: the message is not reported twice"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn a_deleted_database_goes_unavailable_and_recovers_with_its_cursor() {
        let path = temp_db("watch-delete");
        let mut watcher = Watcher::new(path.clone());
        assert_eq!(watcher.tick(), Tick::Unchanged);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            tick_until_event(&mut watcher, IDENTITY_CHECK_EVERY + 2),
            Tick::Unavailable
        );
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(crate::continuity_fixture::DDL).unwrap();
        insert_message(&c, "old", "a", "b", "2000-01-01T00:00:00.000Z");
        insert_message(&c, "new", "a", "b", "2999-01-01T00:00:00.000Z");
        drop(c);
        match watcher.tick() {
            Tick::Changed(p) => {
                let ids: Vec<&str> = p.messages.iter().map(|m| m.id.as_str()).collect();
                assert_eq!(ids, vec!["new"], "history before the cursor never pulses");
            }
            other => panic!("expected Changed on recovery, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn schema_drift_is_unavailable_not_a_panic() {
        let path =
            std::env::temp_dir().join(format!("conduit-watch-drift-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE messages (nope TEXT);")
            .unwrap();
        drop(c);
        let mut watcher = Watcher::new(path.clone());
        watcher.tick();
        let w = rusqlite::Connection::open(&path).unwrap();
        w.execute("INSERT INTO messages (nope) VALUES ('x')", [])
            .unwrap();
        assert_eq!(watcher.tick(), Tick::Unavailable);
        let _ = std::fs::remove_file(&path);
    }
}
