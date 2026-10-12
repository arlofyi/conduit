//! Read-only, project-scoped table reads for the Continuity view's Decisions / Handoffs /
//! Tasks / Files / Activity tabs. Scope is `continuity_feed::resolve_session_ids` (label arm
//! plus toplevel-hash arm, never a wildcard); Conduit never writes this database. Rows carry
//! continuity ids -- the frontend maps them to nodes.

use serde::Serialize;
use serde_json::{json, Value};

use crate::continuity_feed::{placeholders, probe, read_decisions, resolve_session_ids};

const ROW_LIMIT: usize = 200;
/// Server-side cap on free text (`context`, `payload`) so one huge row cannot bloat the IPC.
const TEXT_CAP: usize = 2048;

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TablesView {
    pub available: bool,
    pub tab: String,
    pub rows: Vec<Value>,
}

/// Cut `s` to at most `max` bytes, backing up to a char boundary.
fn truncate(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

fn read_handoffs(conn: &rusqlite::Connection, scope: &[String]) -> rusqlite::Result<Vec<Value>> {
    let ph = placeholders(scope.len());
    let sql = format!(
        "SELECT id, from_agent_session_id, to_agent_session_id, status, context, \
         suggested_next_actions, created_at FROM handoffs \
         WHERE from_agent_session_id IN ({ph}) OR to_agent_session_id IN ({ph}) \
         ORDER BY created_at DESC LIMIT {ROW_LIMIT}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(scope.iter().chain(scope.iter())),
        |r| {
            let mut v = json!({
                "id": r.get::<_, String>(0)?,
                "from": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(3)?,
                "context": truncate(r.get::<_, String>(4)?, TEXT_CAP),
                "createdAt": r.get::<_, String>(6)?,
            });
            if let Some(to) = r.get::<_, Option<String>>(2)? {
                v["to"] = json!(to);
            }
            if let Some(n) = r.get::<_, Option<String>>(5)? {
                v["nextActions"] = json!(truncate(n, TEXT_CAP));
            }
            Ok(v)
        },
    )?;
    rows.collect()
}

fn read_tasks(conn: &rusqlite::Connection, scope: &[String]) -> rusqlite::Result<Vec<Value>> {
    let ph = placeholders(scope.len());
    let sql = format!(
        "SELECT id, repo_full_name, issue_number, status, claimed_by_agent_session_id, \
         pr_number, expires_at, last_activity_at FROM task_claims \
         WHERE claimed_by_agent_session_id IN ({ph}) \
         ORDER BY last_activity_at DESC LIMIT {ROW_LIMIT}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(scope.iter()), |r| {
        let mut v = json!({
            "id": r.get::<_, String>(0)?,
            "repo": r.get::<_, String>(1)?,
            "issue": r.get::<_, i64>(2)?,
            "status": r.get::<_, String>(3)?,
            "expiresAt": r.get::<_, String>(6)?,
            "lastActivityAt": r.get::<_, String>(7)?,
        });
        if let Some(c) = r.get::<_, Option<String>>(4)? {
            v["claimant"] = json!(c);
        }
        if let Some(p) = r.get::<_, Option<i64>>(5)? {
            v["pr"] = json!(p);
        }
        Ok(v)
    })?;
    rows.collect()
}

fn read_files(conn: &rusqlite::Connection, scope: &[String]) -> rusqlite::Result<Vec<Value>> {
    let ph = placeholders(scope.len());
    let sql = format!(
        "SELECT file_path, agent_session_id, tool, touched_at FROM file_activity \
         WHERE agent_session_id IN ({ph}) \
         AND touched_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') \
         ORDER BY touched_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(scope.iter()), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    // (path, sessions, tools, touchedAt); newest-first input keeps first-seen = newest.
    let mut groups: Vec<(String, Vec<String>, Vec<String>, String)> = Vec::new();
    for row in rows {
        let (path, session, tool, at) = row?;
        match groups.iter_mut().find(|g| g.0 == path) {
            Some(g) => {
                if !g.1.contains(&session) {
                    g.1.push(session);
                }
                if !g.2.contains(&tool) {
                    g.2.push(tool);
                }
            }
            None => groups.push((path, vec![session], vec![tool], at)),
        }
    }
    Ok(groups
        .into_iter()
        .map(|(path, sessions, tools, at)| {
            json!({
                "path": path,
                "collision": sessions.len() >= 2,
                "sessions": sessions,
                "tools": tools,
                "touchedAt": at,
            })
        })
        .collect())
}

fn read_activity(conn: &rusqlite::Connection, scope: &[String]) -> rusqlite::Result<Vec<Value>> {
    let ph = placeholders(scope.len());
    let sql = format!(
        "SELECT id, event_type, agent_session_id, created_at, payload FROM audit_events \
         WHERE agent_session_id IN ({ph}) ORDER BY created_at DESC LIMIT {ROW_LIMIT}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(scope.iter()), |r| {
        let mut v = json!({
            "id": r.get::<_, String>(0)?,
            "type": r.get::<_, String>(1)?,
            "createdAt": r.get::<_, String>(3)?,
        });
        if let Some(s) = r.get::<_, Option<String>>(2)? {
            v["session"] = json!(s);
        }
        if let Some(p) = r.get::<_, Option<String>>(4)? {
            v["payload"] = json!(truncate(p, TEXT_CAP));
        }
        Ok(v)
    })?;
    rows.collect()
}

fn read_decision_rows(
    conn: &rusqlite::Connection,
    scope: &[String],
) -> rusqlite::Result<Vec<Value>> {
    Ok(read_decisions(conn, scope, ROW_LIMIT)?
        .into_iter()
        .map(|d| serde_json::to_value(d).unwrap_or(Value::Null))
        .collect())
}

/// One tab's rows for a project. Any failure (no DB, unprobed, drifted schema, unknown tab)
/// is `available: false` with no rows.
pub fn tables_from_db(
    path: &std::path::Path,
    project_sessions: &[String],
    toplevels: &[String],
    tab: &str,
) -> TablesView {
    let unavailable = || TablesView {
        available: false,
        tab: tab.to_string(),
        rows: vec![],
    };
    let Some(conn) = crate::continuity_read::open_ro(path) else {
        return unavailable();
    };
    if !probe(&conn) {
        return unavailable();
    }
    let scope = resolve_session_ids(&conn, project_sessions, toplevels);
    if scope.is_empty() {
        // Known tab, nothing in scope: available but empty.
        return match tab {
            "decisions" | "handoffs" | "tasks" | "files" | "activity" => TablesView {
                available: true,
                tab: tab.to_string(),
                rows: vec![],
            },
            _ => unavailable(),
        };
    }
    let rows = match tab {
        "decisions" => read_decision_rows(&conn, &scope),
        "handoffs" => read_handoffs(&conn, &scope),
        "tasks" => read_tasks(&conn, &scope),
        "files" => read_files(&conn, &scope),
        "activity" => read_activity(&conn, &scope),
        _ => return unavailable(),
    };
    match rows {
        Ok(rows) => TablesView {
            available: true,
            tab: tab.to_string(),
            rows,
        },
        Err(_) => unavailable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuity_fixture::temp_db;
    use rusqlite::params;

    fn session(c: &rusqlite::Connection, id: &str, label: &str) {
        c.execute(
            "INSERT INTO agent_sessions (id, agent_label, cwd_hash, status, started_at, last_seen_at) \
             VALUES (?1, ?2, 'h-' || ?1, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![id, label],
        )
        .unwrap();
    }

    /// cs-1 and cs-2 belong to the project (continuity rows c-1, c-2); c-out is a stranger.
    fn fixture(tag: &str) -> (std::path::PathBuf, rusqlite::Connection, Vec<String>) {
        let path = temp_db(tag);
        let c = rusqlite::Connection::open(&path).unwrap();
        session(&c, "c-1", "cs-1");
        session(&c, "c-2", "cs-2");
        session(&c, "c-out", "stranger");
        (path, c, vec!["cs-1".into(), "cs-2".into()])
    }

    fn ids(v: &TablesView, key: &str) -> Vec<String> {
        v.rows
            .iter()
            .map(|r| r[key].as_str().unwrap().to_string())
            .collect()
    }

    fn ago(min: i64) -> String {
        format!("-{min} minutes")
    }

    #[test]
    fn decisions_tab_returns_only_in_scope_authors() {
        let (path, c, mine) = fixture("tbl-dec");
        for (id, author) in [("d-in", "c-1"), ("d-out", "c-out")] {
            c.execute(
                "INSERT INTO decisions (id, decision_key, content, author_agent_session_id, created_at) \
                 VALUES (?1, ?1, 'x', ?2, '2026-01-02T00:00:00.000Z')",
                params![id, author],
            )
            .unwrap();
        }
        let v = tables_from_db(&path, &mine, &[], "decisions");
        assert!(v.available);
        assert_eq!(ids(&v, "id"), vec!["d-in"]);
        assert_eq!(v.rows[0]["decisionKey"], "d-in");
    }

    #[test]
    fn handoffs_tab_matches_from_or_to_and_truncates_context() {
        let (path, c, mine) = fixture("tbl-hand");
        let big = "é".repeat(3000); // 6000 bytes, 2-byte chars: the cap must land on a boundary
        for (id, from, to, ctx) in [
            ("h-from", "c-1", None, big.as_str()),
            ("h-to", "c-out", Some("c-2"), "ctx"),
            ("h-out", "c-out", Some("c-out"), "ctx"),
        ] {
            c.execute(
                "INSERT INTO handoffs (id, from_agent_session_id, to_agent_session_id, context, \
                 suggested_next_actions, created_at) VALUES (?1, ?2, ?3, ?4, 'do it', '2026-01-02T00:00:00.000Z')",
                params![id, from, to, ctx],
            )
            .unwrap();
        }
        let v = tables_from_db(&path, &mine, &[], "handoffs");
        let mut got = ids(&v, "id");
        got.sort();
        assert_eq!(got, vec!["h-from", "h-to"]);
        let from_row = v.rows.iter().find(|r| r["id"] == "h-from").unwrap();
        assert!(from_row.get("to").is_none());
        assert_eq!(from_row["from"], "c-1");
        assert_eq!(from_row["nextActions"], "do it");
        assert_eq!(from_row["status"], "pending");
        assert_eq!(from_row["context"].as_str().unwrap().len(), TEXT_CAP);
        let to_row = v.rows.iter().find(|r| r["id"] == "h-to").unwrap();
        assert_eq!(to_row["to"], "c-2");
    }

    #[test]
    fn tasks_tab_scopes_by_claimant() {
        let (path, c, mine) = fixture("tbl-task");
        for (id, claimant, pr) in [
            ("t-in", Some("c-1"), Some(7)),
            ("t-out", Some("c-out"), None),
        ] {
            c.execute(
                "INSERT INTO task_claims (id, repo_full_name, issue_number, claimed_by_agent_session_id, \
                 pr_number, claimed_at, last_activity_at, expires_at) \
                 VALUES (?1, 'o/r', 42, ?2, ?3, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2999-01-01T00:00:00.000Z')",
                params![id, claimant, pr],
            )
            .unwrap();
        }
        let v = tables_from_db(&path, &mine, &[], "tasks");
        assert_eq!(ids(&v, "id"), vec!["t-in"]);
        let r = &v.rows[0];
        assert_eq!(r["repo"], "o/r");
        assert_eq!(r["issue"], 42);
        assert_eq!(r["claimant"], "c-1");
        assert_eq!(r["pr"], 7);
        assert_eq!(r["status"], "claimed");
    }

    fn touch(c: &rusqlite::Connection, id: &str, session: &str, path: &str, tool: &str, min: i64) {
        c.execute(
            "INSERT INTO file_activity (id, agent_session_id, file_path, tool, touched_at) \
             VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?5))",
            params![id, session, path, tool, ago(min)],
        )
        .unwrap();
    }

    #[test]
    fn files_groups_by_path_and_flags_collisions() {
        let (path, c, mine) = fixture("tbl-files");
        touch(&c, "f1", "c-1", "src/a.ts", "Edit", 5);
        touch(&c, "f2", "c-2", "src/a.ts", "Write", 2);
        touch(&c, "f3", "c-1", "src/b.ts", "Edit", 120); // outside the 30 min window
        touch(&c, "f4", "c-out", "src/c.ts", "Edit", 1); // out of scope
        touch(&c, "f5", "c-1", "src/d.ts", "Edit", 3); // single session: no collision
        let v = tables_from_db(&path, &mine, &[], "files");
        assert!(v.available);
        let mut paths = ids(&v, "path");
        paths.sort();
        assert_eq!(paths, vec!["src/a.ts", "src/d.ts"]);
        let a = v.rows.iter().find(|r| r["path"] == "src/a.ts").unwrap();
        assert_eq!(a["collision"], true);
        assert_eq!(a["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(a["tools"].as_array().unwrap().len(), 2);
        let d = v.rows.iter().find(|r| r["path"] == "src/d.ts").unwrap();
        assert_eq!(d["collision"], false);
    }

    #[test]
    fn activity_tab_scopes_and_truncates_payload() {
        let (path, c, mine) = fixture("tbl-act");
        let big = "x".repeat(5000);
        for (id, s, payload) in [
            ("a-in", Some("c-1"), Some(big.as_str())),
            ("a-bare", Some("c-2"), None),
            ("a-out", Some("c-out"), Some("p")),
            ("a-none", None, Some("p")),
        ] {
            c.execute(
                "INSERT INTO audit_events (id, event_type, agent_session_id, payload, created_at) \
                 VALUES (?1, 'evt', ?2, ?3, '2026-01-02T00:00:00.000Z')",
                params![id, s, payload],
            )
            .unwrap();
        }
        let v = tables_from_db(&path, &mine, &[], "activity");
        let mut got = ids(&v, "id");
        got.sort();
        assert_eq!(got, vec!["a-bare", "a-in"]);
        let r = v.rows.iter().find(|r| r["id"] == "a-in").unwrap();
        assert_eq!(r["type"], "evt");
        assert_eq!(r["session"], "c-1");
        assert_eq!(r["payload"].as_str().unwrap().len(), TEXT_CAP);
        let bare = v.rows.iter().find(|r| r["id"] == "a-bare").unwrap();
        assert!(bare.get("payload").is_none());
    }

    #[test]
    fn toplevel_arm_is_included_in_scope() {
        let (path, c, _) = fixture("tbl-top");
        let top = "/repo/p";
        c.execute(
            "INSERT INTO agent_sessions (id, agent_label, cwd_hash, status, started_at, last_seen_at) \
             VALUES ('c-cli', 'root-x', ?1, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![crate::continuity_feed::cwd_hash_of(top)],
        )
        .unwrap();
        touch(&c, "f1", "c-cli", "src/a.ts", "Edit", 1);
        let v = tables_from_db(&path, &[], &[top.to_string()], "files");
        assert_eq!(ids(&v, "path"), vec!["src/a.ts"]);
    }

    #[test]
    fn unknown_tab_is_unavailable() {
        let (path, _c, mine) = fixture("tbl-unk");
        let v = tables_from_db(&path, &mine, &[], "nonsense");
        assert!(!v.available);
        assert!(v.rows.is_empty());
        assert_eq!(v.tab, "nonsense");
    }
}
