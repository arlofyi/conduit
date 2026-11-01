//! Antigravity's tool-permission prompts as Conduit permission cards.
//!
//! agy fires no permission hook. What it does do is mark the tool step it is holding for the
//! user's yes/no with `steps.status = 9` in its conversation database (measured live, agy
//! 1.4.x: `run_command` sits at 9 while the TUI shows "Run this command?"). This watcher polls
//! every live agy session that has a captured conversation id, and registers each waiting step
//! in the SAME `Broker` Claude's `/permission` hook uses -- so the desktop hold-dock, the phone
//! push diff, `approve` and `permission_respond` need no agy case.
//!
//! An answer becomes keystrokes on the session's PTY, measured against agy's menu:
//! - Allow = `1` (option 1 is "Yes, run command"; the command ran).
//! - Deny = Esc. `4` ("No, cancel") also works for run_command, but option numbers differ per
//!   tool, and a digit aimed at "No" can land on a "Yes, always" option. Esc cancels the step
//!   (status 6, "Interrupted · What should Antigravity CLI do instead?") on any menu.
//!
//! The step is re-read right before sending: still waiting, or nothing is sent. A step that
//! leaves status 9 on its own was answered in the terminal and its card is dropped
//! (`by: terminal`).

use crate::agy_transcript::{self, Waiting};
use crate::asks::By;
use crate::broker::{Broker, Decision, Resolution};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// How often live agy sessions are checked. A check is two `stat`s unless the db moved.
const POLL: Duration = Duration::from_millis(700);
/// agy waits for an answer indefinitely; a card is given up after this long.
const CARD_CEILING: Duration = Duration::from_secs(6 * 3600);

/// The keys that answer agy's permission menu (see the module doc). None = send nothing.
pub fn keys_for(decision: &Decision) -> Option<&'static str> {
    match decision {
        Decision::Allow => Some("1"),
        Decision::Deny => Some("\u{1b}"),
        Decision::FallThrough => None,
    }
}

/// A waiting agy call as the Broker's (tool, input), in Claude's vocabulary where one exists
/// so `permission_summary` shows the command or path rather than a bare tool name.
pub fn card_for(w: &Waiting) -> (String, Value) {
    let arg = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| w.args.get(*k).and_then(Value::as_str))
            .map(str::to_string)
    };
    match w.tool.as_str() {
        "run_command" => match arg(&["CommandLine", "command"]) {
            Some(c) => ("Bash".into(), json!({ "command": c })),
            None => (w.tool.clone(), w.args.clone()),
        },
        "write_to_file" | "replace_file_content" | "multi_replace_file_content" => {
            match arg(&["TargetFile", "AbsolutePath", "file_path"]) {
                Some(p) => {
                    let tool = if w.tool == "write_to_file" {
                        "Write"
                    } else {
                        "Edit"
                    };
                    (tool.into(), json!({ "file_path": p }))
                }
                None => (w.tool.clone(), w.args.clone()),
            }
        }
        "view_file" | "read_file" => match arg(&["AbsolutePath", "TargetFile", "file_path"]) {
            Some(p) => ("Read".into(), json!({ "file_path": p })),
            None => (w.tool.clone(), w.args.clone()),
        },
        _ => (w.tool.clone(), w.args.clone()),
    }
}

/// One card this watcher raised.
struct Open {
    perm_id: String,
    idx: i64,
}

/// Per-session watch state.
#[derive(Default)]
struct Watch {
    db: Option<PathBuf>,
    version: Option<agy_transcript::AgyVersion>,
    /// The steps waiting at the last read.
    waiting: Vec<Waiting>,
    open: Vec<Open>,
    /// Steps already decided (by a card, or handed back to the terminal): never re-raised
    /// while they stay waiting -- agy takes a moment to move a step off 9 after a key.
    settled: HashSet<i64>,
}

/// What one tick should do for a session, decided from plain data (tested).
#[derive(Debug, PartialEq)]
pub struct TickPlan {
    /// Cards whose step is no longer waiting: answered in the terminal.
    pub drop_terminal: Vec<String>,
    /// Waiting steps that have no card and are not settled.
    pub raise: Vec<i64>,
    /// Settled steps that are no longer waiting (forget them).
    pub unsettle: Vec<i64>,
}

pub fn plan_tick(waiting: &[i64], open: &[(String, i64)], settled: &HashSet<i64>) -> TickPlan {
    let drop_terminal = open
        .iter()
        .filter(|(_, idx)| !waiting.contains(idx))
        .map(|(id, _)| id.clone())
        .collect();
    let raise = waiting
        .iter()
        .copied()
        .filter(|idx| !settled.contains(idx) && !open.iter().any(|(_, o)| o == idx))
        .collect();
    let unsettle = settled
        .iter()
        .copied()
        .filter(|idx| !waiting.contains(idx))
        .collect();
    TickPlan {
        drop_terminal,
        raise,
        unsettle,
    }
}

/// Start the watcher thread. Safe to call once at setup.
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("agy-prompts".into())
        .spawn(move || {
            let mut watches: HashMap<String, Watch> = HashMap::new();
            loop {
                std::thread::sleep(POLL);
                tick(&app, &mut watches);
            }
        })
        .ok();
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn tick(app: &AppHandle, watches: &mut HashMap<String, Watch>) {
    let (Some(store), Some(pty), Some(broker)) = (
        app.try_state::<Arc<crate::store::Store>>(),
        app.try_state::<Arc<crate::pty::PtyManager>>(),
        app.try_state::<Arc<Broker>>(),
    ) else {
        return;
    };
    let live: Vec<String> = store
        .list()
        .iter()
        .flat_map(|p| p.sessions.iter())
        .filter(|s| s.agent == crate::agent::AgentId::Antigravity)
        .map(|s| s.id.clone())
        .filter(|id| pty.has(id))
        .collect();

    // A session that stopped (or stopped being agy) takes its cards with it.
    watches.retain(|sid, w| {
        let keep = live.contains(sid);
        if !keep {
            for o in &w.open {
                broker.resolve(&o.perm_id, Decision::FallThrough, By::Cancelled);
            }
        }
        keep
    });

    for sid in live {
        let w = watches.entry(sid.clone()).or_default();
        // Resolve the db each tick: the conversation id is captured after spawn and can move.
        let db = store.session_agent_conversation_id(&sid).and_then(|cid| {
            let cfg = store.session_account_config_dir(&sid);
            let home = crate::agy_usage::resolve_agy_home(cfg.as_deref())?;
            agy_transcript::conversation_db(&home, &cid)
        });
        if db != w.db {
            for o in w.open.drain(..) {
                broker.resolve(&o.perm_id, Decision::FallThrough, By::Cancelled);
            }
            w.settled.clear();
            w.waiting.clear();
            w.version = None;
            w.db = db.clone();
        }
        let Some(db) = db else { continue };
        let version = agy_transcript::version(&db);
        if version.is_some() && version != w.version {
            w.version = version;
            w.waiting = agy_transcript::waiting_steps(&db).unwrap_or_default();
            if !w.waiting.is_empty() {
                // One line per db change, so a stuck agy is diagnosable from the log.
                eprintln!(
                    "[agy-prompts] {sid}: {} step(s) waiting on the user ({})",
                    w.waiting.len(),
                    w.waiting
                        .iter()
                        .map(|s| s.tool.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
        }

        // A card someone answered (or that was handed back) is gone from the Broker.
        w.open.retain(|o| {
            let alive = broker.get(&o.perm_id).is_some();
            if !alive {
                w.settled.insert(o.idx);
            }
            alive
        });

        let waiting_idx: Vec<i64> = w.waiting.iter().map(|s| s.idx).collect();
        let open: Vec<(String, i64)> = w.open.iter().map(|o| (o.perm_id.clone(), o.idx)).collect();
        let plan = plan_tick(&waiting_idx, &open, &w.settled);
        for id in &plan.drop_terminal {
            broker.resolve(id, Decision::FallThrough, By::Terminal);
        }
        w.open.retain(|o| !plan.drop_terminal.contains(&o.perm_id));
        for idx in &plan.unsettle {
            w.settled.remove(idx);
        }
        for idx in plan.raise {
            let Some(step) = w.waiting.iter().find(|s| s.idx == idx) else {
                continue;
            };
            // Only when someone could see the card -- the TUI already shows the menu.
            let Some(held_for_phone) = crate::hooks::card_holder(app, &sid) else {
                continue;
            };
            let (tool, input) = card_for(step);
            let (perm_id, rx) =
                broker.register_held(sid.clone(), tool, input, now_ms(), held_for_phone);
            if let Some(view) = broker.get(&perm_id) {
                let _ = app.emit("permission-request", &view);
            }
            w.open.push(Open {
                perm_id: perm_id.clone(),
                idx,
            });
            spawn_waiter(app.clone(), rx, perm_id, sid.clone(), db.clone(), idx);
        }
    }
}

/// Wait for the card's answer and press the matching keys -- only for a decision a person made
/// on a card, and only while the step is still waiting.
fn spawn_waiter(
    app: AppHandle,
    rx: Receiver<Resolution>,
    perm_id: String,
    session: String,
    db: PathBuf,
    idx: i64,
) {
    std::thread::Builder::new()
        .name("agy-prompt".into())
        .spawn(move || {
            let outcome = match rx.recv_timeout(CARD_CEILING) {
                Ok(r) => Some(r),
                Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => None,
            };
            if let Some(broker) = app.try_state::<Arc<Broker>>() {
                broker.forget(&perm_id);
            }
            let by = outcome.map_or(By::Timeout, |(_, by)| by);
            if let Some((decision, By::Phone | By::Desktop)) = outcome {
                let still_waiting =
                    agy_transcript::step_status(&db, idx) == Some(agy_transcript::STATUS_WAITING);
                if let (Some(keys), true) = (keys_for(&decision), still_waiting) {
                    if let Some(pty) = app.try_state::<Arc<crate::pty::PtyManager>>() {
                        if let Err(e) = pty.write(&session, keys) {
                            eprintln!("[agy-prompts] could not answer {perm_id}: {e}");
                        }
                    }
                }
            }
            let _ = app.emit(
                "permission-resolved",
                json!({ "id": perm_id, "by": by.as_str() }),
            );
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waiting(tool: &str, args: Value) -> Waiting {
        Waiting {
            idx: 3,
            tool: tool.into(),
            args,
        }
    }

    #[test]
    fn allow_presses_one_and_deny_presses_escape_never_a_no_digit() {
        assert_eq!(keys_for(&Decision::Allow), Some("1"));
        // Esc cancels on every menu; a digit for "No" could select a "Yes, always" option.
        assert_eq!(keys_for(&Decision::Deny), Some("\u{1b}"));
        assert_eq!(keys_for(&Decision::FallThrough), None);
    }

    #[test]
    fn a_waiting_command_reads_as_bash_with_its_command_line() {
        let w = waiting(
            "run_command",
            json!({"CommandLine": "agy --version", "WaitMsBeforeAsync": 5000, "toolSummary": "x"}),
        );
        assert_eq!(
            card_for(&w),
            ("Bash".into(), json!({"command": "agy --version"}))
        );
        let (tool, input) = card_for(&waiting(
            "write_to_file",
            json!({"TargetFile": "C:/a/b.rs"}),
        ));
        assert_eq!(
            (tool.as_str(), input),
            ("Write", json!({"file_path": "C:/a/b.rs"}))
        );
        let (tool, _) = card_for(&waiting("replace_file_content", json!({"TargetFile": "x"})));
        assert_eq!(tool, "Edit");
        // Unknown tools keep agy's own name and arguments.
        let (tool, input) = card_for(&waiting("browser_open", json!({"Url": "u"})));
        assert_eq!(
            (tool.as_str(), input),
            ("browser_open", json!({"Url": "u"}))
        );
        // A known tool missing its field degrades to the raw call, not an empty card.
        let (tool, _) = card_for(&waiting("run_command", json!({})));
        assert_eq!(tool, "run_command");
    }

    #[test]
    fn a_tick_raises_new_steps_drops_terminal_answers_and_never_reraises_a_settled_one() {
        let none = HashSet::new();
        // A new waiting step gets a card.
        assert_eq!(
            plan_tick(&[4], &[], &none),
            TickPlan {
                drop_terminal: vec![],
                raise: vec![4],
                unsettle: vec![]
            }
        );
        // Answered in the TUI: the step left 9, its card goes.
        let p = plan_tick(&[], &[("perm-1".into(), 4)], &none);
        assert_eq!(p.drop_terminal, vec!["perm-1".to_string()]);
        // Decided on a card but agy has not moved the step yet: no second card.
        let settled: HashSet<i64> = [4].into_iter().collect();
        assert!(plan_tick(&[4], &[], &settled).raise.is_empty());
        // Once it leaves 9 the settled mark is forgotten.
        assert_eq!(plan_tick(&[], &[], &settled).unsettle, vec![4]);
        // An open card is not raised twice.
        assert!(plan_tick(&[4], &[("perm-1".into(), 4)], &none)
            .raise
            .is_empty());
    }
}
