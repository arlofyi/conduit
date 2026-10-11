//! The Continuity view's graph: which sessions are nodes, which pairs have talked, who has
//! questions waiting. Read-only; scoped by `continuity_feed::resolve_session_ids` (never a
//! wildcard — a cross-project leak is the failure that matters).

use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

const VISITOR_WINDOW: &str = "-10 minutes";
const EDGE_WINDOW: &str = "-24 hours";

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conduit_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuity_id: Option<String>,
    pub label: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    pub visitor: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visitor_project_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub a: String,
    pub b: String,
    pub count: u32,
    pub last_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshot {
    pub available: bool,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub unanswered: BTreeMap<String, u32>,
}

struct Row {
    id: String,
    label: String,
    status: String,
    focus: Option<String>,
    last_seen: String,
    cwd_hash: String,
}

fn conduit_only(project_sessions: &[String]) -> Vec<GraphNode> {
    project_sessions
        .iter()
        .map(|id| GraphNode {
            key: id.clone(),
            conduit_session_id: Some(id.clone()),
            label: id.clone(),
            status: "none".into(),
            ..Default::default()
        })
        .collect()
}

/// `project_sessions` is `(conduit session id, worktree path if any)`. The worktree path lets a
/// row written before continuity identity crossed tmux (unsalted `cwd_hash` of the worktree,
/// default label) fold into its Conduit session instead of becoming a second node.
pub fn graph_from_db(
    path: &std::path::Path,
    project_sessions: &[(String, Option<String>)],
    toplevels: &[String],
    foreign_sessions: &HashMap<String, String>,
) -> GraphSnapshot {
    let ids: Vec<String> = project_sessions.iter().map(|(id, _)| id.clone()).collect();
    let unavailable = || GraphSnapshot {
        nodes: conduit_only(&ids),
        ..Default::default()
    };
    let Some(conn) = crate::continuity_read::open_ro(path) else {
        return unavailable();
    };
    if !crate::continuity_feed::probe(&conn) {
        return unavailable();
    }
    read(&conn, project_sessions, toplevels, foreign_sessions).unwrap_or_else(|_| unavailable())
}

fn rows_by_id(conn: &rusqlite::Connection, ids: &[String]) -> rusqlite::Result<Vec<Row>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let sql = format!(
        "SELECT id, agent_label, status, current_focus, last_seen_at, cwd_hash FROM agent_sessions WHERE id IN ({})",
        crate::continuity_feed::placeholders(ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids), |r| {
        Ok(Row {
            id: r.get(0)?,
            label: r.get(1)?,
            status: r.get(2)?,
            focus: r.get(3)?,
            last_seen: r.get(4)?,
            cwd_hash: r.get(5)?,
        })
    })?;
    rows.collect()
}

fn read(
    conn: &rusqlite::Connection,
    sessions: &[(String, Option<String>)],
    toplevels: &[String],
    foreign_sessions: &HashMap<String, String>,
) -> rusqlite::Result<GraphSnapshot> {
    let project_sessions: &[String] = &sessions
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    // worktree cwd_hash -> the one Conduit session that owns it. A hash two sessions share
    // is ambiguous and is dropped (the row then stays its own node).
    let mut owners: HashMap<String, Vec<&str>> = HashMap::new();
    for (id, wt) in sessions {
        if let Some(wt) = wt {
            owners
                .entry(crate::continuity_feed::cwd_hash_of(wt))
                .or_default()
                .push(id.as_str());
        }
    }
    let worktree_owner: HashMap<String, String> = owners
        .into_iter()
        .filter(|(_, v)| v.len() == 1)
        .map(|(h, v)| (h, v[0].to_string()))
        .collect();
    let scope = crate::continuity_feed::resolve_session_ids(conn, project_sessions, toplevels);
    let in_scope: HashSet<&str> = scope.iter().map(String::as_str).collect();
    let own: HashSet<&str> = project_sessions.iter().map(String::as_str).collect();

    // continuity id -> node key, for every in-scope row (gone ones included, so an old row's
    // messages fold into its Conduit session's node).
    let mut key_of: HashMap<String, String> = HashMap::new();
    let mut nodes: BTreeMap<String, GraphNode> = conduit_only(project_sessions)
        .into_iter()
        .map(|n| (n.key.clone(), n))
        .collect();
    let mut freshest: HashMap<String, (bool, String)> = HashMap::new(); // node key -> last_seen of the row shown
    for row in rows_by_id(conn, &scope)? {
        let owner: Option<String> = if own.contains(row.label.as_str()) {
            Some(row.label.clone())
        } else {
            worktree_owner.get(&row.cwd_hash).cloned()
        };
        if let Some(owner) = owner {
            key_of.insert(row.id.clone(), owner.clone());
            // A live row outranks a gone one (a restart leaves the old row behind), then the
            // later last_seen wins.
            let rank = (row.status != "gone", row.last_seen.clone());
            let newer = freshest.get(&owner).is_none_or(|seen| rank > *seen);
            if newer {
                freshest.insert(owner.clone(), rank);
                if let Some(n) = nodes.get_mut(&owner) {
                    n.continuity_id = Some(row.id.clone());
                    n.status = row.status.clone();
                    n.focus = row.focus.clone();
                    n.last_seen_at = Some(row.last_seen.clone());
                }
            }
        } else {
            key_of.insert(row.id.clone(), row.id.clone());
            if row.status == "active" || row.status == "idle" {
                nodes.insert(
                    row.id.clone(),
                    GraphNode {
                        key: row.id.clone(),
                        continuity_id: Some(row.id.clone()),
                        label: row.label.clone(),
                        status: row.status.clone(),
                        focus: row.focus.clone(),
                        last_seen_at: Some(row.last_seen.clone()),
                        ..Default::default()
                    },
                );
            }
        }
    }

    // Messages touching the scope within 24 h (one query; visitor/edge/unanswered split in memory).
    let ph = crate::continuity_feed::placeholders(scope.len());
    let sql = format!(
        "SELECT from_agent_session_id, to_agent_session_id, created_at, requires_response, status, \
                created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now', '{VISITOR_WINDOW}') \
         FROM messages \
         WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now', '{EDGE_WINDOW}') \
           AND (from_agent_session_id IN ({ph}) OR to_agent_session_id IN ({ph}))"
    );
    let params: Vec<&String> = scope.iter().chain(scope.iter()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let msgs: Vec<(String, String, String, bool, String, bool)> = stmt
        .query_map(rusqlite::params_from_iter(params), |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get::<_, i64>(3)? != 0,
                r.get(4)?,
                r.get::<_, i64>(5)? != 0,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;

    // Visitors: out-of-scope endpoints of a recent message.
    let visitor_ids: Vec<String> = msgs
        .iter()
        .filter(|m| m.5)
        .flat_map(|m| [m.0.clone(), m.1.clone()])
        .filter(|id| !in_scope.contains(id.as_str()))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    for row in rows_by_id(conn, &visitor_ids)? {
        let other_project = foreign_sessions.get(&row.label).cloned();
        key_of.insert(row.id.clone(), row.id.clone());
        nodes.insert(
            row.id.clone(),
            GraphNode {
                key: row.id.clone(),
                conduit_session_id: other_project.as_ref().map(|_| row.label.clone()),
                continuity_id: Some(row.id.clone()),
                label: row.label.clone(),
                status: row.status.clone(),
                focus: row.focus.clone(),
                last_seen_at: Some(row.last_seen.clone()),
                visitor: true,
                visitor_project_id: other_project,
            },
        );
    }

    let mut edges: BTreeMap<(String, String), GraphEdge> = BTreeMap::new();
    let mut unanswered: BTreeMap<String, u32> = BTreeMap::new();
    for (from, to, created, ask, status, _recent) in &msgs {
        let (Some(fa), Some(tb)) = (key_of.get(from), key_of.get(to)) else {
            continue;
        };
        if *ask && status == "pending" && nodes.contains_key(tb) {
            *unanswered.entry(tb.clone()).or_default() += 1;
        }
        if fa == tb || !nodes.contains_key(fa) || !nodes.contains_key(tb) {
            continue;
        }
        let (a, b) = if fa < tb {
            (fa.clone(), tb.clone())
        } else {
            (tb.clone(), fa.clone())
        };
        let e = edges.entry((a.clone(), b.clone())).or_insert(GraphEdge {
            a,
            b,
            count: 0,
            last_at: String::new(),
        });
        e.count += 1;
        if *created > e.last_at {
            e.last_at = created.clone();
        }
    }

    Ok(GraphSnapshot {
        available: true,
        nodes: nodes.into_values().collect(),
        edges: edges.into_values().collect(),
        unanswered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuity_fixture::temp_db;
    use std::collections::HashMap;

    fn session(conn: &rusqlite::Connection, id: &str, label: &str, hash: &str, status: &str) {
        conn.execute(
            "INSERT INTO agent_sessions (id, agent_label, cwd_hash, status, current_focus, started_at, last_seen_at) \
             VALUES (?1, ?2, ?3, ?4, 'focus', '2026-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            rusqlite::params![id, label, hash, status],
        )
        .unwrap();
    }
    fn msg(conn: &rusqlite::Connection, id: &str, from: &str, to: &str, ago_min: i64, ask: bool) {
        conn.execute(
            "INSERT INTO messages (id, from_agent_session_id, to_agent_session_id, kind, body, requires_response, created_at, expires_at) \
             VALUES (?1, ?2, ?3, 'message', 'b', ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?5), '2999-01-01T00:00:00.000Z')",
            rusqlite::params![id, from, to, ask as i64, format!("-{ago_min} minutes")],
        )
        .unwrap();
    }

    /// Project P has Conduit sessions cs-1, cs-2 (cs-2 never checked in). Plus:
    ///   c-1  -> cs-1's continuity row        c-1old -> cs-1's previous row (gone)
    ///   c-cli -> plain CLI in P's checkout   c-gone -> CLI in P's checkout, gone
    ///   c-vis -> other project's Conduit session os-9 (messaged 3 min ago)
    ///   c-old -> stranger who messaged 30 min ago (visitor window expired)
    #[allow(clippy::type_complexity)]
    fn fixture() -> (
        std::path::PathBuf,
        Vec<(String, Option<String>)>,
        Vec<String>,
        HashMap<String, String>,
    ) {
        let path = temp_db("graph");
        let c = rusqlite::Connection::open(&path).unwrap();
        let mine = crate::continuity_feed::cwd_hash_of("/repo/p");
        session(&c, "c-1", "cs-1", "salted", "active");
        session(&c, "c-1old", "cs-1", "salted2", "gone");
        session(&c, "c-cli", "root-abc", &mine, "idle");
        session(&c, "c-gone", "root-def", &mine, "gone");
        session(&c, "c-vis", "os-9", "elsewhere", "active");
        session(&c, "c-old", "stranger", "elsewhere2", "active");
        msg(&c, "m1", "c-1", "c-cli", 5, false);
        msg(&c, "m2", "c-cli", "c-1old", 60, true); // old row of cs-1: same node; unanswered
        msg(&c, "m3", "c-vis", "c-1", 3, false);
        msg(&c, "m4", "c-old", "c-1", 30, false);
        msg(&c, "m5", "c-1", "c-cli", 60 * 30, false); // > 24 h: no edge weight
        let mut foreign = HashMap::new();
        foreign.insert("os-9".to_string(), "proj-other".to_string());
        (
            path,
            vec![("cs-1".into(), None), ("cs-2".into(), None)],
            vec!["/repo/p".into()],
            foreign,
        )
    }

    fn keys(s: &GraphSnapshot) -> Vec<String> {
        let mut k: Vec<String> = s.nodes.iter().map(|n| n.key.clone()).collect();
        k.sort();
        k
    }

    #[test]
    fn membership_follows_the_rules() {
        let (path, ids, tops, foreign) = fixture();
        let s = graph_from_db(&path, &ids, &tops, &foreign);
        assert!(s.available);
        assert_eq!(keys(&s), vec!["c-cli", "c-vis", "cs-1", "cs-2"]);
        let cs1 = s.nodes.iter().find(|n| n.key == "cs-1").unwrap();
        assert_eq!(
            cs1.continuity_id.as_deref(),
            Some("c-1"),
            "freshest row wins"
        );
        assert_eq!(cs1.status, "active");
        let cs2 = s.nodes.iter().find(|n| n.key == "cs-2").unwrap();
        assert_eq!(cs2.status, "none");
        assert!(!cs2.visitor);
        let vis = s.nodes.iter().find(|n| n.key == "c-vis").unwrap();
        assert!(vis.visitor);
        assert_eq!(vis.visitor_project_id.as_deref(), Some("proj-other"));
        assert_eq!(vis.conduit_session_id.as_deref(), Some("os-9"));
    }

    #[test]
    fn edges_are_undirected_within_24h_and_map_old_rows_to_their_node() {
        let (path, ids, tops, foreign) = fixture();
        let s = graph_from_db(&path, &ids, &tops, &foreign);
        let e = s
            .edges
            .iter()
            .find(|e| e.a == "c-cli" && e.b == "cs-1")
            .expect("cli<->cs-1");
        assert_eq!(
            e.count, 2,
            "m1 and m2 (old row folded in); m5 is older than 24 h"
        );
        assert!(s.edges.iter().any(|e| e.a == "c-vis" && e.b == "cs-1"));
        assert!(!s
            .edges
            .iter()
            .any(|e| e.a.contains("old") || e.b.contains("old")));
    }

    #[test]
    fn unanswered_counts_pending_questions_to_the_node() {
        let (path, ids, tops, foreign) = fixture();
        let s = graph_from_db(&path, &ids, &tops, &foreign);
        assert_eq!(s.unanswered.get("cs-1"), Some(&1));
        assert_eq!(s.unanswered.get("c-cli"), None);
    }

    #[test]
    fn no_database_is_unavailable_with_conduit_nodes_only() {
        let path = std::env::temp_dir().join("conduit-graph-absent-xyz.db");
        let _ = std::fs::remove_file(&path);
        let s = graph_from_db(&path, &[("cs-1".into(), None)], &[], &HashMap::new());
        assert!(!s.available);
        assert_eq!(
            keys(&s),
            vec!["cs-1"],
            "the project's own sessions still render"
        );
    }

    #[test]
    fn a_worktree_row_folds_into_its_conduit_session() {
        let path = temp_db("graph-fold");
        let c = rusqlite::Connection::open(&path).unwrap();
        let wt = "/repo/p/.wt/w";
        session(
            &c,
            "c-w",
            "repo-abc123",
            &crate::continuity_feed::cwd_hash_of(wt),
            "active",
        );
        session(&c, "c-x", "os-x", "elsewhere", "active");
        msg(&c, "m1", "c-w", "c-x", 2, false);
        let sessions = vec![("cs-w".to_string(), Some(wt.to_string()))];
        let mut foreign = HashMap::new();
        foreign.insert("os-x".to_string(), "proj-other".to_string());
        let s = graph_from_db(&path, &sessions, &[wt.to_string()], &foreign);
        assert_eq!(keys(&s), vec!["c-x", "cs-w"]);
        let n = s.nodes.iter().find(|n| n.key == "cs-w").unwrap();
        assert_eq!(n.continuity_id.as_deref(), Some("c-w"));
        assert_eq!(n.status, "active");
        assert!(s.edges.iter().any(|e| e.a == "c-x" && e.b == "cs-w"));
    }

    #[test]
    fn colliding_worktree_paths_do_not_fold() {
        let path = temp_db("graph-collide");
        let c = rusqlite::Connection::open(&path).unwrap();
        let wt = "/repo/p/.wt/w";
        session(
            &c,
            "c-w",
            "repo-abc123",
            &crate::continuity_feed::cwd_hash_of(wt),
            "active",
        );
        let sessions = vec![
            ("cs-a".to_string(), Some(wt.to_string())),
            ("cs-b".to_string(), Some(wt.to_string())),
        ];
        let s = graph_from_db(&path, &sessions, &[wt.to_string()], &HashMap::new());
        assert_eq!(keys(&s), vec!["c-w", "cs-a", "cs-b"]);
    }
}
