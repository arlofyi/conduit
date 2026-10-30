//! Pending tool permissions held by the blocking `/permission` hook route
//! (Claude Code's `PermissionRequest` event). The handler registers a request and blocks
//! on its receiver; a phone (`approve`) or a desktop card (`permission_respond`) decides
//! it. First responder wins: `resolve` removes the entry, so a second one finds nothing.
//!
//! Not `asks.rs`: a question carries the user's ANSWERS, a permission only allow / deny.
//! Everything else is the same machinery and deliberately the same rules -- the gate
//! (`hooks::Holders`), `asks::By` attribution, `held_for_phone` hand-off when the last
//! phone leaves, cancellation when the session's turn moves on, and a resolution ring the
//! bridge reads to say who answered.
//!
//! The protocol was measured against claude 2.1.312 (see
//! `docs/superpowers/specs/2026-10-30-permission-request-hook-findings.md`): the hook and
//! Claude's own dialog run in PARALLEL, `allow` / `deny` close the dialog, and `{}` leaves
//! it for the human. The input carries no `tool_use_id`, so an entry is keyed by its own
//! minted id plus the session.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use crate::asks::{By, RECENT_RESOLUTIONS};

/// How long `/permission` holds a request for a card. MUST stay under curl's `-m` and the
/// hook entry's `timeout`: past either, Claude kills the hook and the answer reaches nobody
/// (measured: an overrun hook is killed and the dialog stays, i.e. a fall-through).
pub const PERMISSION_CEILING: Duration = Duration::from_secs(300);
pub const PERMISSION_CURL_MAX_SECS: u64 = 330;
pub const PERMISSION_HOOK_TIMEOUT_SECS: u64 = 340;
// Compile-time, so every build enforces the order (not just test builds).
const _: () = assert!(
    PERMISSION_CEILING.as_secs() < PERMISSION_CURL_MAX_SECS
        && PERMISSION_CURL_MAX_SECS < PERMISSION_HOOK_TIMEOUT_SECS
);

/// What the model is told on a deny. It quotes it back, so it is written for the user.
pub const DENY_MESSAGE: &str = "Denied from Conduit";

/// Longest `summary` a card shows, in characters (including the ellipsis).
pub const SUMMARY_MAX_CHARS: usize = 200;

/// What the blocked hook replies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
    /// `{}`: Claude's own dialog decides (hand-off, cancel, timeout).
    FallThrough,
}

/// A decision and who made it.
pub type Resolution = (Decision, By);

/// A pending permission as every surface sees it (`permission-request`, `permission_pending`,
/// and -- through `bridge_view::permission_push` -- the phone). The raw tool input stays in
/// Rust; `summary` is the one line a card shows.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionView {
    pub id: String,
    pub session: String,
    pub tool_name: String,
    pub summary: String,
    pub created_ms: u64,
    /// A hook is blocked on this request. `false` = OBSERVED: the hook already answered
    /// `{}` and Claude's own dialog decides; listed only so a phone can show it (see
    /// `asks::AskView::held`). Never on the desktop's wire.
    #[serde(skip)]
    pub held: bool,
}

struct Pending {
    view: PermissionView,
    /// The blocked hook's channel; `None` for an observed entry.
    tx: Option<SyncSender<Resolution>>,
    /// Held ONLY because a remote phone was connected (see `asks::Pending`).
    held_for_phone: bool,
}

#[derive(Default)]
pub struct Broker {
    seq: AtomicU64,
    pending: Mutex<HashMap<String, Pending>>,
    /// The last [`RECENT_RESOLUTIONS`] `(id, by)`, oldest first, written under the
    /// `pending` lock in the same breath as the removal (the `asks.rs` rule).
    recent: Mutex<VecDeque<(String, By)>>,
}

impl Broker {
    /// Register a pending request; returns its id and the receiver the hook blocks on.
    pub fn register_held(
        &self,
        session: String,
        tool: String,
        input: Value,
        created_ms: u64,
        held_for_phone: bool,
    ) -> (String, Receiver<Resolution>) {
        let (tx, rx) = sync_channel(1);
        let id = self.insert(session, tool, &input, created_ms, Some(tx), held_for_phone);
        (id, rx)
    }

    /// Record a request nobody is holding: the hook answers `{}` at once and Claude's own
    /// dialog decides, but phones are still shown what it would run (read-only). Cleared by
    /// [`Broker::cancel_session_where`] or, failing that, [`Broker::sweep_observed`].
    pub fn observe(&self, session: String, tool: String, input: Value, created_ms: u64) -> String {
        self.insert(session, tool, &input, created_ms, None, false)
    }

    fn insert(
        &self,
        session: String,
        tool: String,
        input: &Value,
        created_ms: u64,
        tx: Option<SyncSender<Resolution>>,
        held_for_phone: bool,
    ) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("perm-{n}");
        let view = PermissionView {
            id: id.clone(),
            session,
            summary: permission_summary(&tool, input),
            tool_name: tool,
            created_ms,
            held: tx.is_some(),
        };
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.clone(),
                Pending {
                    view,
                    tx,
                    held_for_phone,
                },
            );
        id
    }

    /// Drop every observed entry older than `asks::OBSERVED_TTL` at `now_ms`, as
    /// `cancelled`. A held one is never touched: its own hook's ceiling ends it.
    pub fn sweep_observed(&self, now_ms: u64) -> Vec<String> {
        let ttl = crate::asks::OBSERVED_TTL.as_millis() as u64;
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<String> = map
            .iter()
            .filter(|(_, p)| p.tx.is_none() && p.view.created_ms.saturating_add(ttl) <= now_ms)
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        for id in &ids {
            map.remove(id);
            self.record(id, By::Cancelled);
        }
        ids
    }

    /// Append to the ring. Called with the `pending` guard held (lock order: pending ->
    /// recent, never the reverse).
    fn record(&self, id: &str, by: By) {
        let mut recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        if recent.len() >= RECENT_RESOLUTIONS {
            recent.pop_front();
        }
        recent.push_back((id.to_string(), by));
    }

    /// First responder wins. `false` = already resolved (or never existed): nothing sent.
    /// The guard is held across remove + `try_send`, so the holder's forget + `try_recv`
    /// is a true check-and-set (see `asks::Asks::resolve`).
    /// Only a HELD request resolves: an observed one has no hook waiting, so nothing may
    /// claim to have allowed or denied it.
    pub fn resolve(&self, id: &str, decision: Decision, by: By) -> bool {
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if !map.get(id).is_some_and(|p| p.tx.is_some()) {
            return false;
        }
        let Some(Pending { tx: Some(tx), .. }) = map.remove(id) else {
            return false;
        };
        self.record(id, by);
        let _ = tx.try_send((decision, by));
        true
    }

    /// The holder giving up (its ceiling ran out). Still present = nobody decided it, which
    /// is recorded as a timeout; after a resolve this is a no-op.
    pub fn forget(&self, id: &str) {
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(id).is_some_and(|p| p.tx.is_some()) {
            map.remove(id);
            self.record(id, By::Timeout);
        }
    }

    /// Remove every request `pick(view, held_for_phone)` names, recording the `By` it
    /// returns; a held one's hook is also told to fall through (`{}`). One lock for the
    /// whole sweep.
    fn fall_through_where(
        &self,
        pick: impl Fn(&PermissionView, bool) -> Option<By>,
    ) -> Vec<String> {
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let picked: Vec<(String, By)> = map
            .iter()
            .filter_map(|(id, p)| pick(&p.view, p.held_for_phone).map(|by| (id.clone(), by)))
            .collect();
        for (id, by) in &picked {
            if let Some(p) = map.remove(id) {
                self.record(id, *by);
                if let Some(tx) = p.tx {
                    let _ = tx.try_send((Decision::FallThrough, *by));
                }
            }
        }
        picked.into_iter().map(|(id, _)| id).collect()
    }

    /// The session's turn moved on (`hooks::permission_moved_on`): its open requests whose
    /// tool name passes `tool_matches` are dead -- all of them for a turn-level event, only
    /// the finished tool's own for a PostToolUse. After a terminal "Yes" this is what clears
    /// a held card: the hook is left running and its reply ignored, but `PostToolUse`
    /// follows. A held one is recorded `cancelled`; an observed one as `observed_by(view)`.
    pub fn cancel_session_where(
        &self,
        session: &str,
        tool_matches: impl Fn(&str) -> bool,
        observed_by: impl Fn(&PermissionView) -> By,
    ) -> Vec<String> {
        self.fall_through_where(|v, _| {
            (v.session == session && tool_matches(&v.tool_name)).then(|| {
                if v.held {
                    By::Cancelled
                } else {
                    observed_by(v)
                }
            })
        })
    }

    /// Hand back to the terminal every HELD request matching `pred(view, held_for_phone)`.
    pub fn hand_off_where(&self, pred: impl Fn(&PermissionView, bool) -> bool) -> Vec<String> {
        self.fall_through_where(|v, held_for_phone| {
            (v.held && pred(v, held_for_phone)).then_some(By::Terminal)
        })
    }

    /// The last [`RECENT_RESOLUTIONS`] resolutions, oldest first.
    pub fn recent_resolutions(&self) -> Vec<(String, By)> {
        self.recent
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    /// A HELD request (one a card may still decide); None once resolved, or if observed.
    pub fn get(&self, id: &str) -> Option<PermissionView> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .filter(|p| p.view.held)
            .map(|p| p.view.clone())
    }

    /// Catch-up for a reload or a new window: the HELD requests, oldest first. The desktop
    /// never shows an observed one -- its terminal already has the dialog.
    pub fn pending(&self) -> Vec<PermissionView> {
        self.listed(true)
    }

    /// Every open request, held or observed, oldest first: what phones are shown.
    pub fn all(&self) -> Vec<PermissionView> {
        self.listed(false)
    }

    fn listed(&self, held_only: bool) -> Vec<PermissionView> {
        let mut v: Vec<PermissionView> = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|p| p.view.held || !held_only)
            .map(|p| p.view.clone())
            .collect();
        v.sort_by(|a, b| a.created_ms.cmp(&b.created_ms).then(a.id.cmp(&b.id)));
        v
    }
}

/// One line describing what the tool would do: Bash -> its command, a file tool -> its
/// path, anything else (or a known tool missing its field) -> the tool's name. Whitespace
/// runs collapse to one space; at most [`SUMMARY_MAX_CHARS`] characters.
pub fn permission_summary(tool: &str, input: &Value) -> String {
    let field = match tool {
        "Bash" => Some("command"),
        "Edit" | "Write" | "Read" | "MultiEdit" => Some("file_path"),
        "NotebookEdit" => Some("notebook_path"),
        _ => None,
    };
    let text = field
        .and_then(|f| input.get(f))
        .and_then(Value::as_str)
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| tool.to_string());
    if text.chars().count() <= SUMMARY_MAX_CHARS {
        return text;
    }
    let mut out: String = text.chars().take(SUMMARY_MAX_CHARS - 1).collect();
    out.push('…');
    out
}

/// The body `/permission` returns, which Claude reads as the hook's stdout. Shapes as
/// measured: allow / deny close Claude's dialog; `{}` leaves it for the human (FAIL-OPEN --
/// silence means "ask the human", never "no on their behalf"). Never `updatedInput` or
/// `updatedPermissions`: those rewrite the call or persist a rule.
pub fn permission_response(decision: Option<&Decision>) -> Value {
    let decision = match decision {
        Some(Decision::Allow) => json!({ "behavior": "allow" }),
        Some(Decision::Deny) => json!({ "behavior": "deny", "message": DENY_MESSAGE }),
        Some(Decision::FallThrough) | None => return json!({}),
    };
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asks::By;
    use serde_json::json;

    fn reg(b: &Broker, session: &str, created_ms: u64) -> (String, Receiver<Resolution>) {
        b.register_held(
            session.into(),
            "Bash".into(),
            json!({ "command": "ls" }),
            created_ms,
            false,
        )
    }

    #[test]
    fn permission_first_answer_wins() {
        let b = Broker::default();
        let (id, rx) = reg(&b, "s1", 1);
        assert!(b.resolve(&id, Decision::Allow, By::Phone));
        assert!(
            !b.resolve(&id, Decision::Deny, By::Desktop),
            "a second answer finds nothing"
        );
        assert_eq!(rx.try_recv().unwrap(), (Decision::Allow, By::Phone));
        assert!(rx.try_recv().is_err(), "exactly one decision is delivered");
        assert!(b.get(&id).is_none());
        assert_eq!(b.recent_resolutions(), vec![(id, By::Phone)]);
        assert!(!b.resolve("missing", Decision::Allow, By::Phone));
    }

    #[test]
    fn a_finished_sibling_tool_leaves_the_permission_pending() {
        let b = Broker::default();
        let (bash, rx_bash) = reg(&b, "s1", 1); // tool "Bash"
        assert!(b
            .cancel_session_where("s1", |t| t == "Read", |_| By::Terminal)
            .is_empty());
        assert!(rx_bash.try_recv().is_err() && b.get(&bash).is_some());
        assert_eq!(
            b.cancel_session_where("s1", |t| t == "Bash", |_| By::Terminal),
            vec![bash]
        );
        assert_eq!(
            rx_bash.try_recv().unwrap(),
            (Decision::FallThrough, By::Cancelled)
        );
    }

    #[test]
    fn permission_cancelled_on_turn_end() {
        let b = Broker::default();
        let (a, rx_a) = reg(&b, "s1", 1);
        let (other, rx_other) = reg(&b, "s2", 2);
        let (c, rx_c) = reg(&b, "s1", 3);
        let mut gone = b.cancel_session_where("s1", |_| true, |_| By::Terminal);
        gone.sort();
        let mut want = vec![a.clone(), c.clone()];
        want.sort();
        assert_eq!(gone, want);
        for rx in [&rx_a, &rx_c] {
            assert_eq!(
                rx.try_recv().unwrap(),
                (Decision::FallThrough, By::Cancelled),
                "the blocked hook answers {{}}"
            );
        }
        assert!(rx_other.try_recv().is_err() && b.get(&other).is_some());
        assert_eq!(b.pending().len(), 1);
        let ring = b.recent_resolutions();
        assert!(ring.contains(&(a, By::Cancelled)) && ring.contains(&(c, By::Cancelled)));
    }

    #[test]
    fn an_observed_permission_is_listed_for_phones_but_never_decidable() {
        let b = Broker::default();
        let (held, _rx) = reg(&b, "s1", 1);
        let seen = b.observe(
            "s1".into(),
            "Write".into(),
            json!({ "file_path": "/a.txt", "content": "x" }),
            2,
        );
        assert_eq!(
            b.pending().into_iter().map(|v| v.id).collect::<Vec<_>>(),
            vec![held.clone()],
            "the desktop never gets a card for it"
        );
        assert!(b.get(&seen).is_none());
        assert!(
            !b.resolve(&seen, Decision::Allow, By::Phone),
            "no hook is waiting: nothing may claim to allow it"
        );
        assert_eq!(b.hand_off_where(|_, _| true), vec![held]);
        let all = b.all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, seen);
        assert!(!all[0].held);
        assert_eq!(all[0].tool_name, "Write");
        assert_eq!(all[0].summary, "/a.txt");
        // The desktop payload never grows a `held` key.
        let v = serde_json::to_value(&all[0]).unwrap();
        assert!(v.get("held").is_none());
    }

    #[test]
    fn turn_end_clears_observed_permissions_with_the_callers_verdict() {
        let b = Broker::default();
        let (held, rx) = reg(&b, "s1", 1); // Bash
        let ran = b.observe("s1".into(), "Bash".into(), json!({}), 2);
        let sibling = b.observe("s1".into(), "Write".into(), json!({}), 3);
        // Bash finished: the held one is cancelled (its hook answers `{}`), the observed one
        // is what the terminal let run.
        let mut gone = b.cancel_session_where("s1", |t| t == "Bash", |_| By::Terminal);
        gone.sort();
        let mut want = vec![held.clone(), ran.clone()];
        want.sort();
        assert_eq!(gone, want);
        assert_eq!(
            rx.try_recv().unwrap(),
            (Decision::FallThrough, By::Cancelled)
        );
        let ring = b.recent_resolutions();
        assert!(ring.contains(&(held, By::Cancelled)));
        assert!(ring.contains(&(ran, By::Terminal)));
        assert_eq!(
            b.cancel_session_where("s1", |_| true, |_| By::Cancelled),
            vec![sibling.clone()]
        );
        assert!(b.recent_resolutions().contains(&(sibling, By::Cancelled)));
    }

    #[test]
    fn observed_permissions_expire_after_ten_minutes() {
        let b = Broker::default();
        let ttl = crate::asks::OBSERVED_TTL.as_millis() as u64;
        let (held, _rx) = reg(&b, "s1", 0);
        let old = b.observe("s1".into(), "Bash".into(), json!({}), 0);
        assert!(b.sweep_observed(ttl - 1).is_empty());
        assert_eq!(b.sweep_observed(ttl), vec![old.clone()]);
        assert!(b.recent_resolutions().contains(&(old, By::Cancelled)));
        assert_eq!(
            b.all().into_iter().map(|v| v.id).collect::<Vec<_>>(),
            vec![held]
        );
    }

    #[test]
    fn hand_off_where_touches_only_matching_permissions() {
        let b = Broker::default();
        let (phone, rx_phone) = b.register_held("s".into(), "Bash".into(), json!({}), 1, true);
        let (desk, rx_desk) = b.register_held("s".into(), "Bash".into(), json!({}), 2, false);
        assert_eq!(b.hand_off_where(|_, held| held), vec![phone.clone()]);
        assert_eq!(
            rx_phone.try_recv().unwrap(),
            (Decision::FallThrough, By::Terminal)
        );
        assert!(rx_desk.try_recv().is_err() && b.get(&desk).is_some());
    }

    #[test]
    fn a_forgotten_permission_is_a_timeout_and_cannot_be_answered_late() {
        let b = Broker::default();
        let (id, rx) = reg(&b, "s1", 1);
        b.forget(&id);
        assert!(!b.resolve(&id, Decision::Allow, By::Phone));
        assert!(rx.try_recv().is_err());
        assert_eq!(b.recent_resolutions(), vec![(id.clone(), By::Timeout)]);
        // After a resolve, forget is a no-op (no second ring entry).
        let (id2, _rx2) = reg(&b, "s1", 2);
        b.resolve(&id2, Decision::Deny, By::Desktop);
        b.forget(&id2);
        assert_eq!(b.recent_resolutions().len(), 2);
    }

    #[test]
    fn pending_is_oldest_first_and_carries_the_summary() {
        let b = Broker::default();
        let (late, _r1) = reg(&b, "s1", 20);
        let (early, _r2) = b.register_held(
            "s2".into(),
            "Edit".into(),
            json!({ "file_path": "/x/y.rs", "old_string": "a", "new_string": "b" }),
            10,
            false,
        );
        let p = b.pending();
        assert_eq!(
            p.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            [early.as_str(), late.as_str()]
        );
        assert_eq!(p[0].summary, "/x/y.rs");
        assert_eq!(p[1].summary, "ls");
        let v = serde_json::to_value(&p[0]).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["createdMs", "id", "session", "summary", "toolName"]);
    }

    #[test]
    fn the_ring_keeps_only_the_last_64() {
        let b = Broker::default();
        for i in 0..70 {
            let (id, _rx) = reg(&b, "s", i);
            b.resolve(&id, Decision::Allow, By::Desktop);
        }
        let ring = b.recent_resolutions();
        assert_eq!(ring.len(), crate::asks::RECENT_RESOLUTIONS);
        assert_eq!(ring.last().unwrap().0, "perm-70");
    }

    #[test]
    fn ceilings_ordered() {
        // The compile-time assert enforces the order in every build; restated at run time
        // (through a vec, which clippy does not treat as constant) so a failing order
        // names itself in the test output too, beside the measured values.
        let ladder = vec![
            PERMISSION_CEILING.as_secs(),
            PERMISSION_CURL_MAX_SECS,
            PERMISSION_HOOK_TIMEOUT_SECS,
        ];
        assert!(ladder.windows(2).all(|w| w[0] < w[1]), "{ladder:?}");
        assert_eq!(PERMISSION_CEILING, std::time::Duration::from_secs(300));
        assert_eq!(PERMISSION_CURL_MAX_SECS, 330);
        assert_eq!(PERMISSION_HOOK_TIMEOUT_SECS, 340);
    }

    #[test]
    fn summary_for_bash_edit_other() {
        assert_eq!(
            permission_summary(
                "Bash",
                &json!({ "command": "touch a.txt", "description": "d" })
            ),
            "touch a.txt"
        );
        for tool in ["Edit", "Write", "Read", "MultiEdit"] {
            assert_eq!(
                permission_summary(tool, &json!({ "file_path": "/repo/src/main.rs" })),
                "/repo/src/main.rs",
                "{tool}"
            );
        }
        assert_eq!(
            permission_summary("NotebookEdit", &json!({ "notebook_path": "/n.ipynb" })),
            "/n.ipynb"
        );
        // Anything else -- and a known tool missing its field -- is just its name.
        assert_eq!(
            permission_summary("mcp__srv__do_thing", &json!({ "x": 1 })),
            "mcp__srv__do_thing"
        );
        assert_eq!(permission_summary("Bash", &json!({})), "Bash");
        assert_eq!(permission_summary("WebFetch", &json!(null)), "WebFetch");
        // One line, at most 200 characters (counted in chars, cut on a boundary).
        let multi = permission_summary("Bash", &json!({ "command": "echo a\n\techo b\r\n" }));
        assert_eq!(multi, "echo a echo b");
        let long = "é".repeat(500);
        let s = permission_summary("Bash", &json!({ "command": long }));
        assert_eq!(s.chars().count(), SUMMARY_MAX_CHARS);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn permission_response_shapes() {
        assert_eq!(
            permission_response(Some(&Decision::Allow)),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest",
                "decision":{"behavior":"allow"}}})
        );
        assert_eq!(
            permission_response(Some(&Decision::Deny)),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest",
                "decision":{"behavior":"deny","message":"Denied from Conduit"}}})
        );
        // FAIL-OPEN: hand-off, cancel, timeout and every failure leave Claude's own dialog.
        assert_eq!(permission_response(Some(&Decision::FallThrough)), json!({}));
        assert_eq!(permission_response(None), json!({}));
        // Never rewrite the call or persist a rule.
        let allow = permission_response(Some(&Decision::Allow)).to_string();
        assert!(!allow.contains("updatedInput") && !allow.contains("updatedPermissions"));
    }
}
