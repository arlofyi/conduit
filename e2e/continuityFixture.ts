import { execFileSync } from "node:child_process";

/**
 * Continuity's schema + writers for the e2e harness. DDL copied from
 * `src-tauri/src/continuity_fixture.rs` (which copied it from a real
 * `~/.continuity/continuity.db`). The app only ever READS this database; the specs are
 * the sole writer, through the `sqlite3` CLI.
 */
export const DDL = `
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
`;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function run(db: string, sql: string): void {
  // `.timeout` keeps a write from failing while the app's reader holds the file.
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", db, sql], { stdio: "pipe" });
}

/** Create the schema (WAL, like the real DB). */
export function createContinuityDb(db: string): void {
  run(db, `PRAGMA journal_mode=WAL;\n${DDL}`);
}

export function insertSession(
  db: string,
  s: { id: string; label: string; status?: string; cwdHash?: string; focus?: string },
): void {
  const now = new Date().toISOString();
  run(
    db,
    `INSERT INTO agent_sessions (id, agent_label, cwd_hash, status, current_focus, started_at, last_seen_at) VALUES (${q(s.id)}, ${q(s.label)}, ${q(s.cwdHash ?? "e2e-hash")}, ${q(s.status ?? "active")}, ${s.focus ? q(s.focus) : "NULL"}, ${q(now)}, ${q(now)});`,
  );
}

export function insertMessage(
  db: string,
  m: { id: string; from: string; to: string; createdAt?: string; body?: string },
): void {
  run(
    db,
    `INSERT INTO messages (id, from_agent_session_id, to_agent_session_id, kind, body, created_at, expires_at) VALUES (${q(m.id)}, ${q(m.from)}, ${q(m.to)}, 'message', ${q(m.body ?? "hello")}, ${q(m.createdAt ?? new Date().toISOString())}, '2999-01-01T00:00:00.000Z');`,
  );
}
