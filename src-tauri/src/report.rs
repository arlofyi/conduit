//! `conduit report`: any program in a Conduit session can say what it is doing.
//!
//! Conduit learns a session's status from hooks, and a hook installer exists per agent.
//! A wrapper script, a custom agent, or an agent whose hooks are thin (Command Code fires
//! nothing when a prompt is submitted) had no way in. `conduit report --state working`
//! posts a `report` event to the same hook endpoint, and `translate` turns it into the
//! lifecycle event every consumer already understands -- so nothing downstream has a
//! "report" case, and a reported status and a hooked one cannot disagree about meaning.
//!
//! The contract is Herdr's `pane report-agent` (state, an optional message, an optional
//! ever-increasing `seq`); the wire format and the mapping are ours.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// The lifecycle event a report stands for, and the body that goes with it. `None` for a
/// state this build does not know: an unknown word must not move a status.
pub fn translate(body: &Value) -> Option<(&'static str, Value)> {
    let state = body.get("state")?.as_str()?;
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .map(clean_message);
    match state {
        // A turn started.
        "working" => Some(("prompt", json!({}))),
        // The turn ended and the program is ready for input.
        "idle" | "done" => Some(("stop", json!({}))),
        // It needs the person. `kind` says what for, in the words Claude's own
        // `notification_type` uses, so `status_rules` classifies it with no new case.
        "blocked" => {
            let notification_type = match body.get("kind").and_then(Value::as_str) {
                Some("permission") => "permission_prompt",
                Some("question") => "elicitation_dialog",
                _ => "agent_needs_input",
            };
            let mut out = json!({ "notification_type": notification_type });
            if let Some(m) = message.filter(|m| !m.is_empty()) {
                out["message"] = Value::String(m);
            }
            Some(("notification", out))
        }
        // The turn ended on an error. Same short-identifier rule as `fleet::failure_kind`.
        "error" => Some((
            "stopfailure",
            json!({ "error": body.get("kind").and_then(Value::as_str).unwrap_or("unknown") }),
        )),
        _ => None,
    }
}

/// A message ends up in a desktop notification: one line, bounded, no control characters.
fn clean_message(m: &str) -> String {
    m.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(200)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Drops reports that arrive out of order.
///
/// A reporter fires and forgets, usually in the background, so "working" can land after
/// the "idle" that followed it and leave the session reading as busy for good. A report
/// that carries `seq` is accepted only when its number is higher than the last one
/// accepted for that session; a report without one is always accepted. A timestamp is a
/// fine `seq`.
#[derive(Default)]
pub struct SeqGate {
    last: Mutex<HashMap<String, u64>>,
}

impl SeqGate {
    pub fn accepts(&self, session: &str, seq: Option<u64>) -> bool {
        let Some(seq) = seq else { return true };
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        match last.get(session) {
            Some(&seen) if seq <= seen => false,
            _ => {
                last.insert(session.to_string(), seq);
                true
            }
        }
    }
}

/// The `seq` a report carries, when it is a whole number.
pub fn seq_of(body: &Value) -> Option<u64> {
    body.get("seq").and_then(Value::as_u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(body: Value) -> Option<(&'static str, Value)> {
        translate(&body)
    }

    #[test]
    fn each_state_becomes_the_lifecycle_event_it_stands_for() {
        assert_eq!(event(json!({"state": "working"})).unwrap().0, "prompt");
        assert_eq!(event(json!({"state": "idle"})).unwrap().0, "stop");
        assert_eq!(event(json!({"state": "done"})).unwrap().0, "stop");
        assert_eq!(
            event(json!({"state": "blocked"})).unwrap().0,
            "notification"
        );
        assert_eq!(event(json!({"state": "error"})).unwrap().0, "stopfailure");
    }

    #[test]
    fn an_unknown_or_missing_state_moves_nothing() {
        assert!(event(json!({"state": "thinking"})).is_none());
        assert!(event(json!({"state": 3})).is_none());
        assert!(event(json!({})).is_none());
        assert!(event(Value::Null).is_none());
    }

    #[test]
    fn blocked_says_what_for_in_the_words_status_rules_already_reads() {
        let kind = |k: Value| {
            event(json!({"state": "blocked", "kind": k})).unwrap().1["notification_type"].clone()
        };
        assert_eq!(kind(json!("permission")), "permission_prompt");
        assert_eq!(kind(json!("question")), "elicitation_dialog");
        assert_eq!(kind(json!("something")), "agent_needs_input");
        let (_, body) = event(json!({"state": "blocked"})).unwrap();
        assert_eq!(body["notification_type"], "agent_needs_input");
        // Every one of them reads as needsInput to the status rules.
        for nt in [
            "permission_prompt",
            "elicitation_dialog",
            "agent_needs_input",
        ] {
            assert_eq!(
                crate::status_rules::notification_status(Some(nt), "running", false),
                Some("needsInput")
            );
        }
    }

    #[test]
    fn a_reported_status_drives_the_fleet_mirror_like_a_hooked_one() {
        let mut s = crate::fleet::FleetStatus::default();
        for (state, want) in [
            ("working", "running"),
            ("idle", "done"),
            ("working", "running"),
        ] {
            let (ev, body) = event(json!({ "state": state })).unwrap();
            crate::fleet::apply_event(&mut s, ev, &body);
            assert_eq!(s.status, want, "after reporting {state}");
        }
        let (ev, body) = event(json!({"state": "blocked", "kind": "permission"})).unwrap();
        crate::fleet::apply_event(&mut s, ev, &body);
        assert_eq!(s.status, "needsInput");
        let (ev, body) = event(json!({"state": "error", "kind": "rate_limit"})).unwrap();
        crate::fleet::apply_event(&mut s, ev, &body);
        assert_eq!(s.status, "done");
        assert_eq!(s.failed.as_deref(), Some("rate_limit"));
    }

    #[test]
    fn a_message_is_one_bounded_line() {
        let (_, body) =
            event(json!({"state": "blocked", "message": "  allow\nrm -rf?\u{1b}[31m  "})).unwrap();
        assert_eq!(body["message"], "allow rm -rf? [31m");
        let long = "x".repeat(500);
        let (_, body) = event(json!({"state": "blocked", "message": long})).unwrap();
        assert_eq!(body["message"].as_str().unwrap().len(), 200);
        // An empty message is no message.
        let (_, body) = event(json!({"state": "blocked", "message": "   "})).unwrap();
        assert!(body.get("message").is_none());
    }

    #[test]
    fn a_late_report_cannot_overwrite_a_newer_one() {
        let gate = SeqGate::default();
        assert!(gate.accepts("s", Some(10)));
        assert!(gate.accepts("s", Some(11)));
        // "working" (10) arriving after "idle" (11) is dropped; so is a repeat.
        assert!(!gate.accepts("s", Some(10)));
        assert!(!gate.accepts("s", Some(11)));
        assert!(gate.accepts("s", Some(12)));
        // Sessions do not share a counter.
        assert!(gate.accepts("other", Some(1)));
    }

    #[test]
    fn a_report_without_seq_is_always_taken_and_does_not_reset_the_gate() {
        let gate = SeqGate::default();
        assert!(gate.accepts("s", Some(5)));
        assert!(gate.accepts("s", None));
        assert!(!gate.accepts("s", Some(5)));
        assert_eq!(seq_of(&json!({"seq": 7})), Some(7));
        assert_eq!(seq_of(&json!({"seq": "7"})), None);
        assert_eq!(seq_of(&json!({"seq": -1})), None);
        assert_eq!(seq_of(&json!({})), None);
    }
}
