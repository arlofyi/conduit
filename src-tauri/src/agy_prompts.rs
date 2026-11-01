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
//!
//! **Only the OLDEST waiting step ever has a card.** Parallel calls queue: agy draws their
//! menus one after another, so a key always lands on the menu for the lowest waiting `idx`,
//! whatever card it was meant for. A card for step 8 answered while step 7's menu is up would
//! run step 7. So a card is raised for the oldest waiting step only, and its waiter re-checks
//! that its step is STILL the oldest waiting one before pressing anything.

use crate::agy_transcript::{self, Waiting};
use crate::asks::By;
use crate::broker::{Broker, Decision, Resolution};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
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

/// A card's waiter has not finished yet.
const OUTCOME_PENDING: u8 = 0;
/// The card is settled: a key was sent, or it was given up. Never re-raised while its step
/// stays waiting (agy takes a moment to move a step off 9 after a key).
const OUTCOME_SETTLED: u8 = 1;
/// The card ended with no key pressed and nobody's answer delivered: handed back to the
/// terminal (the last phone left), or answered while another step's menu was on screen. The
/// step stays eligible and is raised again once someone can see a card.
const OUTCOME_HANDED_BACK: u8 = 2;

/// One card this watcher raised.
struct Open {
    perm_id: String,
    idx: i64,
    /// Written once by the card's waiter when it finishes (`OUTCOME_*`).
    outcome: Arc<AtomicU8>,
}

/// Pure: how a finished card ends, from its resolution and whether a key was actually sent.
/// `decided` = a person chose Allow/Deny on the card.
pub fn outcome_for(by: By, keys_sent: bool, decided: bool) -> u8 {
    if keys_sent {
        return OUTCOME_SETTLED;
    }
    match by {
        By::Terminal => OUTCOME_HANDED_BACK,
        By::Phone | By::Desktop if decided => OUTCOME_HANDED_BACK,
        _ => OUTCOME_SETTLED,
    }
}

/// Pure: is `idx` the step whose menu agy is showing -- the oldest one waiting?
pub fn is_oldest_waiting(waiting: &[i64], idx: i64) -> bool {
    waiting.iter().min() == Some(&idx)
}

/// The agy step a card answers, in the conversation db that holds it.
struct Step {
    db: PathBuf,
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
    /// Steps already decided (a key was sent, or the card was given up): never re-raised
    /// while they stay waiting -- agy takes a moment to move a step off 9 after a key.
    settled: HashSet<i64>,
}

/// What one tick should do for a session, decided from plain data (tested).
#[derive(Debug, PartialEq)]
pub struct TickPlan {
    /// Cards whose step is no longer waiting: answered in the terminal.
    pub drop_terminal: Vec<String>,
    /// The OLDEST waiting step, when it has no card and is not settled -- at most one, since
    /// only its menu is on screen (see the module doc).
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
        .min()
        .filter(|idx| !settled.contains(idx) && !open.iter().any(|(_, o)| o == idx))
        .into_iter()
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
    // Live PTYs first: cheap, and with no agy session running the tick ends here instead of
    // cloning the whole project list every 700 ms.
    let live: Vec<String> = pty
        .session_ids()
        .into_iter()
        .filter(|id| store.session_agent(id) == crate::agent::AgentId::Antigravity)
        .collect();
    if live.is_empty() && watches.is_empty() {
        return;
    }

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

        // A card whose waiter finished: its step is settled only if a key was sent (or the
        // card was given up). A hand-back leaves it eligible to be raised again.
        w.open.retain(|o| match o.outcome.load(Ordering::Acquire) {
            OUTCOME_PENDING => true,
            OUTCOME_SETTLED => {
                w.settled.insert(o.idx);
                false
            }
            _ => false,
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
        // Auto-approve: Conduit presses Allow itself, no card. An open card is approved too
        // (the switch was flipped while it was showing). ONE step per tick: parallel calls
        // show their menus one after another, and a second key sent before the next menu
        // has drawn would land in agy's input box as text.
        if store.session_auto_approve(&sid) {
            if !w.open.is_empty() {
                // The oldest card's waiter presses its key; one key per tick, as below.
                if let Some(o) = w.open.first() {
                    broker.resolve(&o.perm_id, Decision::Allow, By::Desktop);
                }
                continue;
            }
            if let Some(&idx) = plan.raise.first() {
                if agy_transcript::step_status(&db, idx) == Some(agy_transcript::STATUS_WAITING) {
                    match pty.write(&sid, keys_for(&Decision::Allow).unwrap_or("1")) {
                        Ok(()) => eprintln!("[agy-prompts] {sid}: auto-approved step {idx}"),
                        Err(e) => crate::diag::warn(
                            "agy-prompts",
                            format!("{sid}: auto-approve failed: {e}"),
                        ),
                    }
                }
                w.settled.insert(idx);
            }
            continue;
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
            let outcome = Arc::new(AtomicU8::new(OUTCOME_PENDING));
            w.open.push(Open {
                perm_id: perm_id.clone(),
                idx,
                outcome: outcome.clone(),
            });
            spawn_waiter(
                app.clone(),
                rx,
                perm_id,
                sid.clone(),
                Step {
                    db: db.clone(),
                    idx,
                },
                outcome,
            );
        }
    }
}

/// Wait for the card's answer and press the matching keys -- only for a decision a person made
/// on a card, and only while its step is still the OLDEST waiting one (the menu on screen).
fn spawn_waiter(
    app: AppHandle,
    rx: Receiver<Resolution>,
    perm_id: String,
    session: String,
    step: Step,
    result: Arc<AtomicU8>,
) {
    let Step { db, idx } = step;
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
            let (mut keys_sent, mut decided) = (false, false);
            if let Some((decision, By::Phone | By::Desktop)) = outcome {
                if let Some(keys) = keys_for(&decision) {
                    decided = true;
                    // A key lands on whichever menu is on screen: the oldest waiting step's.
                    let waiting: Vec<i64> = agy_transcript::waiting_steps(&db)
                        .map(|v| v.into_iter().map(|s| s.idx).collect())
                        .unwrap_or_default();
                    if is_oldest_waiting(&waiting, idx) {
                        if let Some(pty) = app.try_state::<Arc<crate::pty::PtyManager>>() {
                            match pty.write(&session, keys) {
                                Ok(()) => keys_sent = true,
                                Err(e) => {
                                    crate::diag::warn("agy-prompts", format!("could not answer {perm_id}: {e}"))
                                }
                            }
                        }
                    } else if waiting.contains(&idx) {
                        eprintln!(
                            "[agy-prompts] {perm_id}: step {idx} is not the menu on screen; nothing sent"
                        );
                    }
                }
            }
            result.store(outcome_for(by, keys_sent, decided), Ordering::Release);
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
    fn auto_approve_is_offered_for_antigravity_only() {
        use crate::agent::AgentId;
        assert!(crate::session_options::auto_approve_supported(
            AgentId::Antigravity
        ));
        // Claude has its own permission modes; nothing else is read by this watcher.
        assert!(!crate::session_options::auto_approve_supported(
            AgentId::Claude
        ));
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

    #[test]
    fn only_the_oldest_waiting_step_gets_a_card() {
        let none = HashSet::new();
        // Parallel calls: menus queue, so only step 7's is on screen.
        assert_eq!(plan_tick(&[8, 7, 9], &[], &none).raise, vec![7]);
        // The oldest already has a card: nothing more, though 8 and 9 wait too.
        assert!(plan_tick(&[7, 8], &[("perm-1".into(), 7)], &none)
            .raise
            .is_empty());
        // 7 was answered but agy has not moved it yet: 8 still waits, or its key would land
        // on 7's menu.
        let settled: HashSet<i64> = [7].into_iter().collect();
        assert!(plan_tick(&[7, 8], &[], &settled).raise.is_empty());
        // Once 7 leaves 9, step 8 is the menu on screen.
        assert_eq!(plan_tick(&[8], &[], &settled).raise, vec![8]);
    }

    #[test]
    fn a_waiter_presses_only_for_the_menu_on_screen() {
        assert!(is_oldest_waiting(&[7, 8], 7));
        assert!(
            !is_oldest_waiting(&[7, 8], 8),
            "Allow on card 8 would run step 7"
        );
        assert!(
            !is_oldest_waiting(&[], 7),
            "a step no longer waiting gets nothing"
        );
    }

    #[test]
    fn a_hand_back_without_a_key_keeps_the_step_eligible() {
        assert_eq!(outcome_for(By::Phone, true, true), OUTCOME_SETTLED);
        // The last phone left: handed back with nothing pressed -- raise again later.
        assert_eq!(outcome_for(By::Terminal, false, false), OUTCOME_HANDED_BACK);
        // A person decided but the step was not the one on screen: raise again when it is.
        assert_eq!(outcome_for(By::Desktop, false, true), OUTCOME_HANDED_BACK);
        // Given up at the ceiling, or cancelled with the session: settled.
        assert_eq!(outcome_for(By::Timeout, false, false), OUTCOME_SETTLED);
        assert_eq!(outcome_for(By::Cancelled, false, false), OUTCOME_SETTLED);
    }
}
