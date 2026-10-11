//! Pending `AskUserQuestion` prompts held by the blocking `/ask` hook route.
//!
//! Not `broker.rs`: the broker decides allow/deny for an approval; an ask carries the
//! user's ANSWERS and can be handed back to the terminal. Same split as `proposals.rs`.
//! The protocol (allow + `updatedInput.answers`; empty object = the TUI menu appears) was
//! pinned empirically against claude 2.1.293 — see the Continuity view spec §5.1.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

/// How long `/ask` holds a question for the card. MUST stay under curl's `-m` and the hook
/// entry's `timeout` (a test pins the order): past either, the answer reaches nobody.
pub const ASK_CEILING: Duration = Duration::from_secs(600);
pub const ASK_CURL_MAX_SECS: u64 = 650;
pub const ASK_HOOK_TIMEOUT_SECS: u64 = 660;
// Compile-time, so every build enforces the order (not just test builds).
const _: () =
    assert!(ASK_CEILING.as_secs() < ASK_CURL_MAX_SECS && ASK_CURL_MAX_SECS < ASK_HOOK_TIMEOUT_SECS);
pub const MAX_ANSWER_BYTES: usize = 4096;

// Mirrored by hand from src/askProtocol.ts (plan Task 1). Change both together.
pub const MULTISELECT_ANSWERS_SUPPORTED: bool = true;
pub const MULTI_QUESTION_SUPPORTED: bool = true;

#[derive(Clone, Debug, PartialEq)]
pub enum AskOutcome {
    Answered(Map<String, Value>),
    HandOff,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AskView {
    pub id: String,
    pub session: String,
    pub tool_use_id: String,
    pub questions: Value,
    pub created_ms: u64,
}

struct Pending {
    view: AskView,
    tx: SyncSender<AskOutcome>,
}

#[derive(Default)]
pub struct Asks {
    next: AtomicU64,
    pending: Mutex<HashMap<String, Pending>>,
}

impl Asks {
    pub fn register(
        &self,
        session: String,
        tool_use_id: String,
        questions: Value,
        created_ms: u64,
    ) -> (String, Receiver<AskOutcome>) {
        let n = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("ask-{n}");
        let (tx, rx) = sync_channel(1);
        let view = AskView {
            id: id.clone(),
            session,
            tool_use_id,
            questions,
            created_ms,
        };
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), Pending { view, tx });
        (id, rx)
    }

    /// First responder wins: the entry is removed, so a second resolve finds nothing.
    pub fn resolve(&self, id: &str, outcome: AskOutcome) -> bool {
        // Hold the guard across remove + try_send (never blocks on sync_channel(1)), so
        // `forget` + `try_recv` in the holder is a true check-and-set: a resolve either
        // completes before the forget (and is seen by try_recv) or finds nothing.
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        match map.remove(id) {
            Some(p) => {
                let _ = p.tx.try_send(outcome);
                true
            }
            None => false,
        }
    }

    pub fn forget(&self, id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    pub fn get(&self, id: &str) -> Option<AskView> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|p| p.view.clone())
    }

    /// Catch-up for a reload or a newly opened window. Oldest first.
    pub fn pending(&self) -> Vec<AskView> {
        let mut v: Vec<AskView> = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|p| p.view.clone())
            .collect();
        v.sort_by_key(|a| a.created_ms);
        v
    }
}

/// Whether `/ask` may hold questions at all. Set by the frontend (`set_ask_gate`): open
/// only while the Continuity view is open or a Conduit window has focus, so a question
/// nobody can see is never parked. Closed by default — before the frontend says anything,
/// behaviour is exactly today's.
#[derive(Default)]
pub struct AskGate(AtomicBool);

impl AskGate {
    pub fn is_open(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub fn set(&self, open: bool) {
        self.0.store(open, Ordering::SeqCst);
    }
}

/// The `questions` array if this tool input is a shape the card can answer, else None
/// (and the caller hands the question straight to the terminal).
pub fn supported_questions(input: &Value) -> Option<Value> {
    let qs = input.get("questions")?.as_array()?;
    if qs.is_empty() || (qs.len() > 1 && !MULTI_QUESTION_SUPPORTED) {
        return None;
    }
    let mut seen: Vec<&str> = Vec::new();
    for q in qs {
        let text = q.get("question")?.as_str()?;
        if text.trim().is_empty() {
            return None;
        }
        // Answers are keyed by question text: a repeat makes `validate_answers` unpassable.
        if seen.contains(&text) {
            return None;
        }
        seen.push(text);
        let opts = q.get("options")?.as_array()?;
        if opts.is_empty()
            || opts
                .iter()
                .any(|o| o.get("label").and_then(Value::as_str).is_none())
        {
            return None;
        }
        if q.get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !MULTISELECT_ANSWERS_SUPPORTED
        {
            return None;
        }
    }
    Some(Value::Array(qs.clone()))
}

/// Exactly the asked question texts as keys; each value a non-empty string within the cap.
pub fn validate_answers(questions: &Value, answers: &Map<String, Value>) -> Result<(), String> {
    let asked: Vec<&str> = questions
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|q| q.get("question").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    if asked.len() != answers.len() {
        return Err("answer every question exactly once".into());
    }
    for (k, v) in answers {
        if !asked.contains(&k.as_str()) {
            return Err(format!("unknown question: {k}"));
        }
        let s = v.as_str().ok_or("answers must be strings")?;
        if s.trim().is_empty() {
            return Err("empty answer".into());
        }
        if s.len() > MAX_ANSWER_BYTES {
            return Err("answer too long".into());
        }
    }
    Ok(())
}

/// The outcome to honour: the one received in time, else one that slipped in between the
/// timeout firing and the entry being forgotten (checked by the caller with `try_recv`).
pub fn pick_outcome(received: Option<AskOutcome>, late: Option<AskOutcome>) -> Option<AskOutcome> {
    received.or(late)
}

/// The `how` reported in `ask-resolved`.
pub fn how(outcome: &Option<AskOutcome>) -> &'static str {
    match outcome {
        Some(AskOutcome::Answered(_)) => "answered",
        Some(AskOutcome::HandOff) => "handoff",
        None => "timeout",
    }
}

/// The body `/ask` returns, which Claude reads as the hook's stdout. Answered = allow with
/// the original input plus `answers`. Anything else = `{}`, which carries no decision, so
/// Claude shows its own menu exactly as if Conduit were not there (fail-open).
pub fn ask_response(input: &Value, outcome: Option<&AskOutcome>) -> Value {
    let Some(AskOutcome::Answered(answers)) = outcome else {
        return json!({});
    };
    let mut updated = input.as_object().cloned().unwrap_or_default();
    updated.insert("answers".into(), Value::Object(answers.clone()));
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "Answered in Conduit",
            "updatedInput": Value::Object(updated),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn one_q() -> Value {
        json!({"questions":[{"question":"Pick a fruit","header":"Fruit","multiSelect":false,
            "options":[{"label":"Apple","description":"red"},{"label":"Banana","description":"yellow"}]}]})
    }

    #[test]
    fn forget_then_resolve_delivers_nothing_and_resolve_then_forget_is_seen() {
        let asks = Asks::default();
        let (a, rx_a) = asks.register("s".into(), "t".into(), json!([]), 0);
        asks.forget(&a);
        assert!(!asks.resolve(&a, AskOutcome::HandOff));
        assert!(rx_a.try_recv().is_err(), "nothing may arrive after forget");
        let (b, rx_b) = asks.register("s".into(), "t".into(), json!([]), 0);
        assert!(asks.resolve(&b, AskOutcome::HandOff));
        asks.forget(&b);
        assert_eq!(rx_b.try_recv().unwrap(), AskOutcome::HandOff);
    }

    #[test]
    fn supported_questions_refuses_duplicate_question_text() {
        let dup = json!({"questions":[
            {"question":"Same?","options":[{"label":"x"}]},
            {"question":"Same?","options":[{"label":"y"}]}]});
        assert!(supported_questions(&dup).is_none());
    }

    #[test]
    fn pick_outcome_prefers_a_late_resolve_over_timeout() {
        assert_eq!(
            pick_outcome(Some(AskOutcome::HandOff), None),
            Some(AskOutcome::HandOff)
        );
        assert_eq!(
            pick_outcome(None, Some(AskOutcome::HandOff)),
            Some(AskOutcome::HandOff)
        );
        assert_eq!(pick_outcome(None, None), None);
        assert_eq!(how(&None), "timeout");
        assert_eq!(how(&Some(AskOutcome::HandOff)), "handoff");
        assert_eq!(how(&Some(AskOutcome::Answered(Map::new()))), "answered");
    }

    #[test]
    fn first_responder_wins_and_ids_are_independent() {
        let asks = Asks::default();
        let (a, rx_a) = asks.register("s1".into(), "tu1".into(), one_q()["questions"].clone(), 1);
        let (b, rx_b) = asks.register("s1".into(), "tu2".into(), one_q()["questions"].clone(), 2);
        assert_ne!(a, b);
        assert!(asks.resolve(&a, AskOutcome::HandOff));
        assert!(
            !asks.resolve(&a, AskOutcome::HandOff),
            "second resolve is a no-op"
        );
        assert_eq!(rx_a.try_recv().unwrap(), AskOutcome::HandOff);
        assert!(rx_b.try_recv().is_err(), "answering a must not touch b");
        assert_eq!(asks.pending().len(), 1);
        assert_eq!(asks.pending()[0].id, b);
    }

    #[test]
    fn resolve_after_forget_reports_false() {
        let asks = Asks::default();
        let (id, _rx) = asks.register("s".into(), "t".into(), json!([]), 0);
        asks.forget(&id);
        assert!(!asks.resolve(&id, AskOutcome::HandOff));
        assert!(asks.get(&id).is_none());
    }

    #[test]
    fn pending_is_oldest_first() {
        let asks = Asks::default();
        let (late, _r1) = asks.register("s".into(), "t1".into(), json!([]), 50);
        let (early, _r2) = asks.register("s".into(), "t2".into(), json!([]), 10);
        let ids: Vec<String> = asks.pending().into_iter().map(|v| v.id).collect();
        assert_eq!(ids, vec![early, late]);
    }

    #[test]
    fn gate_defaults_closed() {
        let g = AskGate::default();
        assert!(!g.is_open());
        g.set(true);
        assert!(g.is_open());
    }

    #[test]
    fn supported_questions_accepts_the_spike_shape() {
        assert!(supported_questions(&one_q()).is_some());
    }

    #[test]
    fn supported_questions_refuses_garbage() {
        assert!(supported_questions(&json!({})).is_none());
        assert!(supported_questions(&json!({"questions":[]})).is_none());
        assert!(supported_questions(&json!({"questions":[{"question":"x"}]})).is_none());
        assert!(supported_questions(
            &json!({"questions":[{"question":"","options":[{"label":"a"}]}]})
        )
        .is_none());
    }

    #[test]
    fn supported_questions_honours_the_pinned_flags() {
        let multi = json!({"questions":[
            {"question":"A","options":[{"label":"x"}]},
            {"question":"B","options":[{"label":"y"}]}]});
        assert_eq!(
            supported_questions(&multi).is_some(),
            MULTI_QUESTION_SUPPORTED
        );
        let ms = json!({"questions":[{"question":"A","multiSelect":true,"options":[{"label":"x"},{"label":"y"}]}]});
        assert_eq!(
            supported_questions(&ms).is_some(),
            MULTISELECT_ANSWERS_SUPPORTED
        );
    }

    #[test]
    fn validate_answers_requires_exactly_the_asked_questions() {
        let qs = one_q()["questions"].clone();
        let ok: Map<String, Value> =
            serde_json::from_value(json!({"Pick a fruit":"Apple"})).unwrap();
        assert!(validate_answers(&qs, &ok).is_ok());
        let free: Map<String, Value> =
            serde_json::from_value(json!({"Pick a fruit":"Mango"})).unwrap();
        assert!(validate_answers(&qs, &free).is_ok(), "free text is allowed");
        let unknown: Map<String, Value> =
            serde_json::from_value(json!({"Other?":"Apple"})).unwrap();
        assert!(validate_answers(&qs, &unknown).is_err());
        let empty: Map<String, Value> =
            serde_json::from_value(json!({"Pick a fruit":"  "})).unwrap();
        assert!(validate_answers(&qs, &empty).is_err());
        let missing = Map::new();
        assert!(validate_answers(&qs, &missing).is_err());
        let big: Map<String, Value> =
            serde_json::from_value(json!({"Pick a fruit": "x".repeat(MAX_ANSWER_BYTES + 1)}))
                .unwrap();
        assert!(validate_answers(&qs, &big).is_err());
        let not_str: Map<String, Value> =
            serde_json::from_value(json!({"Pick a fruit": 3})).unwrap();
        assert!(validate_answers(&qs, &not_str).is_err());
    }

    #[test]
    fn answered_response_merges_answers_into_the_original_input() {
        let input = one_q();
        let answers: Map<String, Value> =
            serde_json::from_value(json!({"Pick a fruit":"Apple"})).unwrap();
        let out = ask_response(&input, Some(&AskOutcome::Answered(answers)));
        let h = &out["hookSpecificOutput"];
        assert_eq!(h["hookEventName"], "PreToolUse");
        assert_eq!(h["permissionDecision"], "allow");
        assert_eq!(h["updatedInput"]["answers"]["Pick a fruit"], "Apple");
        assert_eq!(
            h["updatedInput"]["questions"], input["questions"],
            "questions preserved"
        );
    }

    #[test]
    fn handoff_and_timeout_are_empty_objects() {
        assert_eq!(
            ask_response(&one_q(), Some(&AskOutcome::HandOff)),
            json!({})
        );
        assert_eq!(ask_response(&one_q(), None), json!({}));
    }
}
