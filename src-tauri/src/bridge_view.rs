//! Pure builders for what the mobile bridge tells a phone about the project tree and the
//! attached session. Kept free of `AppHandle` so every shape is unit-tested.
//!
//! The `projects` frame is a WHITELIST, never a dump of `Project`: those structs carry
//! `seedMemory`, `accountId`, filesystem paths, layouts and routes, none of which a phone
//! needs and some of which must not leave the Mac.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::asks::AskView;
use crate::context_window::ContextUsage;
use crate::fleet::FleetStatus;
use crate::store::{Profile, Project};

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

/// The `projects` frame.
pub fn projects_view(
    projects: &[Project],
    profiles: &[Profile],
    active_profile: Option<&str>,
    fleet: &HashMap<String, FleetStatus>,
    running: &HashSet<String>,
    asks: &[AskView],
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
        projects_view(p, &[], None, fleet, &HashSet::new(), asks)
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
        );
        assert_eq!(v["type"], "projects");
        assert_eq!(v["profiles"][0], json!({ "id": null, "name": "Default" }));
        assert_eq!(v["profiles"][1], json!({ "id": "w", "name": "Work" }));
        assert_eq!(v["activeProfileId"], "w");
        let none = projects_view(&[], &[], None, &HashMap::new(), &HashSet::new(), &[]);
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
