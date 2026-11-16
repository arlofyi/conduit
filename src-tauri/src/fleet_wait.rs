//! `fleet_wait`: a Conductor blocks until its workers stop running, instead of polling
//! `fleet_list` or sleeping.
//!
//! The fleet MCP server runs one thread per request, so a blocked wait holds only its own
//! thread. It sleeps on `FleetState`'s change counter, which every status change and every
//! posted result bumps.

use crate::board::{BoardKind, BoardState};
use crate::fleet::FleetState;
use crate::pty::PtyManager;
use crate::store::{SessionRole, Store};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// A timeout is a check-in, not a failure, so the default stays well inside any MCP
/// client's own tool-call limit.
pub const DEFAULT_TIMEOUT_SECS: u64 = 50;
pub const MAX_TIMEOUT_SECS: u64 = 600;
/// A worker that has a terminal but has never reported is still starting up. Without this
/// a `fleet_wait` called right after `fleet_spawn` would see "idle" and return at once.
/// Bounded, because some agents never report at all.
pub const STARTUP_GRACE: Duration = Duration::from_secs(30);
/// The longest one sleep lasts, so the startup grace running out is noticed.
const TICK: Duration = Duration::from_secs(1);

#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    pub ids: Option<Vec<String>>,
    /// `any`: return on the first worker to stop or post a result. Otherwise all.
    pub any: bool,
    pub timeout: Duration,
}

pub fn parse_args(args: &Value) -> Result<Args, String> {
    let ids = match args.get("ids") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|v| v.as_str().map(str::to_string).ok_or("ids must be strings"))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Some(_) => return Err("ids must be an array of session ids".into()),
    };
    let any = match args.get("mode").and_then(Value::as_str) {
        None | Some("all") => false,
        Some("any") => true,
        Some(other) => {
            return Err(format!(
                "unknown mode {other:?}; expected \"all\" or \"any\""
            ))
        }
    };
    let secs = match args.get("timeoutSec") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_SECS,
        Some(v) => v
            .as_u64()
            .ok_or("timeoutSec must be a whole number of seconds")?,
    };
    Ok(Args {
        ids,
        any,
        timeout: Duration::from_secs(secs.clamp(1, MAX_TIMEOUT_SECS)),
    })
}

/// Blocks until the wait is over and returns what the Conductor reads.
///
/// `reason`: `settled` (no awaited worker is running), `changed` (mode `any`: one stopped
/// or posted a result while others still run), `timeout`, or `no-workers`.
pub fn wait(
    store: &Store,
    fleet: &FleetState,
    board: &BoardState,
    pty: &PtyManager,
    caller_id: &str,
    args: &Args,
    startup_grace: Duration,
) -> Result<Value, String> {
    let snap = store.fleet_snapshot(caller_id).ok_or("caller-not-found")?;
    let caller = snap
        .sessions
        .iter()
        .find(|s| s.id == caller_id)
        .ok_or("caller-not-found")?
        .clone();
    // Membership is decided once, against the caller's own project: an id from another
    // project is "not found", exactly as it is for fleet_peek and fleet_send.
    let targets: Vec<_> = match &args.ids {
        Some(ids) => {
            let mut out = Vec::new();
            for id in ids {
                if id == caller_id {
                    return Err("cannot-target-self".into());
                }
                let s = snap
                    .sessions
                    .iter()
                    .find(|s| &s.id == id)
                    .ok_or_else(|| format!("session-not-found: {id}"))?;
                out.push(s.clone());
            }
            out
        }
        None => snap
            .sessions
            .iter()
            .filter(|s| s.id != caller_id && s.role == SessionRole::Worker)
            .cloned()
            .collect(),
    };
    if targets.is_empty() {
        return Ok(json!({ "reason": "no-workers", "workers": [] }));
    }

    // Results the caller may read, counted per author. A siloed worker's result is not the
    // caller's to know about; its STATUS is, as it is in fleet_list.
    let result_counts = || -> HashMap<String, usize> {
        let mut counts = HashMap::new();
        for r in board.query(&snap.project_id, Some(BoardKind::Result)) {
            let readable = snap
                .sessions
                .iter()
                .find(|s| s.id == r.author_session)
                .is_some_and(|author| crate::store::can_read(&caller, author));
            if readable {
                *counts.entry(r.author_session).or_insert(0) += 1;
            }
        }
        counts
    };
    let baseline = result_counts();
    let started = Instant::now();
    let mut was_busy: Option<HashSet<String>> = None;

    loop {
        // Read the counter BEFORE the state, so a change in between wakes the sleep.
        let seen = fleet.change_count();
        let statuses = fleet.snapshot();
        let counts = result_counts();
        let starting = started.elapsed() < startup_grace;
        let mut busy_now = HashSet::new();
        let mut any_new_result = false;
        let workers: Vec<Value> = targets
            .iter()
            .map(|s| {
                let st = statuses.get(&s.id).cloned().unwrap_or_default();
                let never_reported = st.updated_at == 0;
                let busy = st.status == "running" || (never_reported && starting && pty.has(&s.id));
                if busy {
                    busy_now.insert(s.id.clone());
                }
                let have = counts.get(&s.id).copied().unwrap_or(0);
                let new_result = have > baseline.get(&s.id).copied().unwrap_or(0);
                any_new_result |= new_result;
                json!({
                    "id": s.id,
                    "name": s.name,
                    "status": if busy && st.status != "running" { "starting" } else { st.status.as_str() },
                    "failed": st.failed,
                    "hasResult": have > 0,
                    "newResult": new_result,
                })
            })
            .collect();
        let first = was_busy.get_or_insert_with(|| busy_now.clone());
        let one_stopped = first.iter().any(|id| !busy_now.contains(id));

        let reason = if busy_now.is_empty() {
            Some("settled")
        } else if args.any && (one_stopped || any_new_result) {
            Some("changed")
        } else if started.elapsed() >= args.timeout {
            Some("timeout")
        } else {
            None
        };
        if let Some(reason) = reason {
            return Ok(json!({ "reason": reason, "workers": workers }));
        }
        let left = args.timeout.saturating_sub(started.elapsed());
        fleet.wait_changed(seen, left.min(TICK));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::BoardRecord;
    use std::sync::Arc;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "conduit-fleet-wait-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    struct World {
        store: Arc<Store>,
        fleet: Arc<FleetState>,
        board: Arc<BoardState>,
        pty: Arc<PtyManager>,
        project: String,
        conductor: String,
        w1: String,
        w2: String,
    }

    fn world(tag: &str) -> World {
        let store = Store::for_test(&temp_dir(tag));
        let proj = store.add_project("/repo".into(), store.active_profile());
        let add = |name: &str, role| {
            store
                .add_session(
                    &proj.id,
                    name.into(),
                    false,
                    crate::agent::AgentId::Claude,
                    role,
                )
                .unwrap()
                .id
        };
        let conductor = add("Conductor", SessionRole::Conductor);
        let w1 = add("tests", SessionRole::Worker);
        let w2 = add("review", SessionRole::Worker);
        World {
            store: Arc::new(store),
            fleet: Arc::new(FleetState::default()),
            board: Arc::new(BoardState::default()),
            pty: Arc::new(PtyManager::new()),
            project: proj.id,
            conductor,
            w1,
            w2,
        }
    }

    impl World {
        fn wait(&self, args: Value) -> Result<Value, String> {
            self.wait_with_grace(args, Duration::ZERO)
        }
        fn wait_with_grace(&self, args: Value, grace: Duration) -> Result<Value, String> {
            wait(
                &self.store,
                &self.fleet,
                &self.board,
                &self.pty,
                &self.conductor,
                &parse_args(&args)?,
                grace,
            )
        }
        fn run(&self, id: &str) {
            self.fleet.record(id, "prompt", &json!({}));
        }
        fn stop(&self, id: &str) {
            self.fleet.record(id, "stop", &json!({}));
        }
        /// Runs `f` on another thread after `after`.
        fn later(
            &self,
            after: Duration,
            f: impl FnOnce(&World) + Send + 'static,
        ) -> std::thread::JoinHandle<()> {
            let w = World {
                store: self.store.clone(),
                fleet: self.fleet.clone(),
                board: self.board.clone(),
                pty: self.pty.clone(),
                project: self.project.clone(),
                conductor: self.conductor.clone(),
                w1: self.w1.clone(),
                w2: self.w2.clone(),
            };
            std::thread::spawn(move || {
                std::thread::sleep(after);
                f(&w)
            })
        }
    }

    fn worker<'a>(out: &'a Value, id: &str) -> &'a Value {
        out["workers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["id"] == id)
            .expect("worker is in the answer")
    }

    #[test]
    fn args_default_to_all_workers_with_a_short_timeout() {
        assert_eq!(
            parse_args(&json!({})).unwrap(),
            Args {
                ids: None,
                any: false,
                timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS)
            }
        );
        let a = parse_args(&json!({"ids": ["a"], "mode": "any", "timeoutSec": 99999})).unwrap();
        assert_eq!(a.ids, Some(vec!["a".to_string()]));
        assert!(a.any);
        assert_eq!(a.timeout, Duration::from_secs(MAX_TIMEOUT_SECS));
        assert_eq!(
            parse_args(&json!({"timeoutSec": 0})).unwrap().timeout,
            Duration::from_secs(1)
        );
        assert!(parse_args(&json!({"mode": "first"})).is_err());
        assert!(parse_args(&json!({"ids": "a"})).is_err());
        assert!(parse_args(&json!({"ids": [1]})).is_err());
        assert!(parse_args(&json!({"timeoutSec": "soon"})).is_err());
    }

    #[test]
    fn nothing_running_returns_at_once_as_settled() {
        let w = world("settled");
        let started = Instant::now();
        let out = w.wait(json!({"timeoutSec": 5})).unwrap();
        assert_eq!(out["reason"], "settled");
        assert_eq!(out["workers"].as_array().unwrap().len(), 2);
        assert!(started.elapsed() < MS(500));
    }

    #[test]
    fn all_waits_for_the_last_worker_to_stop() {
        let w = world("all");
        w.run(&w.w1);
        w.run(&w.w2);
        let a = w.later(MS(100), |w| w.stop(&w.w1));
        let b = w.later(MS(300), |w| w.stop(&w.w2));
        let started = Instant::now();
        let out = w.wait(json!({"timeoutSec": 5})).unwrap();
        assert_eq!(out["reason"], "settled");
        assert!(
            started.elapsed() >= MS(250),
            "it returned before the second worker stopped"
        );
        assert!(started.elapsed() < MS(2000), "it slept through the change");
        assert_eq!(worker(&out, &w.w1)["status"], "done");
        a.join().unwrap();
        b.join().unwrap();
    }

    #[test]
    fn any_returns_on_the_first_worker_to_stop() {
        let w = world("any");
        w.run(&w.w1);
        w.run(&w.w2);
        let a = w.later(MS(100), |w| w.stop(&w.w1));
        let started = Instant::now();
        let out = w.wait(json!({"mode": "any", "timeoutSec": 5})).unwrap();
        assert_eq!(out["reason"], "changed");
        assert!(started.elapsed() < MS(2000));
        assert_eq!(worker(&out, &w.w1)["status"], "done");
        assert_eq!(worker(&out, &w.w2)["status"], "running");
        a.join().unwrap();
    }

    #[test]
    fn any_returns_when_a_running_worker_posts_a_result() {
        let w = world("result");
        w.run(&w.w1);
        let a = w.later(MS(100), |w| {
            w.board.append(BoardRecord::result(
                &w.w1,
                &w.project,
                json!({"status": "success"}),
            ));
            w.fleet.notify_changed();
        });
        let out = w.wait(json!({"mode": "any", "timeoutSec": 5})).unwrap();
        assert_eq!(out["reason"], "changed");
        assert_eq!(worker(&out, &w.w1)["newResult"], true);
        assert_eq!(worker(&out, &w.w1)["hasResult"], true);
        assert_eq!(worker(&out, &w.w2)["hasResult"], false);
        a.join().unwrap();
    }

    #[test]
    fn a_result_from_before_the_wait_is_not_new() {
        let w = world("old-result");
        w.board.append(BoardRecord::result(
            &w.w1,
            &w.project,
            json!({"status": "success"}),
        ));
        w.run(&w.w1);
        let out = w.wait(json!({"mode": "any", "timeoutSec": 1})).unwrap();
        assert_eq!(out["reason"], "timeout");
        assert_eq!(worker(&out, &w.w1)["hasResult"], true);
        assert_eq!(worker(&out, &w.w1)["newResult"], false);
    }

    #[test]
    fn a_timeout_is_reported_as_one_with_the_current_statuses() {
        let w = world("timeout");
        w.run(&w.w1);
        let started = Instant::now();
        let out = w.wait(json!({"timeoutSec": 1})).unwrap();
        assert_eq!(out["reason"], "timeout");
        assert!(started.elapsed() >= MS(900));
        assert_eq!(worker(&out, &w.w1)["status"], "running");
    }

    #[test]
    fn ids_narrow_the_wait_and_must_be_in_the_callers_project() {
        let w = world("ids");
        w.run(&w.w2);
        // w2 is running, but only w1 was asked about.
        let out = w.wait(json!({"ids": [w.w1], "timeoutSec": 5})).unwrap();
        assert_eq!(out["reason"], "settled");
        assert_eq!(out["workers"].as_array().unwrap().len(), 1);
        // A session in another project is not found, never waited on.
        let other = w
            .store
            .add_project("/elsewhere".into(), w.store.active_profile());
        let foreign = w
            .store
            .add_session(
                &other.id,
                "x".into(),
                false,
                crate::agent::AgentId::Claude,
                SessionRole::Worker,
            )
            .unwrap();
        let err = w.wait(json!({"ids": [foreign.id]})).unwrap_err();
        assert!(err.starts_with("session-not-found"), "{err}");
        assert_eq!(
            w.wait(json!({"ids": [w.conductor]})).unwrap_err(),
            "cannot-target-self"
        );
    }

    #[test]
    fn a_project_with_no_workers_says_so() {
        let store = Store::for_test(&temp_dir("none"));
        let proj = store.add_project("/repo".into(), store.active_profile());
        let c = store
            .add_session(
                &proj.id,
                "C".into(),
                false,
                crate::agent::AgentId::Claude,
                SessionRole::Conductor,
            )
            .unwrap();
        let out = wait(
            &store,
            &FleetState::default(),
            &BoardState::default(),
            &PtyManager::new(),
            &c.id,
            &parse_args(&json!({})).unwrap(),
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(out["reason"], "no-workers");
    }

    #[cfg(unix)]
    #[test]
    fn a_worker_that_was_just_spawned_counts_as_starting_not_idle() {
        let w = world("starting");
        // It has a terminal and has never reported: the agent is still booting.
        let _rx = w.pty.insert_test_session(&w.w1, &["cat"]);
        let a = w.later(MS(150), |w| {
            w.run(&w.w1);
            std::thread::sleep(MS(150));
            w.stop(&w.w1);
        });
        let started = Instant::now();
        let out = w
            .wait_with_grace(
                json!({"ids": [w.w1], "timeoutSec": 5}),
                Duration::from_secs(10),
            )
            .unwrap();
        assert_eq!(out["reason"], "settled");
        assert!(
            started.elapsed() >= MS(250),
            "it returned before the worker ever ran"
        );
        a.join().unwrap();
        w.pty.kill(&w.w1);
    }

    #[cfg(unix)]
    #[test]
    fn a_worker_that_never_reports_stops_counting_as_starting_after_the_grace() {
        let w = world("grace");
        let _rx = w.pty.insert_test_session(&w.w1, &["cat"]);
        let started = Instant::now();
        let out = w
            .wait_with_grace(json!({"ids": [w.w1], "timeoutSec": 30}), MS(300))
            .unwrap();
        assert_eq!(out["reason"], "settled");
        assert!(started.elapsed() < Duration::from_secs(5));
        w.pty.kill(&w.w1);
    }
}
