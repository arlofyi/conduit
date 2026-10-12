//! Continuity's DDL for every table Conduit reads, for tests only. Column names and CHECK
//! lists copied from `~/.continuity/continuity.db`'s `.schema` (2026-10-12); indexes omitted
//! — they change no read result. The older fixtures in continuity_feed.rs/continuity_read.rs
//! keep their own copies; new modules use this one.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const DDL: &str = "
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY, agent_label TEXT NOT NULL, cwd_hash TEXT NOT NULL, project_scope TEXT,
  current_focus TEXT, claimed_issue_number INTEGER, claimed_repo_full_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','gone')),
  started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, from_agent_session_id TEXT NOT NULL, to_agent_session_id TEXT NOT NULL,
  repo_full_name TEXT, kind TEXT NOT NULL CHECK (kind IN ('message','collision','decision')),
  body TEXT NOT NULL, requires_response INTEGER NOT NULL DEFAULT 0, related_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','responded','dismissed')),
  response TEXT, created_at TEXT NOT NULL, responded_at TEXT, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, decision_key TEXT NOT NULL, content TEXT NOT NULL,
  decision_type TEXT NOT NULL DEFAULT 'other' CHECK (decision_type IN ('architecture','tooling','process','scope','other')),
  project_scope TEXT, author_agent_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','superseded','rejected')),
  supersedes TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, from_agent_session_id TEXT NOT NULL, to_agent_session_id TEXT,
  project_scope TEXT, context TEXT NOT NULL, state TEXT, suggested_next_actions TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','completed','expired')),
  created_at TEXT NOT NULL, accepted_at TEXT, completed_at TEXT);
CREATE TABLE IF NOT EXISTS task_claims (
  id TEXT PRIMARY KEY, repo_full_name TEXT NOT NULL, issue_number INTEGER NOT NULL,
  claimed_by_agent_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','in_progress','pr_open','released','completed')),
  pr_number INTEGER, notes TEXT, claimed_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS file_activity (
  id TEXT PRIMARY KEY, agent_session_id TEXT NOT NULL, file_path TEXT NOT NULL, repo_full_name TEXT,
  tool TEXT NOT NULL CHECK (tool IN ('Write','Edit','MultiEdit','NotebookEdit')), touched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, agent_session_id TEXT, payload TEXT, created_at TEXT NOT NULL);
";

/// A fresh, schema-loaded DB path (pid + counter; the caller owns cleanup).
pub fn temp_db(tag: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "conduit-continuity-fixture-{}-{}-{}.db",
        std::process::id(),
        tag,
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let conn = rusqlite::Connection::open(&path).expect("open fixture");
    conn.execute_batch("PRAGMA journal_mode=WAL;").expect("wal");
    conn.execute_batch(DDL).expect("ddl");
    path
}

/// Insert a message (writer connection — the watcher only ever reads).
pub fn insert_message(conn: &rusqlite::Connection, id: &str, from: &str, to: &str, created: &str) {
    conn.execute(
        "INSERT INTO messages (id, from_agent_session_id, to_agent_session_id, kind, body, created_at, expires_at) \
         VALUES (?1, ?2, ?3, 'message', 'b', ?4, '2999-01-01T00:00:00.000Z')",
        rusqlite::params![id, from, to, created],
    )
    .expect("insert message");
}
