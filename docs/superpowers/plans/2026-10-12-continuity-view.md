# Continuity View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-project "Continuity" center view that draws sessions as animal avatars linked by the Continuity messages they exchange (pulsing live), surfaces Claude Code `AskUserQuestion` prompts as answerable cards beside the asking avatar, and (0.42.0) tabulates every Continuity service — while Canvas and Board move behind Settings toggles.

**Architecture:** Rust owns everything that touches a process boundary: a blocking `/ask` hook route + `asks.rs` registry (answers flow back on the HTTP response, the spike-proven `updatedInput.answers` protocol), a `continuity_watch.rs` thread that polls `PRAGMA data_version` and emits `continuity-changed` with new message rows, and a scoped `continuity_graph` snapshot read. TypeScript owns pure view logic in store-free modules (`centerViews.ts`, `asks.ts`, `avatarId.ts`, `graphLayout.ts`, `continuityGraph.ts`), and DOM/SVG components mounted as a center-mode overlay exactly like the task board — terminals stay mounted underneath.

**Tech Stack:** Tauri v2, Rust (rusqlite 0.32 bundled, tiny_http, serde_json), React 19 + TypeScript + Zustand, vitest (node env).

**Spec:** `docs/superpowers/specs/2026-10-12-continuity-view-design.md` (read it before any task).

## Global Constraints

- Worktree: `/Users/uzairhayat/ooozzy/conduit/.worktrees/continuity-view`, branch `feat/continuity-view`. Never work in the main checkout. Commit after every task.
- Commits: Conventional Commits, scoped (`feat(continuity): …`). **No `Co-Authored-By` or any AI trailer** (CLAUDE.md).
- Conduit **never writes** the Continuity DB. Every connection is `continuity_read::open_ro`.
- No new Rust or npm dependencies.
- Ask ceilings, exact: `ASK_CEILING = 600 s` < curl `-m 650` < hook entry `"timeout": 660`.
- Every `/ask` failure path answers `{}` (fail-open: never deny, never hang past the ceiling).
- `/ask` refuses any request carrying an `Origin` header, checked first.
- Pref keys/defaults exact: `conduit.canvasEnabled` default off (`=== "1"`), `conduit.boardEnabled` default off (`=== "1"`), `conduit.continuityViewEnabled` default on (`!== "0"`).
- Keep-alive rule: never unmount/reparent a `TerminalView`; the new view is an overlay.
- Pure TS logic lives in modules that do NOT import `store.ts` (it touches `localStorage` at module scope and throws under node-env vitest).
- Every colour via theme tokens (`--panel-bg`, `--sidebar-bg`, `--selection-bg`, `--border`, `--text-bright/mid/dim`, `--accent`, `--amber`, `--green`, `--red`, `--hq-grid-line`); only the animal art has fixed fills. Every animation is dropped under `prefers-reduced-motion`.
- Dev app only as `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev` (shared `state.json` otherwise).
- Gates before calling a task done: `pnpm exec tsc --noEmit`, `pnpm test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check`.
- Cargo needs `export PATH="$HOME/.cargo/bin:$PATH"` in this environment; to save a full rebuild set `CARGO_TARGET_DIR=/Users/uzairhayat/ooozzy/conduit/src-tauri/target`.

## Review Focus

1. **A Conduit project's `.claude/settings.local.json` is also read by the user's own `claude` run in that checkout outside Conduit.** `CONDUIT_SESSION_ID` is unset there, so the URL carries `session=unknown`; `/ask` must answer `{}` at once (no card, no delay). Test in Task 4.
2. **Two sessions ask at once, or one session asks twice in a row.** Each card must resolve its own id; answering one must never answer the other. Test in Task 2 (registry) and Task 8 (store keyed by id).
3. **The card is clicked after the hook already gave up** (handoff by opening the terminal, or the 600 s ceiling). `ask_answer` returns `false`, the card says "Already answered in the terminal", nothing throws. Tests in Task 2 and Task 4.
4. **Continuity's DB disappears, is replaced, or its schema drifts while Conduit runs** (continuity upgrade, `rm -rf ~/.continuity`). The watcher backs off and re-opens; the view shows the unavailable state; no panic, no busy loop. Test in Task 5.
5. **A pulse names a session that is not (or no longer) a node** (gone mid-flight, visitor window expired, other project). The pulse is dropped silently; no edge is invented. Test in Task 10.

---

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/asks.rs` (new) | Ask registry, gate, answer validation, hook response JSON. Pure + `Mutex` state. |
| `src-tauri/src/hooks.rs` | `/ask` row + command builder, `is_conduit_entry` marker, `/ask` dispatch + `handle_ask`. |
| `src-tauri/src/continuity_fixture.rs` (new, `#[cfg(test)]`) | One copy of Continuity's DDL for all seven tables + temp DB paths, for the new modules' tests. |
| `src-tauri/src/continuity_watch.rs` (new) | `Watcher::tick` (data_version + message cursor) and the thread that emits `continuity-changed`. |
| `src-tauri/src/continuity_graph.rs` (new) | `graph_from_db` membership/edges/unread snapshot. |
| `src-tauri/src/continuity_tables.rs` (new, 0.42.0) | Handoffs / tasks / files / activity reads. |
| `src-tauri/src/lib.rs` | `mod` lines, managed state, commands, watcher start, shared `project_toplevels`. |
| `src/centerViews.ts` (new) | `CenterMode`, view prefs, exclusion/gating rules. |
| `src/asks.ts` (new) | Ask types, gate/hand-off rules, answer building. |
| `src/avatarId.ts` (new) | `sessionAnimal(key)` — the stable hash. |
| `src/avatars.tsx` (new) | The 12 animal SVGs + `<SessionAvatar>`. |
| `src/graphLayout.ts` (new) | Deterministic force layout + pins. |
| `src/continuityGraph.ts` (new) | Snapshot types, pulse filter, pin storage. |
| `src/hooks/useContinuityGraph.ts` (new) | Snapshot fetch + `continuity-changed` → pulses + debounced refetch. |
| `src/components/ContinuityView.tsx` (new) | Overlay shell: tabs, project chip, graph/tables. |
| `src/components/ContinuityGraph.tsx` (new) | SVG edges, pulses, avatar nodes, pan/zoom, drag-pin. |
| `src/components/AskCard.tsx` (new) | One card (graph-anchored or docked). |
| `src/components/AskDock.tsx` (new) | Bottom-right dock when the view is closed. |
| `src/components/SessionDrawer.tsx` (new) | Avatar-click drawer. |
| `src/components/ContinuityTables.tsx` (new, 0.42.0) | The five service tables. |
| `src/store.ts`, `src/App.tsx`, `src/components/{WorkspaceCenter,CommandPalette,GeneralSettings,SessionChat}.tsx`, `src/theme.css` | Wiring. |

---

# Increment 1 — 0.41.0

### Task 1: Pin the multiSelect and multi-question answer formats (empirical)

The spike (memory `conduit-askuserquestion-hook-answer`) proved single-question, single-select answering. Two shapes are unproven. This task runs a throwaway probe and records the result as two constants that later tasks consume. No product code except the constants file.

**Files:**
- Create: `src/askProtocol.ts`
- Modify: `docs/superpowers/specs/2026-10-12-continuity-view-design.md` (§5.1 "Not yet pinned" → findings)

**Interfaces:**
- Produces: `export const MULTISELECT_ANSWERS_SUPPORTED: boolean`, `export const MULTISELECT_JOIN: string`, `export const MULTI_QUESTION_SUPPORTED: boolean` (TS) — and the same three as Rust `pub const`s in Task 2 (`asks.rs`), copied by hand with a comment pointing here.

- [ ] **Step 1: Build the probe in the session scratchpad (never the repo)**

```bash
S=/private/tmp/claude-501/-Users-uzairhayat-ooozzy-conduit/3ba2ec83-ff19-4ada-81d7-d5108c1a67b7/scratchpad/auq-pin
mkdir -p $S/.claude && cd $S && git init -q
cat > hook.py <<'EOF'
import sys, json, os
d = json.load(sys.stdin)
open(os.path.join(os.path.dirname(__file__), "hook.log"), "a").write(json.dumps(d) + "\n")
ti = d.get("tool_input", {})
answers = {}
for q in ti.get("questions", []):
    labels = [o["label"] for o in q["options"]]
    answers[q["question"]] = ", ".join(labels[:2]) if q.get("multiSelect") else labels[0]
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
      "updatedInput": {**ti, "answers": answers}}}))
EOF
cat > .claude/settings.json <<EOF
{"hooks":{"PreToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"python3 $S/hook.py","timeout":60}]}]}}
EOF
```

- [ ] **Step 2: Run it interactively under a private tmux socket**

```bash
tmux -L auqpin new-session -d -s p -x 160 -y 50 -c $S "claude; sleep 600"; sleep 7
tmux -L auqpin capture-pane -p -t p | grep -q "trust this folder" && { tmux -L auqpin send-keys -t p Down; sleep .5; tmux -L auqpin send-keys -t p Enter; sleep 6; }
tmux -L auqpin send-keys -t p -l "Call AskUserQuestion ONCE with TWO questions: (1) 'Pick fruits' multiSelect true, options Apple, Banana, Cherry; (2) 'Pick a color' options Red, Blue. Then reply exactly: Q1=<answer verbatim> Q2=<answer verbatim>"
tmux -L auqpin send-keys -t p Enter; sleep 40
tmux -L auqpin capture-pane -p -t p | grep -v '^$' | tail -14
tmux -L auqpin kill-server
```

Expected (success): the transcript shows `User answered Claude's questions:` with `Pick fruits → Apple, Banana` and `Pick a color → Red`, and the reply reads `Q1=Apple, Banana Q2=Red`. If the menu appears instead, or an answer is missing, that shape is NOT supported.

- [ ] **Step 3: Record the result in `src/askProtocol.ts`**

```ts
// Empirically pinned against the real `claude` CLI (see docs/superpowers/plans/
// 2026-10-12-continuity-view.md, Task 1). Mirrored by hand in src-tauri/src/asks.rs —
// change both together. A shape marked unsupported is handed to the terminal menu
// rather than guessed at.
export const MULTISELECT_ANSWERS_SUPPORTED = true; // set from Step 2's observation
export const MULTISELECT_JOIN = ", ";
export const MULTI_QUESTION_SUPPORTED = true; // set from Step 2's observation
```

Set each boolean to what Step 2 actually showed, and write the observed transcript lines into the spec's §5.1 in place of the "Not yet pinned" paragraph (include the claude version from `claude --version`).

- [ ] **Step 4: Commit**

```bash
git add src/askProtocol.ts docs/superpowers/specs/2026-10-12-continuity-view-design.md
git commit -m "spike(continuity): pin AskUserQuestion multiSelect and multi-question answer formats"
```

---

### Task 2: `asks.rs` — registry, gate, validation, hook response

**Files:**
- Create: `src-tauri/src/asks.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod asks;` beside the other `mod` lines, alphabetical)

**Interfaces:**
- Consumes: Task 1's three constants (copied).
- Produces (all `pub`): `ASK_CEILING: Duration`, `ASK_CURL_MAX_SECS: u64 = 650`, `ASK_HOOK_TIMEOUT_SECS: u64 = 660`, `MAX_ANSWER_BYTES: usize = 4096`; `enum AskOutcome { Answered(Map<String,Value>), HandOff }`; `struct AskView { id, session, tool_use_id, questions: Value, created_ms: u64 }` (serde camelCase); `struct Asks` with `register(&self, session: String, tool_use_id: String, questions: Value, created_ms: u64) -> (String, Receiver<AskOutcome>)`, `resolve(&self, id: &str, outcome: AskOutcome) -> bool`, `forget(&self, id: &str)`, `get(&self, id: &str) -> Option<AskView>`, `pending(&self) -> Vec<AskView>`; `struct AskGate` with `is_open()`, `set(bool)`; `fn supported_questions(input: &Value) -> Option<Value>`; `fn validate_answers(questions: &Value, answers: &Map<String,Value>) -> Result<(), String>`; `fn ask_response(input: &Value, outcome: Option<&AskOutcome>) -> Value`.

- [ ] **Step 1: Write the failing tests (bottom of the new file)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn one_q() -> Value {
        json!({"questions":[{"question":"Pick a fruit","header":"Fruit","multiSelect":false,
            "options":[{"label":"Apple","description":"red"},{"label":"Banana","description":"yellow"}]}]})
    }

    #[test]
    fn ceilings_are_strictly_ordered() {
        assert!(ASK_CEILING.as_secs() < ASK_CURL_MAX_SECS);
        assert!(ASK_CURL_MAX_SECS < ASK_HOOK_TIMEOUT_SECS);
    }

    #[test]
    fn first_responder_wins_and_ids_are_independent() {
        let asks = Asks::default();
        let (a, rx_a) = asks.register("s1".into(), "tu1".into(), one_q()["questions"].clone(), 1);
        let (b, rx_b) = asks.register("s1".into(), "tu2".into(), one_q()["questions"].clone(), 2);
        assert_ne!(a, b);
        assert!(asks.resolve(&a, AskOutcome::HandOff));
        assert!(!asks.resolve(&a, AskOutcome::HandOff), "second resolve is a no-op");
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
        assert!(supported_questions(&json!({"questions":[{"question":"","options":[{"label":"a"}]}]})).is_none());
    }

    #[test]
    fn supported_questions_honours_the_pinned_flags() {
        let multi = json!({"questions":[
            {"question":"A","options":[{"label":"x"}]},
            {"question":"B","options":[{"label":"y"}]}]});
        assert_eq!(supported_questions(&multi).is_some(), MULTI_QUESTION_SUPPORTED);
        let ms = json!({"questions":[{"question":"A","multiSelect":true,"options":[{"label":"x"},{"label":"y"}]}]});
        assert_eq!(supported_questions(&ms).is_some(), MULTISELECT_ANSWERS_SUPPORTED);
    }

    #[test]
    fn validate_answers_requires_exactly_the_asked_questions() {
        let qs = one_q()["questions"].clone();
        let ok: Map<String, Value> = serde_json::from_value(json!({"Pick a fruit":"Apple"})).unwrap();
        assert!(validate_answers(&qs, &ok).is_ok());
        let free: Map<String, Value> = serde_json::from_value(json!({"Pick a fruit":"Mango"})).unwrap();
        assert!(validate_answers(&qs, &free).is_ok(), "free text is allowed");
        let unknown: Map<String, Value> = serde_json::from_value(json!({"Other?":"Apple"})).unwrap();
        assert!(validate_answers(&qs, &unknown).is_err());
        let empty: Map<String, Value> = serde_json::from_value(json!({"Pick a fruit":"  "})).unwrap();
        assert!(validate_answers(&qs, &empty).is_err());
        let missing = Map::new();
        assert!(validate_answers(&qs, &missing).is_err());
        let big: Map<String, Value> =
            serde_json::from_value(json!({"Pick a fruit": "x".repeat(MAX_ANSWER_BYTES + 1)})).unwrap();
        assert!(validate_answers(&qs, &big).is_err());
        let not_str: Map<String, Value> = serde_json::from_value(json!({"Pick a fruit": 3})).unwrap();
        assert!(validate_answers(&qs, &not_str).is_err());
    }

    #[test]
    fn answered_response_merges_answers_into_the_original_input() {
        let input = one_q();
        let answers: Map<String, Value> = serde_json::from_value(json!({"Pick a fruit":"Apple"})).unwrap();
        let out = ask_response(&input, Some(&AskOutcome::Answered(answers)));
        let h = &out["hookSpecificOutput"];
        assert_eq!(h["hookEventName"], "PreToolUse");
        assert_eq!(h["permissionDecision"], "allow");
        assert_eq!(h["updatedInput"]["answers"]["Pick a fruit"], "Apple");
        assert_eq!(h["updatedInput"]["questions"], input["questions"], "questions preserved");
    }

    #[test]
    fn handoff_and_timeout_are_empty_objects() {
        assert_eq!(ask_response(&one_q(), Some(&AskOutcome::HandOff)), json!({}));
        assert_eq!(ask_response(&one_q(), None), json!({}));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml asks::`
Expected: FAIL to compile (`Asks` etc. not defined).

- [ ] **Step 3: Implement (top of `src-tauri/src/asks.rs`)**

```rust
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
        let view = AskView { id: id.clone(), session, tool_use_id, questions, created_ms };
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), Pending { view, tx });
        (id, rx)
    }

    /// First responder wins: the entry is removed, so a second resolve finds nothing.
    pub fn resolve(&self, id: &str, outcome: AskOutcome) -> bool {
        let entry = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        match entry {
            Some(p) => {
                let _ = p.tx.try_send(outcome);
                true
            }
            None => false,
        }
    }

    pub fn forget(&self, id: &str) {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
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
    for q in qs {
        let text = q.get("question")?.as_str()?;
        if text.trim().is_empty() {
            return None;
        }
        let opts = q.get("options")?.as_array()?;
        if opts.is_empty() || opts.iter().any(|o| o.get("label").and_then(Value::as_str).is_none()) {
            return None;
        }
        if q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false) && !MULTISELECT_ANSWERS_SUPPORTED {
            return None;
        }
    }
    Some(Value::Array(qs.clone()))
}

/// Exactly the asked question texts as keys; each value a non-empty string within the cap.
pub fn validate_answers(questions: &Value, answers: &Map<String, Value>) -> Result<(), String> {
    let asked: Vec<&str> = questions
        .as_array()
        .map(|a| a.iter().filter_map(|q| q.get("question").and_then(Value::as_str)).collect())
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
```

Set the two `pub const` booleans to Task 1's results. Add `mod asks;` to `lib.rs`. Until Task 4 uses them, add `#![cfg_attr(not(test), allow(dead_code))]` at the top of `asks.rs` and remove it in Task 4.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml asks::`
Expected: PASS (11 tests). Then `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/asks.rs src-tauri/src/lib.rs
git commit -m "feat(continuity): AskUserQuestion registry, gate and hook response"
```

---

### Task 3: Install the `AskUserQuestion` hook row

**Files:**
- Modify: `src-tauri/src/hooks.rs` (`claude_profile` ~:880, `entries_for` ~:829, new `ask_command` beside `command` ~:1132, `is_conduit_entry` ~:1198, tests module)

**Interfaces:**
- Consumes: `crate::asks::{ASK_CURL_MAX_SECS, ASK_HOOK_TIMEOUT_SECS}`.
- Produces: `pub const ASK_VERB: &str = "ask"`; the installed entry `{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":<ask cmd>,"timeout":660}]}` under `PreToolUse`; a POST to `/ask?session=<id>` whose response body reaches Claude's stdout.

- [ ] **Step 1: Write the failing tests (in `hooks.rs`'s `mod tests`)**

```rust
    #[test]
    fn claude_profile_installs_a_blocking_ask_row() {
        let rows = claude_profile().rows;
        let ask: Vec<_> = rows.iter().filter(|r| r.verb == ASK_VERB).collect();
        assert_eq!(ask.len(), 1);
        assert_eq!(ask[0].event, "PreToolUse");
        assert_eq!(ask[0].matcher, Some("AskUserQuestion"));
    }

    #[test]
    fn only_the_ask_entry_carries_a_timeout_and_a_long_curl() {
        let entries = entries_for(&claude_profile().rows, 8423);
        let mut asks = 0;
        for (_event, list) in &entries {
            for e in list {
                let h = &e["hooks"][0];
                let cmd = h["command"].as_str().unwrap();
                if e["matcher"] == "AskUserQuestion" {
                    asks += 1;
                    assert_eq!(h["timeout"], json!(crate::asks::ASK_HOOK_TIMEOUT_SECS));
                    assert!(cmd.contains(&format!("-m {}", crate::asks::ASK_CURL_MAX_SECS)));
                    assert!(cmd.contains("/ask?session="));
                    assert!(cmd.contains(" -f "), "an HTTP error must print nothing");
                    assert!(!cmd.contains(">/dev/null") && !cmd.contains(">NUL 2"),
                        "the response body IS the hook's stdout");
                } else {
                    assert!(h.get("timeout").is_none(), "no other row grows a timeout");
                    assert!(cmd.contains("-m 2 "));
                }
            }
        }
        assert_eq!(asks, 1);
    }

    #[test]
    fn reinstall_does_not_duplicate_the_ask_entry() {
        let dir = fresh_test_dir("ask-idempotent");
        install_profile_at(&dir, &claude_profile(), 8423);
        install_profile_at(&dir, &claude_profile(), 8424);
        let v: Value = serde_json::from_str(
            &fs::read_to_string(Path::new(&dir).join(".claude/settings.local.json")).unwrap(),
        )
        .unwrap();
        let n = v["hooks"]["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["matcher"] == "AskUserQuestion")
            .count();
        assert_eq!(n, 1);
    }
```

Before writing these, open `install_profile_at` (~:1024) and `fresh_test_dir` in the tests module and match their real signatures — if `install_profile_at` takes `&Path` or returns a value, adapt the two calls; the assertions stay as written.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hooks::tests::claude_profile_installs_a_blocking_ask_row hooks::tests::only_the_ask hooks::tests::reinstall_does_not`
Expected: FAIL (`ASK_VERB` not found).

- [ ] **Step 3: Implement**

Add near the top of `hooks.rs`:

```rust
/// The verb (and route) of the blocking `AskUserQuestion` hook. See `asks.rs`.
pub const ASK_VERB: &str = "ask";
```

Append to `claude_profile()`'s `rows` (after the unmatched `pretool` row — both fire; the unmatched one only feeds activity):

```rust
            HookRow {
                event: "PreToolUse",
                matcher: Some("AskUserQuestion"),
                verb: ASK_VERB,
            },
```

In `entries_for`, replace `entry.insert("hooks".into(), Value::Array(vec![command(r.verb, port)]));` with:

```rust
        let cmd = if r.verb == ASK_VERB {
            ask_command(port)
        } else {
            command(r.verb, port)
        };
        entry.insert("hooks".into(), Value::Array(vec![cmd]));
```

Add beside `command`:

```rust
/// The blocking `AskUserQuestion` hook. Unlike `command`, its stdout is NOT discarded:
/// `/ask`'s response body IS the hook output Claude reads (allow + answers, or `{}`).
/// `-f` makes an HTTP error print nothing, and `|| true` swallows a dead socket, so every
/// failure reaches Claude as empty output — the normal menu. `-m` and the entry's
/// `timeout` are the outer two of the three ceilings `asks.rs` pins.
fn ask_command(port: u16) -> Value {
    let max = crate::asks::ASK_CURL_MAX_SECS;
    #[cfg(windows)]
    let cmd = {
        let url = format!("http://127.0.0.1:{port}/ask?session=%CONDUIT_SESSION_ID%");
        format!(
            "curl -s -f -m {max} -X POST -H \"Content-Type: application/json\" --data-binary @- \"{url}\" 2>NUL || ver >NUL"
        )
    };
    #[cfg(not(windows))]
    let cmd = {
        let url = format!(
            "http://127.0.0.1:${{CONDUIT_HOOK_PORT:-{port}}}/ask?session=${{CONDUIT_SESSION_ID:-unknown}}"
        );
        format!(
            "[ -n \"$CONDUIT_HOOK_ENDPOINT\" ] && [ -r \"$CONDUIT_HOOK_ENDPOINT\" ] && . \"$CONDUIT_HOOK_ENDPOINT\"; \
             curl -s -f -m {max} -X POST -H \"Content-Type: application/json\" --data-binary @- \"{url}\" 2>/dev/null || true"
        )
    };
    json!({ "type": "command", "command": cmd, "timeout": crate::asks::ASK_HOOK_TIMEOUT_SECS })
}
```

In `is_conduit_entry`, match either route so reinstall strips the old ask entry too:

```rust
    #[cfg(windows)]
    const MARKERS: [&str; 2] = ["/hook?session=%CONDUIT_SESSION_ID%", "/ask?session=%CONDUIT_SESSION_ID%"];
    #[cfg(not(windows))]
    const MARKERS: [&str; 2] = ["/hook?session=${CONDUIT_SESSION_ID", "/ask?session=${CONDUIT_SESSION_ID"];
```

and change the inner check from `contains(MARKER)` to `MARKERS.iter().any(|m| cmd.contains(m))` (keep the surrounding code's exact shape).

Check `command_code_profile()` does NOT gain the row (it builds its own `rows`); `opencode` and others are untouched.

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hooks::`
Expected: PASS, including every pre-existing hooks test (some count PreToolUse entries — if one asserts an exact count of Claude rows, update it by one and say so in the commit body).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hooks.rs
git commit -m "feat(continuity): install a blocking AskUserQuestion hook for Claude sessions"
```

---

### Task 4: The `/ask` route and its Tauri commands

**Files:**
- Modify: `src-tauri/src/hooks.rs` (`start` signature + dispatch beside `/approve` ~:199, new `handle_ask`, new pure `ask_decision`)
- Modify: `src-tauri/src/lib.rs` (manage `Arc<asks::Asks>` + `Arc<asks::AskGate>`, pass to `hooks::start` ~:2658, commands, `invoke_handler`)
- Modify: `src-tauri/src/asks.rs` (drop the temporary `dead_code` allow)

**Interfaces:**
- Consumes: Task 2 API, Task 3 route name.
- Produces: events `ask-request` (payload = `AskView`, camelCase) and `ask-resolved` (`{ id, how: "answered"|"handoff"|"timeout" }`); commands `ask_answer(id: String, answers: Map<String,Value>) -> Result<bool,String>`, `ask_handoff(id: String) -> bool`, `ask_pending() -> Vec<AskView>`, `set_ask_gate(open: bool)`.

- [ ] **Step 1: Write the failing tests (pure decision, in `hooks.rs` tests)**

`handle_ask` does I/O, so its every early-exit is factored into a pure function first:

```rust
    #[test]
    fn ask_decision_fails_open_on_every_refusal() {
        let known = |s: &str| s == "sess-1";
        let body = json!({"tool_name":"AskUserQuestion","tool_use_id":"tu",
            "tool_input":{"questions":[{"question":"Q?","options":[{"label":"A"}]}]}});
        assert!(matches!(ask_decision(true, false, Some("sess-1"), &body, known), AskDecision::Hold { .. }));
        assert_eq!(ask_decision(true, true, Some("sess-1"), &body, known), AskDecision::Skip, "Origin refused");
        assert_eq!(ask_decision(false, false, Some("sess-1"), &body, known), AskDecision::Skip, "gate closed");
        assert_eq!(ask_decision(true, false, Some("unknown"), &body, known), AskDecision::Skip,
            "a claude outside Conduit reads the same settings file");
        assert_eq!(ask_decision(true, false, None, &body, known), AskDecision::Skip);
        let bad = json!({"tool_input":{"questions":[]}});
        assert_eq!(ask_decision(true, false, Some("sess-1"), &bad, known), AskDecision::Skip);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hooks::tests::ask_decision`
Expected: FAIL (`ask_decision` not found).

- [ ] **Step 3: Implement**

In `hooks.rs`:

```rust
#[derive(Debug, PartialEq)]
enum AskDecision {
    /// Answer `{}` now: Claude shows its own menu.
    Skip,
    Hold { session: String, tool_use_id: String, questions: Value },
}

/// Every reason `/ask` declines to hold a question, in one pure place. `has_origin` is
/// checked FIRST (a browser page must not raise cards), then the gate, then whether the
/// session is one of ours — the same settings file is read by a `claude` the user runs by
/// hand in that checkout, which posts `session=unknown`.
fn ask_decision(
    gate_open: bool,
    has_origin: bool,
    session: Option<&str>,
    body: &Value,
    known_session: impl Fn(&str) -> bool,
) -> AskDecision {
    if has_origin || !gate_open {
        return AskDecision::Skip;
    }
    let Some(session) = session.filter(|s| known_session(s)) else {
        return AskDecision::Skip;
    };
    let Some(questions) = body.get("tool_input").and_then(crate::asks::supported_questions) else {
        return AskDecision::Skip;
    };
    AskDecision::Hold {
        session: session.to_string(),
        tool_use_id: body.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string(),
        questions,
    }
}

/// Blocking `AskUserQuestion` handler (own thread, like `/approve`). The HTTP response is
/// the hook's stdout. Every path answers — `{}` unless the card answered in time.
fn handle_ask(
    mut request: Request,
    url: &str,
    app: &AppHandle,
    asks: &crate::asks::Asks,
    gate: &crate::asks::AskGate,
    store: &crate::store::Store,
) {
    let has_origin = request.headers().iter().any(|h| h.field.equiv("Origin"));
    let (session, _event) = parse_query(url);
    let mut body = String::new();
    let _ = request.as_reader().take(1024 * 1024).read_to_string(&mut body);
    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let input = parsed.get("tool_input").cloned().unwrap_or(Value::Null);

    let known = |id: &str| store.list().iter().any(|p| p.sessions.iter().any(|s| s.id == id));
    let AskDecision::Hold { session, tool_use_id, questions } =
        ask_decision(gate.is_open(), has_origin, session.as_deref(), &parsed, known)
    else {
        let _ = request.respond(Response::from_string("{}"));
        return;
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let (id, rx) = asks.register(session, tool_use_id, questions, now_ms);
    if let Some(view) = asks.get(&id) {
        let _ = app.emit("ask-request", &view);
    }
    let outcome = rx.recv_timeout(crate::asks::ASK_CEILING).ok();
    asks.forget(&id);
    let how = match &outcome {
        Some(crate::asks::AskOutcome::Answered(_)) => "answered",
        Some(crate::asks::AskOutcome::HandOff) => "handoff",
        None => "timeout",
    };
    let _ = request.respond(Response::from_string(
        crate::asks::ask_response(&input, outcome.as_ref()).to_string(),
    ));
    let _ = app.emit("ask-resolved", json!({ "id": id, "how": how }));
}
```

Add two parameters to `hooks::start` — `asks: Arc<crate::asks::Asks>, ask_gate: Arc<crate::asks::AskGate>` — and dispatch right after the `/approve` block:

```rust
            // AskUserQuestion: blocking, own thread. See asks.rs.
            if url.starts_with("/ask") {
                let app = app.clone();
                let asks = asks.clone();
                let gate = ask_gate.clone();
                let store = store.clone();
                thread::spawn(move || handle_ask(request, &url, &app, &asks, &gate, &store));
                continue;
            }
```

(If `Emitter` is not yet imported in `hooks.rs`, it already is for `app.emit("hook", …)` — reuse that import.)

In `lib.rs`: in the builder, `.manage(Arc::new(asks::Asks::default()))` and `.manage(Arc::new(asks::AskGate::default()))` next to the broker's `.manage` (~:2557); in `setup`, fetch both with `app.state::<Arc<asks::Asks>>().inner().clone()` like `broker` (~:2622) and pass them to `hooks::start`. Add the commands:

```rust
/// Answer a pending AskUserQuestion from its card. `false` = it already resolved
/// (handed off or timed out) — the card says so; nothing was sent.
#[tauri::command]
fn ask_answer(
    asks: State<Arc<asks::Asks>>,
    id: String,
    answers: serde_json::Map<String, serde_json::Value>,
) -> Result<bool, String> {
    let Some(view) = asks.get(&id) else {
        return Ok(false);
    };
    asks::validate_answers(&view.questions, &answers)?;
    Ok(asks.resolve(&id, asks::AskOutcome::Answered(answers)))
}

#[tauri::command]
fn ask_handoff(asks: State<Arc<asks::Asks>>, id: String) -> bool {
    asks.resolve(&id, asks::AskOutcome::HandOff)
}

#[tauri::command]
fn ask_pending(asks: State<Arc<asks::Asks>>) -> Vec<asks::AskView> {
    asks.pending()
}

#[tauri::command]
fn set_ask_gate(gate: State<Arc<asks::AskGate>>, open: bool) {
    gate.set(open);
}
```

and register all four in `invoke_handler` next to `continuity_feed`. Remove the temporary `dead_code` allow from `asks.rs`.

- [ ] **Step 4: Run tests and lint**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` then `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` (if `hooks::start` trips `too_many_arguments`, it already carries `#[allow(clippy::too_many_arguments)]`).
Expected: PASS, clean.

- [ ] **Step 5: Live check against the real CLI (no UI yet)**

In the dev app (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`), with the gate still closed by default, start a Claude session and ask it to call `AskUserQuestion`: the normal menu must appear immediately (proves `{}` fail-open through the real curl line). Then in the devtools console run `await window.__TAURI__.core.invoke("set_ask_gate",{open:true})` (or `__TAURI_INTERNALS__.invoke`), ask again, and in the console `const p = await …invoke("ask_pending")` then `…invoke("ask_answer",{id:p[0].id, answers:{[p[0].questions[0].question]:"Typed from devtools"}})` — the agent must report that answer. Record both observations in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/hooks.rs src-tauri/src/lib.rs src-tauri/src/asks.rs
git commit -m "feat(continuity): blocking /ask route answers AskUserQuestion from Conduit"
```

---

### Task 5: Continuity watcher thread

**Files:**
- Create: `src-tauri/src/continuity_fixture.rs` (`#[cfg(test)]`)
- Create: `src-tauri/src/continuity_watch.rs`
- Modify: `src-tauri/src/lib.rs` (`#[cfg(test)] mod continuity_fixture;`, `mod continuity_watch;`, start the thread in `setup`)

**Interfaces:**
- Produces: `continuity_fixture::{DDL, temp_db}`; `continuity_watch::{Watcher, Tick, WatchedMessage, ChangedPayload, start}`; event **`continuity-changed`** with payload `{ messages: [{ id, from, to, kind, createdAt }] }` — emitted on EVERY observed commit (possibly with zero messages; consumers refetch on it).

> Deviation from spec §6.1, deliberate: the event does not carry a per-table list. A cursor on update-heavy tables (`agent_sessions.last_seen_at`, a handoff's status) cannot be expressed as one monotonic column, and consumers refetch on any commit anyway. Only `messages` needs a cursor, because only new messages become pulses. Update the spec paragraph in this task's commit.

- [ ] **Step 1: Write the shared fixture**

`src-tauri/src/continuity_fixture.rs`:

```rust
//! Continuity's DDL for every table Conduit reads, for tests only. Column names and CHECK
//! lists copied from `~/.continuity/continuity.db`'s `.schema` (2026-10-12); indexes omitted
//! — they change no read result. The older fixtures in continuity_feed.rs/continuity_read.rs
//! keep their own copies; new modules use this one.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const DDL: &str = "
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
";

/// A fresh, schema-loaded DB path (pid + counter; the caller owns cleanup).
pub fn temp_db(tag: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "conduit-continuity-fixture-{}-{}-{}.db",
        std::process::id(),
        tag,
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let conn = rusqlite::Connection::open(&path).expect("open fixture");
    conn.execute_batch("PRAGMA journal_mode=WAL;").expect("wal");
    conn.execute_batch(DDL).expect("ddl");
    path
}

/// Insert a message (writer connection — the watcher only ever reads).
pub fn insert_message(conn: &rusqlite::Connection, id: &str, from: &str, to: &str, created: &str) {
    conn.execute(
        "INSERT INTO messages (id, from_agent_session_id, to_agent_session_id, kind, body, created_at, expires_at) \
         VALUES (?1, ?2, ?3, 'message', 'b', ?4, '2999-01-01T00:00:00.000Z')",
        rusqlite::params![id, from, to, created],
    )
    .expect("insert message");
}
```

- [ ] **Step 2: Write the failing tests (bottom of `continuity_watch.rs`)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuity_fixture::{insert_message, temp_db};

    #[test]
    fn first_tick_baselines_without_a_history_storm() {
        let path = temp_db("watch-baseline");
        let w = rusqlite::Connection::open(&path).unwrap();
        insert_message(&w, "old", "a", "b", "2000-01-01T00:00:00.000Z");
        let mut watcher = Watcher::new(path.clone());
        assert_eq!(watcher.tick(), Tick::Unchanged);
    }

    #[test]
    fn a_new_commit_reports_only_newer_messages() {
        let path = temp_db("watch-new");
        let mut watcher = Watcher::new(path.clone());
        assert_eq!(watcher.tick(), Tick::Unchanged);
        let w = rusqlite::Connection::open(&path).unwrap();
        insert_message(&w, "m1", "a", "b", "2999-01-01T00:00:00.000Z");
        insert_message(&w, "stale", "a", "b", "2000-01-01T00:00:00.000Z");
        match watcher.tick() {
            Tick::Changed(p) => {
                let ids: Vec<&str> = p.messages.iter().map(|m| m.id.as_str()).collect();
                assert_eq!(ids, vec!["m1"]);
                assert_eq!(p.messages[0].from, "a");
                assert_eq!(p.messages[0].to, "b");
            }
            other => panic!("expected Changed, got {other:?}"),
        }
        assert_eq!(watcher.tick(), Tick::Unchanged, "nothing new since");
    }

    #[test]
    fn a_commit_with_no_new_message_still_reports_a_change() {
        let path = temp_db("watch-other-table");
        let mut watcher = Watcher::new(path.clone());
        watcher.tick();
        let w = rusqlite::Connection::open(&path).unwrap();
        w.execute("INSERT INTO decisions (id, decision_key, content, created_at) VALUES ('d','k','c','t')", [])
            .unwrap();
        assert_eq!(watcher.tick(), Tick::Changed(ChangedPayload { messages: vec![] }));
    }

    #[test]
    fn equal_timestamps_break_ties_by_id() {
        let path = temp_db("watch-tie");
        let mut watcher = Watcher::new(path.clone());
        watcher.tick();
        let w = rusqlite::Connection::open(&path).unwrap();
        insert_message(&w, "a1", "x", "y", "2999-01-01T00:00:00.000Z");
        let Tick::Changed(first) = watcher.tick() else { panic!() };
        assert_eq!(first.messages.len(), 1);
        insert_message(&w, "a2", "x", "y", "2999-01-01T00:00:00.000Z");
        let Tick::Changed(second) = watcher.tick() else { panic!() };
        let ids: Vec<&str> = second.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["a2"], "same instant, later id, reported once");
    }

    #[test]
    fn a_missing_database_is_unavailable_then_recovers() {
        let path = std::env::temp_dir().join(format!("conduit-watch-missing-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut watcher = Watcher::new(path.clone());
        assert_eq!(watcher.tick(), Tick::Unavailable);
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(crate::continuity_fixture::DDL).unwrap();
        drop(c);
        assert_eq!(watcher.tick(), Tick::Unchanged, "re-opens and baselines");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn schema_drift_is_unavailable_not_a_panic() {
        let path = std::env::temp_dir().join(format!("conduit-watch-drift-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE messages (nope TEXT);").unwrap();
        drop(c);
        let mut watcher = Watcher::new(path.clone());
        watcher.tick();
        let w = rusqlite::Connection::open(&path).unwrap();
        w.execute("INSERT INTO messages (nope) VALUES ('x')", []).unwrap();
        assert_eq!(watcher.tick(), Tick::Unavailable);
        let _ = std::fs::remove_file(&path);
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_watch::`
Expected: FAIL to compile.

- [ ] **Step 4: Implement `continuity_watch.rs`**

```rust
//! Live change feed over continuity's database, for the Continuity view's pulses.
//!
//! One app-wide thread, one READ-ONLY connection. `PRAGMA data_version` changes only when
//! ANOTHER connection commits — i.e. continuity — so an idle tick is one integer read.
//! On a change it reports the messages newer than a `(created_at, id)` cursor; that is the
//! only cursor, because only a NEW message becomes a pulse. Everything else just refetches
//! on the event. Continuity's timestamps are ISO-8601 `…Z` strings, which order as text.

use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const TICK: Duration = Duration::from_millis(500);
pub const RETRY: Duration = Duration::from_secs(10);
/// A burst cap: a continuity backfill must not turn into a pulse storm.
const MAX_MESSAGES_PER_TICK: usize = 200;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchedMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ChangedPayload {
    pub messages: Vec<WatchedMessage>,
}

#[derive(Debug, PartialEq)]
pub enum Tick {
    Unavailable,
    Unchanged,
    Changed(ChangedPayload),
}

pub struct Watcher {
    path: PathBuf,
    conn: Option<rusqlite::Connection>,
    version: Option<i64>,
    cursor: Option<(String, String)>,
}

impl Watcher {
    pub fn new(path: PathBuf) -> Self {
        Self { path, conn: None, version: None, cursor: None }
    }

    pub fn tick(&mut self) -> Tick {
        if self.conn.is_none() {
            self.conn = crate::continuity_read::open_ro(&self.path);
            self.version = None;
        }
        let Some(conn) = self.conn.as_ref() else {
            return Tick::Unavailable;
        };
        let version = match conn.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0)) {
            Ok(v) => v,
            Err(_) => {
                self.conn = None;
                return Tick::Unavailable;
            }
        };
        let Some(prev) = self.version.replace(version) else {
            // First look (or a re-open): baseline the cursor at "now" so history never pulses.
            if self.cursor.is_none() {
                let now: String = conn
                    .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| r.get(0))
                    .unwrap_or_default();
                self.cursor = Some((now, String::new()));
            }
            return Tick::Unchanged;
        };
        if prev == version {
            return Tick::Unchanged;
        }
        let (at, id) = self.cursor.clone().unwrap_or_default();
        match read_messages_after(conn, &at, &id) {
            Ok(messages) => {
                if let Some(last) = messages.last() {
                    self.cursor = Some((last.created_at.clone(), last.id.clone()));
                }
                Tick::Changed(ChangedPayload { messages })
            }
            Err(_) => {
                self.conn = None;
                Tick::Unavailable
            }
        }
    }
}

fn read_messages_after(
    conn: &rusqlite::Connection,
    at: &str,
    id: &str,
) -> rusqlite::Result<Vec<WatchedMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, from_agent_session_id, to_agent_session_id, kind, created_at FROM messages \
         WHERE created_at > ?1 OR (created_at = ?1 AND id > ?2) \
         ORDER BY created_at, id LIMIT ?3",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![at, id, MAX_MESSAGES_PER_TICK as i64],
        |r| {
            Ok(WatchedMessage {
                id: r.get(0)?,
                from: r.get(1)?,
                to: r.get(2)?,
                kind: r.get(3)?,
                created_at: r.get(4)?,
            })
        },
    )?;
    rows.collect()
}

/// Run forever on a background thread. Never writes, never panics the app.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut watcher = Watcher::new(crate::continuity_read::db_path());
        loop {
            match watcher.tick() {
                Tick::Changed(payload) => {
                    let _ = app.emit("continuity-changed", &payload);
                    std::thread::sleep(TICK);
                }
                Tick::Unchanged => std::thread::sleep(TICK),
                Tick::Unavailable => std::thread::sleep(RETRY),
            }
        }
    });
}
```

Note on `a_missing_database_is_unavailable_then_recovers`: after `Unavailable` the conn is None and the next tick re-opens; `version` resets to None, so it returns `Unchanged` (baseline) — matching the test.

In `lib.rs`: `#[cfg(test)] mod continuity_fixture;`, `mod continuity_watch;`, and in `setup` (after `hooks::start(...)`): `continuity_watch::start(app.handle().clone());`. Also update spec §6.1's event payload paragraph to match this task's deviation note.

- [ ] **Step 5: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_watch::` then the full `cargo test` + clippy.
Expected: PASS (6 tests), clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/continuity_fixture.rs src-tauri/src/continuity_watch.rs src-tauri/src/lib.rs docs/superpowers/specs/2026-10-12-continuity-view-design.md
git commit -m "feat(continuity): watch continuity's database and emit new messages live"
```

---

### Task 6: `continuity_graph` snapshot

**Files:**
- Create: `src-tauri/src/continuity_graph.rs`
- Modify: `src-tauri/src/continuity_feed.rs` (make `placeholders` `pub(crate)`)
- Modify: `src-tauri/src/lib.rs` (`mod continuity_graph;`, extract `project_toplevels`, new command `continuity_graph`, register it)

**Interfaces:**
- Consumes: `continuity_feed::{resolve_session_ids, probe, placeholders}`, `continuity_read::{db_path, open_ro}`.
- Produces: `continuity_graph::{GraphSnapshot, GraphNode, GraphEdge, graph_from_db}`; command `continuity_graph(project_id) -> GraphSnapshot`. JSON (camelCase): `{ available, nodes: [{ key, conduitSessionId?, continuityId?, label, status, focus?, lastSeenAt?, visitor, visitorProjectId? }], edges: [{ a, b, count, lastAt }], unanswered: { [key]: number } }`. `status` is the Continuity status (`active|idle|gone|none`) — the frontend overlays live Conduit status for Conduit sessions.

Membership rules (spec D4, §6.2):
- Node key = the Conduit session id for any Continuity row whose `agent_label` is one of THIS project's Conduit session ids (a restarted session has several rows; all map to one node, the freshest row supplies status/focus); else the Continuity id.
- Every Conduit session of the project is a node, even with no Continuity row (`status: "none"`).
- Other in-scope Continuity rows: only `active`/`idle`.
- Visitors: an out-of-scope endpoint of a message with an in-scope endpoint, created in the last 10 min. If its `agent_label` is a Conduit session of ANOTHER project, `visitorProjectId` = that project and `conduitSessionId` = the label.
- Edges: messages in the last 24 h between two shown node keys (self-messages dropped), undirected (`a < b`), `count`, `lastAt` = max `created_at`.
- `unanswered[key]` = messages TO the node with `requires_response = 1 AND status = 'pending'`.

- [ ] **Step 1: Write the failing tests (bottom of the new file)**

```rust
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
    fn fixture() -> (std::path::PathBuf, Vec<String>, Vec<String>, HashMap<String, String>) {
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
        (path, vec!["cs-1".into(), "cs-2".into()], vec!["/repo/p".into()], foreign)
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
        assert_eq!(cs1.continuity_id.as_deref(), Some("c-1"), "freshest row wins");
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
        let e = s.edges.iter().find(|e| e.a == "c-cli" && e.b == "cs-1").expect("cli<->cs-1");
        assert_eq!(e.count, 2, "m1 and m2 (old row folded in); m5 is older than 24 h");
        assert!(s.edges.iter().any(|e| e.a == "c-vis" && e.b == "cs-1"));
        assert!(!s.edges.iter().any(|e| e.a.contains("old") || e.b.contains("old")));
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
        let s = graph_from_db(&path, &["cs-1".into()], &[], &HashMap::new());
        assert!(!s.available);
        assert_eq!(keys(&s), vec!["cs-1"], "the project's own sessions still render");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_graph::`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `continuity_graph.rs`**

```rust
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

pub fn graph_from_db(
    path: &std::path::Path,
    project_sessions: &[String],
    toplevels: &[String],
    foreign_sessions: &HashMap<String, String>,
) -> GraphSnapshot {
    let unavailable = || GraphSnapshot { nodes: conduit_only(project_sessions), ..Default::default() };
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
        "SELECT id, agent_label, status, current_focus, last_seen_at FROM agent_sessions WHERE id IN ({})",
        crate::continuity_feed::placeholders(ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids), |r| {
        Ok(Row { id: r.get(0)?, label: r.get(1)?, status: r.get(2)?, focus: r.get(3)?, last_seen: r.get(4)? })
    })?;
    rows.collect()
}

fn read(
    conn: &rusqlite::Connection,
    project_sessions: &[String],
    toplevels: &[String],
    foreign_sessions: &HashMap<String, String>,
) -> rusqlite::Result<GraphSnapshot> {
    let scope = crate::continuity_feed::resolve_session_ids(conn, project_sessions, toplevels);
    let in_scope: HashSet<&str> = scope.iter().map(String::as_str).collect();
    let own: HashSet<&str> = project_sessions.iter().map(String::as_str).collect();

    // continuity id -> node key, for every in-scope row (gone ones included, so an old row's
    // messages fold into its Conduit session's node).
    let mut key_of: HashMap<String, String> = HashMap::new();
    let mut nodes: BTreeMap<String, GraphNode> =
        conduit_only(project_sessions).into_iter().map(|n| (n.key.clone(), n)).collect();
    let mut freshest: HashMap<String, String> = HashMap::new(); // node key -> last_seen of the row shown
    for row in rows_by_id(conn, &scope)? {
        if own.contains(row.label.as_str()) {
            key_of.insert(row.id.clone(), row.label.clone());
            let newer = freshest.get(&row.label).is_none_or(|seen| row.last_seen > *seen);
            if newer {
                freshest.insert(row.label.clone(), row.last_seen.clone());
                if let Some(n) = nodes.get_mut(&row.label) {
                    n.continuity_id = Some(row.id.clone());
                    n.status = row.status.clone();
                    n.focus = row.focus.clone();
                    n.last_seen_at = Some(row.last_seen.clone());
                }
            }
        } else {
            key_of.insert(row.id.clone(), row.id.clone());
            if row.status == "active" || row.status == "idle" {
                nodes.insert(row.id.clone(), GraphNode {
                    key: row.id.clone(),
                    continuity_id: Some(row.id.clone()),
                    label: row.label.clone(),
                    status: row.status.clone(),
                    focus: row.focus.clone(),
                    last_seen_at: Some(row.last_seen.clone()),
                    ..Default::default()
                });
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
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0, r.get(4)?, r.get::<_, i64>(5)? != 0))
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
        nodes.insert(row.id.clone(), GraphNode {
            key: row.id.clone(),
            conduit_session_id: other_project.as_ref().map(|_| row.label.clone()),
            continuity_id: Some(row.id.clone()),
            label: row.label.clone(),
            status: row.status.clone(),
            focus: row.focus.clone(),
            last_seen_at: Some(row.last_seen.clone()),
            visitor: true,
            visitor_project_id: other_project,
        });
    }

    let mut edges: BTreeMap<(String, String), GraphEdge> = BTreeMap::new();
    let mut unanswered: BTreeMap<String, u32> = BTreeMap::new();
    for (from, to, created, ask, status, _recent) in &msgs {
        let (Some(fa), Some(tb)) = (key_of.get(from), key_of.get(to)) else { continue };
        if ask && status == "pending" && nodes.contains_key(tb) {
            *unanswered.entry(tb.clone()).or_default() += 1;
        }
        if fa == tb || !nodes.contains_key(fa) || !nodes.contains_key(tb) {
            continue;
        }
        let (a, b) = if fa < tb { (fa.clone(), tb.clone()) } else { (tb.clone(), fa.clone()) };
        let e = edges.entry((a.clone(), b.clone())).or_insert(GraphEdge { a, b, count: 0, last_at: String::new() });
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
```

(`Option::is_none_or` needs Rust ≥ 1.82; if the toolchain is older use `map_or(true, |seen| …)`.) Make `placeholders` `pub(crate)` in `continuity_feed.rs`.

In `lib.rs`, extract the toplevel gathering out of `continuity_feed` into:

```rust
/// The project root plus every worktree, each its own git toplevel (and so its own
/// continuity cwd_hash). A path that isn't a checkout simply drops out.
fn project_toplevels(project: &store::Project) -> Vec<String> {
    let mut dirs: Vec<String> = vec![project.path.clone()];
    dirs.extend(project.sessions.iter().filter_map(|s| s.worktree_path.clone()));
    let mut tops: Vec<String> = dirs.iter().filter_map(|d| git::toplevel(d)).collect();
    tops.sort();
    tops.dedup();
    tops
}
```

use it in `continuity_feed`, and add:

```rust
/// The Continuity view's graph for a project. Best-effort, read-only.
#[tauri::command]
fn continuity_graph(
    store: State<Arc<Store>>,
    project_id: String,
) -> continuity_graph::GraphSnapshot {
    let projects = store.list();
    let Some(project) = projects.iter().find(|p| p.id == project_id) else {
        return continuity_graph::GraphSnapshot::default();
    };
    let ids: Vec<String> = project.sessions.iter().map(|s| s.id.clone()).collect();
    let foreign: std::collections::HashMap<String, String> = projects
        .iter()
        .filter(|p| p.id != project_id)
        .flat_map(|p| p.sessions.iter().map(move |s| (s.id.clone(), p.id.clone())))
        .collect();
    continuity_graph::graph_from_db(
        &continuity_read::db_path(),
        &ids,
        &project_toplevels(project),
        &foreign,
    )
}
```

Register `continuity_graph` in `invoke_handler`. (Use whatever path `store::Project` resolves to in `lib.rs` — check how `continuity_feed`'s `project` is typed.)

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_graph::` then full `cargo test`, clippy, fmt.
Expected: PASS (4 new), existing `continuity_feed` tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/continuity_graph.rs src-tauri/src/continuity_feed.rs src-tauri/src/lib.rs
git commit -m "feat(continuity): project-scoped session graph snapshot"
```

---

### Task 7: View prefs, gating and three-way exclusion

**Files:**
- Create: `src/centerViews.ts`, `src/centerViews.test.ts`
- Modify: `src/store.ts` (`CenterMode` re-export, three prefs, setters, `setCenterMode`/`toggleCenterMode`/`setCanvasOpen`)
- Modify: `src/components/GeneralSettings.tsx` (three rows), `src/App.tsx` (⇧⌘B, ⇧⌘C, menu `toggle-board`, new ⇧⌘K), `src/components/CommandPalette.tsx`, `src/components/WorkspaceCenter.tsx` (Board button, `CanvasToggleButton`, render gates)

**Interfaces:**
- Produces: `export type CenterMode = "terminals" | "board" | "continuity"`; `export type ViewPrefs = { canvasEnabled: boolean; boardEnabled: boolean; continuityViewEnabled: boolean }`; `modeAllowed(mode, prefs): boolean`; `resolveCenterMode(requested, prefs): CenterMode`; `toggledMode(current, target, prefs): CenterMode`; `effectiveCenterMode(stored, prefs): CenterMode`; `canOpenCanvas(prefs, secondaryWindow): boolean`; `readViewPref(key, defaultOn)`/`writeViewPref(key, v)` + key constants. Store fields `canvasEnabled`, `boardEnabled`, `continuityViewEnabled` and setters `setCanvasEnabled`, `setBoardEnabled`, `setContinuityViewEnabled`; `toggleCenterMode(projectId, target?: "board" | "continuity")` (default `"board"`, so existing callers keep their meaning).

- [ ] **Step 1: Write the failing tests `src/centerViews.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  canOpenCanvas, effectiveCenterMode, modeAllowed, readViewPref, resolveCenterMode, toggledMode,
  type ViewPrefs,
} from "./centerViews";

const ALL: ViewPrefs = { canvasEnabled: true, boardEnabled: true, continuityViewEnabled: true };
const DEFAULTS: ViewPrefs = { canvasEnabled: false, boardEnabled: false, continuityViewEnabled: true };

describe("center views", () => {
  it("terminals is always allowed", () => {
    expect(modeAllowed("terminals", { canvasEnabled: false, boardEnabled: false, continuityViewEnabled: false })).toBe(true);
  });
  it("a disabled mode resolves to terminals", () => {
    expect(resolveCenterMode("board", DEFAULTS)).toBe("terminals");
    expect(resolveCenterMode("continuity", DEFAULTS)).toBe("continuity");
  });
  it("toggling the open mode returns to terminals; toggling another switches", () => {
    expect(toggledMode("board", "board", ALL)).toBe("terminals");
    expect(toggledMode("board", "continuity", ALL)).toBe("continuity");
    expect(toggledMode("terminals", "board", DEFAULTS)).toBe("terminals");
  });
  it("a stored mode whose pref was turned off renders as terminals", () => {
    expect(effectiveCenterMode("board", DEFAULTS)).toBe("terminals");
    expect(effectiveCenterMode(undefined, ALL)).toBe("terminals");
    expect(effectiveCenterMode("continuity", ALL)).toBe("continuity");
  });
  it("the canvas needs its pref and the main window", () => {
    expect(canOpenCanvas(DEFAULTS, false)).toBe(false);
    expect(canOpenCanvas(ALL, false)).toBe(true);
    expect(canOpenCanvas(ALL, true)).toBe(false);
  });
  it("pref readers default correctly and survive a throwing storage", () => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readViewPref("k1", false, ls)).toBe(false);
    expect(readViewPref("k2", true, ls)).toBe(true);
    store.set("k1", "1"); store.set("k2", "0");
    expect(readViewPref("k1", false, ls)).toBe(true);
    expect(readViewPref("k2", true, ls)).toBe(false);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => {} };
    expect(readViewPref("k3", true, broken)).toBe(true);
    expect(readViewPref("k4", false, broken)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/centerViews.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/centerViews.ts`**

```ts
/** Which center overlay a project shows, and which of them the user has switched on.
 *  Store-free on purpose (store.ts touches localStorage at module scope and cannot be
 *  imported under the node-env vitest). Every overlay sits over still-mounted terminals —
 *  none may unmount or reparent a TerminalView. The global canvas is not a CenterMode (it
 *  belongs to no project), but it is mutually exclusive with every non-terminals mode. */

export type CenterMode = "terminals" | "board" | "continuity";

export type ViewPrefs = {
  canvasEnabled: boolean;
  boardEnabled: boolean;
  continuityViewEnabled: boolean;
};

export const CANVAS_ENABLED_KEY = "conduit.canvasEnabled";
export const BOARD_ENABLED_KEY = "conduit.boardEnabled";
export const CONTINUITY_VIEW_ENABLED_KEY = "conduit.continuityViewEnabled";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Default-off prefs are on only when "1"; default-on prefs are off only when "0". */
export function readViewPref(key: string, defaultOn: boolean, ls: Storage = localStorage): boolean {
  try {
    const v = ls.getItem(key);
    return defaultOn ? v !== "0" : v === "1";
  } catch {
    return defaultOn;
  }
}

export function writeViewPref(key: string, on: boolean, ls: Storage = localStorage): void {
  try {
    ls.setItem(key, on ? "1" : "0");
  } catch {
    /* quota — non-fatal */
  }
}

export function modeAllowed(mode: CenterMode, prefs: ViewPrefs): boolean {
  if (mode === "board") return prefs.boardEnabled;
  if (mode === "continuity") return prefs.continuityViewEnabled;
  return true;
}

export function resolveCenterMode(requested: CenterMode, prefs: ViewPrefs): CenterMode {
  return modeAllowed(requested, prefs) ? requested : "terminals";
}

export function toggledMode(current: CenterMode, target: CenterMode, prefs: ViewPrefs): CenterMode {
  return current === target ? "terminals" : resolveCenterMode(target, prefs);
}

/** What actually renders: a stored mode whose pref has since been turned off is terminals. */
export function effectiveCenterMode(stored: CenterMode | undefined, prefs: ViewPrefs): CenterMode {
  return resolveCenterMode(stored ?? "terminals", prefs);
}

export function canOpenCanvas(prefs: ViewPrefs, secondaryWindow: boolean): boolean {
  return prefs.canvasEnabled && !secondaryWindow;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/centerViews.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the store**

In `src/store.ts`:
- Replace `export type CenterMode = "terminals" | "board";` with `export type { CenterMode } from "./centerViews";` plus `import { … } from "./centerViews";` (keep the doc comment, amended to mention the continuity view).
- Interface: add `canvasEnabled: boolean; boardEnabled: boolean; continuityViewEnabled: boolean; setCanvasEnabled: (v: boolean) => void; setBoardEnabled: (v: boolean) => void; setContinuityViewEnabled: (v: boolean) => void;` and change `toggleCenterMode: (projectId: string, target?: "board" | "continuity") => void;`.
- Initial state: `canvasEnabled: readViewPref(CANVAS_ENABLED_KEY, false)`, `boardEnabled: readViewPref(BOARD_ENABLED_KEY, false)`, `continuityViewEnabled: readViewPref(CONTINUITY_VIEW_ENABLED_KEY, true)`.
- Add a local helper inside the store factory: `const prefsOf = (): ViewPrefs => { const s = get(); return { canvasEnabled: s.canvasEnabled, boardEnabled: s.boardEnabled, continuityViewEnabled: s.continuityViewEnabled }; };`
- Replace the three actions:

```ts
    setCenterMode: (projectId, mode) => {
      const next = resolveCenterMode(mode, prefsOf());
      set((s) => ({
        centerMode: { ...s.centerMode, [projectId]: next },
        // Exclusion lives here, not in each caller: every non-terminals overlay closes the
        // global canvas, so the palette and native-menu paths can no longer leave both up.
        canvasOpen: next === "terminals" ? s.canvasOpen : false,
      }));
    },
    toggleCenterMode: (projectId, target = "board") => {
      const cur = get().centerMode[projectId] ?? "terminals";
      get().setCenterMode(projectId, toggledMode(cur, target, prefsOf()));
    },
    // The ONE choke point every canvas entry point routes through. Refuses while the
    // Canvas pref is off and in a secondary profile window (see mountedInWindow in
    // WorkspaceCenter.tsx). Opening it drops the selected project's overlay to terminals.
    setCanvasOpen: (open) => {
      const ok = open && canOpenCanvas(prefsOf(), WINDOWED && !get().windowProfile.isMain);
      set((s) => {
        const pid = s.selectedProjectId;
        const centerMode = ok && pid ? { ...s.centerMode, [pid]: "terminals" as CenterMode } : s.centerMode;
        return { canvasOpen: ok, centerMode };
      });
    },
    setCanvasEnabled: (v) => {
      writeViewPref(CANVAS_ENABLED_KEY, v);
      set((s) => ({ canvasEnabled: v, canvasOpen: v ? s.canvasOpen : false }));
    },
    setBoardEnabled: (v) => {
      writeViewPref(BOARD_ENABLED_KEY, v);
      set({ boardEnabled: v });
    },
    setContinuityViewEnabled: (v) => {
      writeViewPref(CONTINUITY_VIEW_ENABLED_KEY, v);
      set({ continuityViewEnabled: v });
    },
```

(A stored `"board"` with the pref now off is handled at render by `effectiveCenterMode`, so the setters need not rewrite `centerMode`.) Remove the now-redundant `setCanvasOpen(false)` calls after board toggles in `App.tsx` ⇧⌘B and the `WorkspaceCenter` Board button — `setCenterMode` does it — but KEEP the tab-click handler's `setCanvasOpen(false)` (it sets terminals mode, which deliberately does not close the canvas in the store).

- [ ] **Step 6: Gate every entry point**

- `WorkspaceCenter.tsx`: read `const prefs = useStore(useShallow(s => ({ canvasEnabled: s.canvasEnabled, boardEnabled: s.boardEnabled, continuityViewEnabled: s.continuityViewEnabled })))` (use whatever shallow-selector idiom the file already uses) and compute `const mode = effectiveCenterMode(centerModeRaw, prefs)` wherever `centerMode` is read for rendering (`board-overlay` gate ~:616, the Board button's active state). Render the Board button only when `prefs.boardEnabled`; `CanvasToggleButton` returns null when `!canvasEnabled`; `canvasMode` render paths use `canvasOpen` which can no longer be true while disabled.
- `App.tsx`: ⇧⌘B returns early unless `st.boardEnabled`; ⇧⌘C returns early unless `st.canvasEnabled`; menu `toggle-board` likewise. Add ⇧⌘K beside ⇧⌘B (same guard shape, same `isEditableTarget` check the B handler uses):

```ts
      // ⇧⌘K: toggle the Continuity view for the selected project.
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        const st = useStore.getState();
        if (!st.selectedProjectId || !st.continuityViewEnabled) return;
        e.preventDefault();
        st.toggleCenterMode(st.selectedProjectId, "continuity");
        return;
      }
```

- `CommandPalette.tsx`: offer `view-board` only when `st.boardEnabled`, `view-canvas` only when `st.canvasEnabled`, and add (inside `if (project)`, when `st.continuityViewEnabled`):

```ts
    act(
      "view-continuity",
      mode === "continuity" ? "Hide Continuity view" : "Show Continuity view",
      () => st.toggleCenterMode(project.id, "continuity"),
      { section: "View" },
    );
```

- [ ] **Step 7: Settings rows (`GeneralSettings.tsx`, after the rich-view row)**

```tsx
      <SettingRow
        id="continuity-view"
        title="Continuity view"
        checked={continuityViewEnabled}
        onChange={setContinuityViewEnabled}
        detail="A live map of this project's sessions: who is messaging whom through Continuity, and any question a Claude session is waiting on you to answer. ⇧⌘K. Off = the view and its question cards are hidden, and questions appear in the terminal as usual."
      />
      <SettingRow
        id="canvas-enabled"
        title="Canvas"
        checked={canvasEnabled}
        onChange={setCanvasEnabled}
        detail="The global board you arrange sessions on by hand (⇧⌘C). Off hides its button, shortcut and palette entry. Your board is kept and comes back when you turn this on."
      />
      <SettingRow
        id="board-enabled"
        title="Task board"
        checked={boardEnabled}
        onChange={setBoardEnabled}
        detail="The per-project Kanban backed by .conduit/ files (⇧⌘B). Off hides its button, shortcut and palette entry. Cards are kept and come back when you turn this on."
      />
```

with the matching `useStore` selectors at the top of the component (same style as `restoreSessionsOnOpen`).

- [ ] **Step 8: Verify**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: clean, all pass. Launch the dev app: with defaults, no Board/Canvas buttons, ⇧⌘B/⇧⌘C inert; turning each on restores button + shortcut + an existing canvas/board's content; turning Canvas off while it is open closes it.

- [ ] **Step 9: Commit**

```bash
git add src/centerViews.ts src/centerViews.test.ts src/store.ts src/App.tsx src/components/WorkspaceCenter.tsx src/components/CommandPalette.tsx src/components/GeneralSettings.tsx
git commit -m "feat(continuity): settings toggles for Canvas, Board and the Continuity view"
```

---

### Task 8: Ask state, gate sync and hand-off in the frontend

**Files:**
- Create: `src/asks.ts`, `src/asks.test.ts`
- Modify: `src/store.ts` (`asks`, `windowFocused`, actions), `src/App.tsx` (listeners + effects)

**Interfaces:**
- Consumes: Task 1 constants (`src/askProtocol.ts`), Task 4 events/commands, Task 7 `effectiveCenterMode`.
- Produces: types `AskOption`, `AskQuestion`, `PendingAsk` (fields `id, session, toolUseId, questions, createdMs`); `askGateOpen(i: { enabled: boolean; viewOpen: boolean; windowFocused: boolean }): boolean`; `askShouldHandOff(ask: PendingAsk, v: { selectedSessionId: string | null; continuityVisible: boolean; windowFocused: boolean }): boolean`; `buildAnswers(questions: AskQuestion[], picks: Record<string, string[]>, freeText: Record<string, string>): Record<string, string> | null`. Store: `asks: Record<string, PendingAsk>`, `windowFocused: boolean`, `addAsk(a)`, `removeAsk(id)`, `setWindowFocused(v)`.

- [ ] **Step 1: Write the failing tests `src/asks.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { askGateOpen, askShouldHandOff, buildAnswers, type AskQuestion, type PendingAsk } from "./asks";
import { MULTISELECT_JOIN } from "./askProtocol";

const ask: PendingAsk = {
  id: "ask-1", session: "s1", toolUseId: "t",
  questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }], createdMs: 0,
};

describe("ask gate", () => {
  it("opens only when enabled and someone could see a card", () => {
    expect(askGateOpen({ enabled: true, viewOpen: true, windowFocused: false })).toBe(true);
    expect(askGateOpen({ enabled: true, viewOpen: false, windowFocused: true })).toBe(true);
    expect(askGateOpen({ enabled: true, viewOpen: false, windowFocused: false })).toBe(false);
    expect(askGateOpen({ enabled: false, viewOpen: true, windowFocused: true })).toBe(false);
  });
});

describe("hand-off", () => {
  it("hands off when the user is looking at that session's terminal", () => {
    expect(askShouldHandOff(ask, { selectedSessionId: "s1", continuityVisible: false, windowFocused: true })).toBe(true);
  });
  it("keeps the card while the graph is the visible surface, another session is selected, or the window is unfocused", () => {
    expect(askShouldHandOff(ask, { selectedSessionId: "s1", continuityVisible: true, windowFocused: true })).toBe(false);
    expect(askShouldHandOff(ask, { selectedSessionId: "s2", continuityVisible: false, windowFocused: true })).toBe(false);
    expect(askShouldHandOff(ask, { selectedSessionId: "s1", continuityVisible: false, windowFocused: false })).toBe(false);
    expect(askShouldHandOff(ask, { selectedSessionId: null, continuityVisible: false, windowFocused: true })).toBe(false);
  });
});

describe("buildAnswers", () => {
  const qs: AskQuestion[] = [
    { question: "One?", options: [{ label: "A" }, { label: "B" }] },
    { question: "Many?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }, { label: "Z" }] },
  ];
  it("free text wins over a pick, multi-select joins in option order", () => {
    expect(buildAnswers(qs, { "One?": ["B"], "Many?": ["Z", "X"] }, { "One?": "" })).toEqual({
      "One?": "B", "Many?": ["X", "Z"].join(MULTISELECT_JOIN),
    });
    expect(buildAnswers(qs, { "One?": ["B"], "Many?": ["Y"] }, { "One?": "  typed  " })).toEqual({
      "One?": "typed", "Many?": "Y",
    });
  });
  it("returns null until every question has an answer", () => {
    expect(buildAnswers(qs, { "One?": ["A"] }, {})).toBeNull();
    expect(buildAnswers(qs, { "One?": [], "Many?": ["X"] }, { "One?": "   " })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/asks.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/asks.ts`**

```ts
/** AskUserQuestion cards: pure rules. The Rust side holds the question open (asks.rs);
 *  this decides when a card may capture one and when to give it back to the terminal. */
import { MULTISELECT_JOIN } from "./askProtocol";

export type AskOption = { label: string; description?: string };
export type AskQuestion = { question: string; header?: string; options: AskOption[]; multiSelect?: boolean };
export type PendingAsk = { id: string; session: string; toolUseId: string; questions: AskQuestion[]; createdMs: number };

/** Capture only when a card could actually be seen: the view is open somewhere, or a
 *  Conduit window is focused (the dock shows it). Otherwise the menu appears as today. */
export function askGateOpen(i: { enabled: boolean; viewOpen: boolean; windowFocused: boolean }): boolean {
  return i.enabled && (i.viewOpen || i.windowFocused);
}

/** Hand back once the user is looking at that session's own terminal — the menu is about
 *  to be useful there, and a card elsewhere would be a second copy of the same question. */
export function askShouldHandOff(
  ask: PendingAsk,
  v: { selectedSessionId: string | null; continuityVisible: boolean; windowFocused: boolean },
): boolean {
  return v.windowFocused && !v.continuityVisible && v.selectedSessionId === ask.session;
}

/** The `answers` map for ask_answer, or null while any question is unanswered. Free text
 *  (trimmed, non-empty) wins over picks; multi-select picks join in option order. */
export function buildAnswers(
  questions: AskQuestion[],
  picks: Record<string, string[]>,
  freeText: Record<string, string>,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const typed = (freeText[q.question] ?? "").trim();
    if (typed) {
      out[q.question] = typed;
      continue;
    }
    const chosen = picks[q.question] ?? [];
    const ordered = q.options.map((o) => o.label).filter((l) => chosen.includes(l));
    if (ordered.length === 0) return null;
    out[q.question] = q.multiSelect ? ordered.join(MULTISELECT_JOIN) : ordered[0];
  }
  return out;
}
```

- [ ] **Step 4: Run tests** — `pnpm test src/asks.test.ts` → PASS.

- [ ] **Step 5: Store + App wiring**

Store (`src/store.ts`): interface fields + initial `asks: {}`, `windowFocused: typeof document !== "undefined" ? document.hasFocus() : true`, and actions:

```ts
    addAsk: (a) => set((s) => ({ asks: { ...s.asks, [a.id]: a } })),
    removeAsk: (id) =>
      set((s) => {
        if (!(id in s.asks)) return s;
        const next = { ...s.asks };
        delete next[id];
        return { asks: next };
      }),
    setWindowFocused: (v) => set({ windowFocused: v }),
```

`App.tsx` — one effect (main-window and secondary windows alike; the first `ask_answer` wins in Rust):

```tsx
  // AskUserQuestion cards (asks.rs): live requests, resolutions, and a catch-up for asks
  // raised before this window loaded.
  useEffect(() => {
    const st = useStore.getState();
    void invoke<PendingAsk[]>("ask_pending").then((list) => list.forEach((a) => st.addAsk(a)));
    const un1 = listen<PendingAsk>("ask-request", ({ payload }) => useStore.getState().addAsk(payload));
    const un2 = listen<{ id: string; how: string }>("ask-resolved", ({ payload }) => {
      const s = useStore.getState();
      const a = s.asks[payload.id];
      s.removeAsk(payload.id);
      if (a && payload.how !== "answered") s.pushToast("Question moved to the session's terminal");
    });
    const onFocus = () => useStore.getState().setWindowFocused(true);
    const onBlur = () => useStore.getState().setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Keep Rust's gate in step: capture questions only when a card could be seen.
  const askGate = useStore((s) =>
    askGateOpen({
      enabled: s.continuityViewEnabled,
      viewOpen: !!s.selectedProjectId &&
        effectiveCenterMode(s.centerMode[s.selectedProjectId], s) === "continuity",
      windowFocused: s.windowFocused,
    }),
  );
  useEffect(() => {
    void invoke("set_ask_gate", { open: askGate });
  }, [askGate]);

  // Hand a question back once its session's own terminal is in front of the user.
  useEffect(() => {
    return useStore.subscribe((s) => {
      const continuityVisible = !!s.selectedProjectId &&
        effectiveCenterMode(s.centerMode[s.selectedProjectId], s) === "continuity";
      const selectedSessionId = globalSelectedSessionId(s);
      for (const a of Object.values(s.asks)) {
        if (askShouldHandOff(a, { selectedSessionId, continuityVisible, windowFocused: s.windowFocused })) {
          void invoke("ask_handoff", { id: a.id });
        }
      }
    });
  }, []);
```

(`effectiveCenterMode(…, s)` works because the store state structurally satisfies `ViewPrefs`. Import `askGateOpen`, `askShouldHandOff`, `PendingAsk` from `./asks` and `effectiveCenterMode` from `./centerViews`. `ask_handoff` is idempotent — a repeat call on an already-resolved id returns false — so the subscription firing more than once is harmless.)

Multi-window note: with profile windows, every window sets the gate. Make the gate OR across windows cheaply by having only the window that is focused or showing the view send `open: true`, and every window send `false` on blur only if it is not showing the view — this is exactly what `askGateOpen` evaluates per window; the last writer wins, which is the focused window. Accept that and say so in a comment.

- [ ] **Step 6: Verify** — `pnpm exec tsc --noEmit && pnpm test` clean.

- [ ] **Step 7: Commit**

```bash
git add src/asks.ts src/asks.test.ts src/store.ts src/App.tsx
git commit -m "feat(continuity): track pending questions, sync the capture gate, hand back to the terminal"
```

---

### Task 9: Animal avatars

**Files:**
- Create: `src/avatarId.ts`, `src/avatarId.test.ts`, `src/avatars.tsx`
- Modify: `src/theme.css` (avatar styles)

**Interfaces:**
- Produces: `ANIMALS` (readonly tuple of 12 ids: `"fox","rabbit","owl","bear","cat","frog","panda","penguin","koala","tiger","otter","hedgehog"`), `type Animal`, `sessionAnimal(key: string): Animal`; `<SessionAvatar nodeKey: string; size?: number; tone?: "running"|"needs"|"idle"|"stopped"|"visitor"; chipColor?: string | null; badge?: number />`.

- [ ] **Step 1: Failing tests `src/avatarId.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ANIMALS, sessionAnimal } from "./avatarId";

describe("sessionAnimal", () => {
  it("is stable for a key", () => {
    expect(sessionAnimal("8b1f2c")).toBe(sessionAnimal("8b1f2c"));
  });
  it("always lands in the set", () => {
    for (let i = 0; i < 500; i++) expect(ANIMALS).toContain(sessionAnimal(`s-${i}`));
  });
  it("spreads: 200 ids use at least 10 of the 12 animals", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => sessionAnimal(`${i}-x`)));
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run** — `pnpm test src/avatarId.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/avatarId.ts`**

```ts
/** Which animal a session is drawn as. Derived, never stored (same rule as projectAccent):
 *  identical in every view that shows it, and nothing to migrate. Store-free for vitest. */
export const ANIMALS = [
  "fox", "rabbit", "owl", "bear", "cat", "frog", "panda", "penguin", "koala", "tiger", "otter", "hedgehog",
] as const;
export type Animal = (typeof ANIMALS)[number];

export function sessionAnimal(key: string): Animal {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ANIMALS[h % ANIMALS.length];
}
```

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Draw the 12 animals in `src/avatars.tsx`**

Port the five approved animals verbatim from the mockup `.superpowers/brainstorm/84901-1791749498/content/graph-conduit-v2.html` (fox, rabbit, owl, bear, cat, frog — copy each `<svg viewBox="0 0 64 64">` body), and draw the remaining six in the same flat style, same 64×64 viewBox, same eye construction (r 2.6 dark pupil + r 0.8 highlight), max ~10 shapes each:

```tsx
import type { JSX } from "react";
import { sessionAnimal, type Animal } from "./avatarId";

/** One path set per animal, all in a 64×64 viewBox (never rescale path data by hand —
 *  same rule as AGENT_MARKS). Fills are the only fixed colours in the view; they sit on
 *  --selection-bg in both themes. */
const ART: Record<Animal, JSX.Element> = {
  fox: (<>{/* paste the mockup fox body here */}</>),
  rabbit: (<>{/* mockup rabbit */}</>),
  owl: (<>{/* mockup owl */}</>),
  bear: (<>{/* mockup bear */}</>),
  cat: (<>{/* mockup cat */}</>),
  frog: (<>{/* mockup frog */}</>),
  panda: (
    <>
      <circle cx="17" cy="19" r="8" fill="#2b2826" /><circle cx="47" cy="19" r="8" fill="#2b2826" />
      <circle cx="32" cy="36" r="19" fill="#ece7e1" />
      <ellipse cx="24.5" cy="34" rx="5" ry="6" fill="#2b2826" transform="rotate(-20 24.5 34)" />
      <ellipse cx="39.5" cy="34" rx="5" ry="6" fill="#2b2826" transform="rotate(20 39.5 34)" />
      <circle cx="25" cy="34" r="2" fill="#f5f1ec" /><circle cx="39" cy="34" r="2" fill="#f5f1ec" />
      <ellipse cx="32" cy="42" rx="3" ry="2.2" fill="#2b2826" />
    </>
  ),
  penguin: (
    <>
      <ellipse cx="32" cy="36" rx="19" ry="21" fill="#3a3f4a" />
      <ellipse cx="32" cy="40" rx="13" ry="15" fill="#f1ece4" />
      <circle cx="26" cy="31" r="2.6" fill="#1b1310" /><circle cx="38" cy="31" r="2.6" fill="#1b1310" />
      <circle cx="27" cy="30" r=".8" fill="#fff" /><circle cx="39" cy="30" r=".8" fill="#fff" />
      <path d="M28 37 L36 37 L32 42 Z" fill="#c2a063" />
    </>
  ),
  koala: (
    <>
      <circle cx="14" cy="24" r="10" fill="#9a9792" /><circle cx="50" cy="24" r="10" fill="#9a9792" />
      <circle cx="14" cy="24" r="5" fill="#d9d4cd" /><circle cx="50" cy="24" r="5" fill="#d9d4cd" />
      <circle cx="32" cy="36" r="18" fill="#a8a59f" />
      <circle cx="25" cy="33" r="2.6" fill="#1b1310" /><circle cx="39" cy="33" r="2.6" fill="#1b1310" />
      <circle cx="26" cy="32" r=".8" fill="#fff" /><circle cx="40" cy="32" r=".8" fill="#fff" />
      <ellipse cx="32" cy="41" rx="4.5" ry="5.5" fill="#3a3330" />
    </>
  ),
  tiger: (
    <>
      <circle cx="18" cy="18" r="7" fill="#d4874a" /><circle cx="46" cy="18" r="7" fill="#d4874a" />
      <circle cx="32" cy="36" r="19" fill="#d98f4e" />
      <path d="M32 18 L29 26 L35 26 Z M14 34 L22 35 M14 40 L22 39 M50 34 L42 35 M50 40 L42 39" stroke="#3a2a22" strokeWidth="2.2" fill="#3a2a22" />
      <ellipse cx="32" cy="44" rx="9" ry="6" fill="#f3e6d8" />
      <circle cx="25" cy="34" r="2.6" fill="#1b1310" /><circle cx="39" cy="34" r="2.6" fill="#1b1310" />
      <circle cx="26" cy="33" r=".8" fill="#fff" /><circle cx="40" cy="33" r=".8" fill="#fff" />
      <path d="M30 41 L34 41 L32 43.5 Z" fill="#1b1310" />
    </>
  ),
  otter: (
    <>
      <circle cx="19" cy="22" r="5" fill="#7a5b44" /><circle cx="45" cy="22" r="5" fill="#7a5b44" />
      <circle cx="32" cy="36" r="18" fill="#8d6a50" />
      <ellipse cx="32" cy="43" rx="11" ry="8" fill="#d8c3a8" />
      <circle cx="25" cy="33" r="2.6" fill="#1b1310" /><circle cx="39" cy="33" r="2.6" fill="#1b1310" />
      <circle cx="26" cy="32" r=".8" fill="#fff" /><circle cx="40" cy="32" r=".8" fill="#fff" />
      <ellipse cx="32" cy="40" rx="3" ry="2.2" fill="#1b1310" />
      <path d="M20 44 L27 43 M20 47 L27 45 M44 44 L37 43 M44 47 L37 45" stroke="#5e4636" strokeWidth="1" />
    </>
  ),
  hedgehog: (
    <>
      <path d="M8 40 L12 22 L18 30 L22 14 L28 26 L32 10 L36 26 L42 14 L46 30 L52 22 L56 40 Z" fill="#6e5a48" />
      <ellipse cx="32" cy="42" rx="17" ry="14" fill="#d9c3a5" />
      <circle cx="26" cy="40" r="2.6" fill="#1b1310" /><circle cx="38" cy="40" r="2.6" fill="#1b1310" />
      <circle cx="27" cy="39" r=".8" fill="#fff" /><circle cx="39" cy="39" r=".8" fill="#fff" />
      <circle cx="32" cy="47" r="2.4" fill="#1b1310" />
    </>
  ),
};

export type AvatarTone = "running" | "needs" | "idle" | "stopped" | "visitor";

export function SessionAvatar({
  nodeKey, size = 72, tone = "idle", chipColor = null, badge = 0, title,
}: {
  nodeKey: string; size?: number; tone?: AvatarTone; chipColor?: string | null; badge?: number; title?: string;
}) {
  const animal = sessionAnimal(nodeKey);
  return (
    <div className={`session-avatar tone-${tone}`} style={{ width: size, height: size }} title={title}>
      <svg viewBox="0 0 64 64" width={size * 0.75} height={size * 0.75} aria-hidden="true">
        {ART[animal]}
      </svg>
      {badge > 0 && <span className="session-avatar-badge">{badge}</span>}
      {chipColor && <span className="session-avatar-chip" style={{ background: chipColor }} />}
    </div>
  );
}
```

Replace each `{/* paste … */}` with the real elements from the mockup, converting attribute names to JSX (`stroke-width` → `strokeWidth`, `stroke-linecap` → `strokeLinecap`). No placeholder comment may remain.

- [ ] **Step 6: CSS (`theme.css`, new block)**

```css
/* ---- Continuity view: session avatars ---- */
.session-avatar {
  position: relative; display: grid; place-items: center; flex: none;
  border-radius: 28%; background: var(--selection-bg);
  border: 2px solid var(--border); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}
.session-avatar.tone-running { border-color: color-mix(in srgb, var(--green) 70%, var(--border)); }
.session-avatar.tone-needs { border-color: var(--amber); animation: avatar-breathe 1.6s ease-in-out infinite; }
.session-avatar.tone-stopped { opacity: 0.4; filter: grayscale(0.6); }
.session-avatar.tone-visitor { border-style: dashed; opacity: 0.6; }
.session-avatar-badge {
  position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 9px; background: var(--accent); color: var(--panel-bg);
  font-size: 10.5px; font-weight: 700; line-height: 18px; text-align: center;
}
.session-avatar-chip {
  position: absolute; bottom: -5px; right: -5px; width: 12px; height: 12px;
  border-radius: 4px; border: 2px solid var(--panel-bg);
}
@keyframes avatar-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--amber) 45%, transparent); }
  50% { box-shadow: 0 0 0 8px transparent; }
}
@media (prefers-reduced-motion: reduce) { .session-avatar.tone-needs { animation: none; } }
```

- [ ] **Step 7: Verify** — `pnpm exec tsc --noEmit && pnpm test` clean.

- [ ] **Step 8: Commit**

```bash
git add src/avatarId.ts src/avatarId.test.ts src/avatars.tsx src/theme.css
git commit -m "feat(continuity): derived animal avatars for sessions"
```

---

### Task 10: Graph layout, pulses and pins (pure)

**Files:**
- Create: `src/graphLayout.ts`, `src/graphLayout.test.ts`, `src/continuityGraph.ts`, `src/continuityGraph.test.ts`

**Interfaces:**
- Produces: `layoutGraph(nodes: string[], edges: { a: string; b: string; count: number }[], pins: Record<string, Pt>, prev?: Record<string, Pt>): Record<string, Pt>` (`type Pt = { x: number; y: number }`, world units, centred on 0,0); types `GraphNode`, `GraphEdge`, `GraphSnapshot` mirroring Task 6's JSON; `type WatchedMessage = { id; from; to; kind; createdAt }`; `type Pulse = { id: string; a: string; b: string; reverse: boolean }`; `pulsesFor(messages: WatchedMessage[], snap: GraphSnapshot): Pulse[]`; `readPins(projectId, ls?)`/`writePins(projectId, pins, ls?)` on `conduit.continuityPins`.

- [ ] **Step 1: Failing tests `src/graphLayout.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graphLayout";

const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);

describe("layoutGraph", () => {
  it("is deterministic", () => {
    const n = ["a", "b", "c", "d"];
    const e = [{ a: "a", b: "b", count: 3 }];
    expect(layoutGraph(n, e, {})).toEqual(layoutGraph(n, e, {}));
  });
  it("keeps every node apart", () => {
    const n = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const pos = layoutGraph(n, [], {});
    for (let i = 0; i < n.length; i++)
      for (let j = i + 1; j < n.length; j++) expect(dist(pos[n[i]], pos[n[j]])).toBeGreaterThan(80);
  });
  it("pulls connected nodes closer than unconnected ones", () => {
    const n = ["a", "b", "c"];
    const pos = layoutGraph(n, [{ a: "a", b: "b", count: 10 }], {});
    expect(dist(pos.a, pos.b)).toBeLessThan(dist(pos.a, pos.c));
  });
  it("never moves a pinned node", () => {
    const pos = layoutGraph(["a", "b"], [{ a: "a", b: "b", count: 1 }], { a: { x: 500, y: -200 } });
    expect(pos.a).toEqual({ x: 500, y: -200 });
  });
  it("a new node does not reshuffle settled ones much", () => {
    const first = layoutGraph(["a", "b", "c"], [], {});
    const second = layoutGraph(["a", "b", "c", "d"], [], {}, first);
    for (const k of ["a", "b", "c"]) expect(dist(first[k], second[k])).toBeLessThan(60);
  });
  it("handles zero and one node", () => {
    expect(layoutGraph([], [], {})).toEqual({});
    expect(layoutGraph(["solo"], [], {})).toEqual({ solo: { x: 0, y: 0 } });
  });
});
```

- [ ] **Step 2: Failing tests `src/continuityGraph.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { pulsesFor, readPins, writePins, type GraphSnapshot } from "./continuityGraph";

const snap: GraphSnapshot = {
  available: true,
  nodes: [
    { key: "cs-1", conduitSessionId: "cs-1", continuityId: "c-1", label: "cs-1", status: "active", visitor: false },
    { key: "c-cli", continuityId: "c-cli", label: "root", status: "idle", visitor: false },
  ],
  edges: [], unanswered: {},
};

describe("pulsesFor", () => {
  it("maps continuity ids to node keys and orients the pulse", () => {
    // Edges are drawn a→b with a < b ("c-cli" < "cs-1"), so cli→cs-1 runs forward…
    const fwd = pulsesFor([{ id: "m1", from: "c-cli", to: "c-1", kind: "message", createdAt: "t" }], snap);
    expect(fwd).toEqual([{ id: "m1", a: "c-cli", b: "cs-1", reverse: false }]);
    // …and cs-1→cli runs the same edge reversed.
    const back = pulsesFor([{ id: "m1b", from: "c-1", to: "c-cli", kind: "message", createdAt: "t" }], snap);
    expect(back).toEqual([{ id: "m1b", a: "c-cli", b: "cs-1", reverse: true }]);
  });
  it("drops a message whose endpoint is not on screen", () => {
    expect(pulsesFor([{ id: "m2", from: "c-1", to: "ghost", kind: "message", createdAt: "t" }], snap)).toEqual([]);
  });
  it("drops self-messages", () => {
    expect(pulsesFor([{ id: "m3", from: "c-1", to: "c-1", kind: "message", createdAt: "t" }], snap)).toEqual([]);
  });
});

describe("pins", () => {
  it("round-trips per project and survives garbage", () => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    writePins("p1", { a: { x: 1, y: 2 } }, ls);
    writePins("p2", { b: { x: 3, y: 4 } }, ls);
    expect(readPins("p1", ls)).toEqual({ a: { x: 1, y: 2 } });
    store.set("conduit.continuityPins", "{not json");
    expect(readPins("p1", ls)).toEqual({});
    store.set("conduit.continuityPins", JSON.stringify({ p1: { a: { x: "nope" } } }));
    expect(readPins("p1", ls)).toEqual({});
  });
});
```

- [ ] **Step 3: Run both** — `pnpm test src/graphLayout.test.ts src/continuityGraph.test.ts` → FAIL.

- [ ] **Step 4: Implement `src/graphLayout.ts`**

```ts
/** Deterministic force layout for the Continuity graph. Pure: same input, same output, so
 *  the graph does not jitter between snapshot refetches. Repulsion between every pair,
 *  springs along edges (stronger with volume), gentle pull to the centre; pinned nodes are
 *  fixed. `prev` seeds settled nodes where they were, so a newcomer barely moves them. */
export type Pt = { x: number; y: number };

const ITER = 220;
const REPULSE = 26000;
const SPRING = 0.02;
const REST = 170;
const CENTER = 0.006;
const MIN_GAP = 96;

function seed(key: string): Pt {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const angle = ((h % 3600) / 3600) * Math.PI * 2;
  const r = 140 + (h >>> 12) % 120;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

export function layoutGraph(
  nodes: string[],
  edges: { a: string; b: string; count: number }[],
  pins: Record<string, Pt>,
  prev: Record<string, Pt> = {},
): Record<string, Pt> {
  if (nodes.length === 0) return {};
  if (nodes.length === 1) return { [nodes[0]]: pins[nodes[0]] ?? prev[nodes[0]] ?? { x: 0, y: 0 } };
  const keys = [...nodes].sort();
  const pos: Record<string, Pt> = {};
  for (const k of keys) pos[k] = { ...(pins[k] ?? prev[k] ?? seed(k)) };
  const settled = new Set(keys.filter((k) => k in prev));
  const live = edges.filter((e) => e.a in pos && e.b in pos && e.a !== e.b);

  for (let it = 0; it < ITER; it++) {
    const cool = 1 - it / ITER;
    const force: Record<string, Pt> = {};
    for (const k of keys) force[k] = { x: -pos[k].x * CENTER, y: -pos[k].y * CENTER };
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const p = pos[keys[i]], q = pos[keys[j]];
        let dx = p.x - q.x, dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = 1; dy = 0; d2 = 1; }
        const f = REPULSE / d2;
        const d = Math.sqrt(d2);
        force[keys[i]].x += (dx / d) * f; force[keys[i]].y += (dy / d) * f;
        force[keys[j]].x -= (dx / d) * f; force[keys[j]].y -= (dy / d) * f;
      }
    }
    for (const e of live) {
      const p = pos[e.a], q = pos[e.b];
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const k = SPRING * (1 + Math.log2(1 + e.count)) * (d - REST);
      force[e.a].x += (dx / d) * k; force[e.a].y += (dy / d) * k;
      force[e.b].x -= (dx / d) * k; force[e.b].y -= (dy / d) * k;
    }
    for (const k of keys) {
      if (pins[k]) continue;
      const damp = settled.has(k) ? 0.15 : 1; // settled nodes drift, newcomers move
      const step = Math.min(30 * cool, Math.hypot(force[k].x, force[k].y)) * damp;
      const m = Math.hypot(force[k].x, force[k].y) || 1;
      pos[k].x += (force[k].x / m) * step;
      pos[k].y += (force[k].y / m) * step;
    }
  }
  // Final separation pass: guarantee MIN_GAP between unpinned neighbours.
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i], b = keys[j];
        const dx = pos[b].x - pos[a].x, dy = pos[b].y - pos[a].y;
        const d = Math.hypot(dx, dy) || 1;
        if (d >= MIN_GAP) continue;
        const push = (MIN_GAP - d) / 2 + 0.5;
        const ux = dx / d, uy = dy / d;
        if (!pins[a]) { pos[a].x -= ux * push; pos[a].y -= uy * push; }
        if (!pins[b]) { pos[b].x += ux * push; pos[b].y += uy * push; }
      }
    }
  }
  const out: Record<string, Pt> = {};
  for (const k of nodes) out[k] = pins[k] ? { ...pins[k] } : { x: Math.round(pos[k].x), y: Math.round(pos[k].y) };
  return out;
}
```

If a test fails on tuning (gap, newcomer drift), adjust the constants — not the tests — and note the values in the commit body.

- [ ] **Step 5: Implement `src/continuityGraph.ts`**

```ts
/** Continuity graph: snapshot types (mirror continuity_graph.rs), live message → pulse
 *  mapping, and per-project pin storage. Store-free for vitest. */
import type { Pt } from "./graphLayout";

export type GraphNode = {
  key: string; conduitSessionId?: string; continuityId?: string; label: string; status: string;
  focus?: string; lastSeenAt?: string; visitor: boolean; visitorProjectId?: string;
};
export type GraphEdge = { a: string; b: string; count: number; lastAt: string };
export type GraphSnapshot = { available: boolean; nodes: GraphNode[]; edges: GraphEdge[]; unanswered: Record<string, number> };
export type WatchedMessage = { id: string; from: string; to: string; kind: string; createdAt: string };
export type Pulse = { id: string; a: string; b: string; reverse: boolean };

export const EMPTY_SNAPSHOT: GraphSnapshot = { available: false, nodes: [], edges: [], unanswered: {} };

/** A pulse per message whose BOTH endpoints are on screen. Endpoints arrive as continuity
 *  ids; nodes are keyed by Conduit session id where one exists. The edge is drawn a→b with
 *  a < b, so a message travelling b→a runs reversed. Anything unmappable is dropped — a
 *  pulse never invents a node or an edge. */
export function pulsesFor(messages: WatchedMessage[], snap: GraphSnapshot): Pulse[] {
  const keyOf = new Map<string, string>();
  for (const n of snap.nodes) {
    if (n.continuityId) keyOf.set(n.continuityId, n.key);
  }
  const out: Pulse[] = [];
  for (const m of messages) {
    const from = keyOf.get(m.from);
    const to = keyOf.get(m.to);
    if (!from || !to || from === to) continue;
    const [a, b] = from < to ? [from, to] : [to, from];
    out.push({ id: m.id, a, b, reverse: from !== a });
  }
  return out;
}

const PINS_KEY = "conduit.continuityPins";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const isPt = (v: unknown): v is Pt =>
  !!v && typeof (v as Pt).x === "number" && typeof (v as Pt).y === "number" &&
  Number.isFinite((v as Pt).x) && Number.isFinite((v as Pt).y);

function readAll(ls: Storage): Record<string, Record<string, Pt>> {
  try {
    const raw = JSON.parse(ls.getItem(PINS_KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function readPins(projectId: string, ls: Storage = localStorage): Record<string, Pt> {
  const all = readAll(ls)[projectId];
  if (!all || typeof all !== "object") return {};
  const out: Record<string, Pt> = {};
  for (const [k, v] of Object.entries(all)) if (isPt(v)) out[k] = { x: v.x, y: v.y };
  return out;
}

export function writePins(projectId: string, pins: Record<string, Pt>, ls: Storage = localStorage): void {
  try {
    const all = readAll(ls);
    all[projectId] = pins;
    ls.setItem(PINS_KEY, JSON.stringify(all));
  } catch {
    /* quota — non-fatal */
  }
}
```

- [ ] **Step 6: Run** — both files PASS.

- [ ] **Step 7: Commit**

```bash
git add src/graphLayout.ts src/graphLayout.test.ts src/continuityGraph.ts src/continuityGraph.test.ts
git commit -m "feat(continuity): deterministic graph layout, live pulses and pin storage"
```

---

### Task 11: The Continuity view — graph, cards, dock

**Files:**
- Create: `src/hooks/useContinuityGraph.ts`, `src/components/ContinuityView.tsx`, `src/components/ContinuityGraph.tsx`, `src/components/AskCard.tsx`, `src/components/AskDock.tsx`
- Modify: `src/components/WorkspaceCenter.tsx` (overlay + header button), `src/App.tsx` (mount `AskDock`), `src/theme.css`

**Interfaces:**
- Consumes: Tasks 6–10.
- Produces: `useContinuityGraph(projectId: string | null, active: boolean): { snap: GraphSnapshot; pulses: Pulse[]; dropPulse(id: string): void }`; `<ContinuityView projectId />`; `<AskCard ask anchored? />` (submits via `invoke("ask_answer")`, hands off via `invoke("ask_handoff")`); `<AskDock />`.

- [ ] **Step 1: `src/hooks/useContinuityGraph.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EMPTY_SNAPSHOT, pulsesFor, type GraphSnapshot, type Pulse, type WatchedMessage } from "../continuityGraph";

const REFETCH_DEBOUNCE_MS = 750;
const MAX_LIVE_PULSES = 40;

/** Snapshot on open; on every `continuity-changed`, pulses NOW (against the snapshot in
 *  hand) and a debounced refetch. Nothing runs while the view is closed — the Rust watcher
 *  is the only thing alive then. */
export function useContinuityGraph(projectId: string | null, active: boolean) {
  const [snap, setSnap] = useState<GraphSnapshot>(EMPTY_SNAPSHOT);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  useEffect(() => {
    if (!active || !projectId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchNow = () =>
      invoke<GraphSnapshot>("continuity_graph", { projectId })
        .then((s) => alive && setSnap(s))
        .catch(() => { /* keep the last good snapshot */ });
    void fetchNow();
    const un = listen<{ messages: WatchedMessage[] }>("continuity-changed", ({ payload }) => {
      const fresh = pulsesFor(payload.messages, snapRef.current);
      if (fresh.length) setPulses((p) => [...p, ...fresh].slice(-MAX_LIVE_PULSES));
      clearTimeout(timer);
      timer = setTimeout(fetchNow, REFETCH_DEBOUNCE_MS);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      void un.then((f) => f());
      setPulses([]);
    };
  }, [projectId, active]);

  const dropPulse = useCallback((id: string) => setPulses((p) => p.filter((x) => x.id !== id)), []);
  return { snap, pulses, dropPulse };
}
```

- [ ] **Step 2: `src/components/AskCard.tsx`**

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { buildAnswers, type PendingAsk } from "../asks";

/** One AskUserQuestion. Answering resolves the blocked hook in Rust; "Answer in terminal"
 *  hands it back so Claude's own menu appears. `false` from ask_answer = it already
 *  resolved elsewhere (terminal, another window, the 600 s ceiling). */
export function AskCard({ ask, sessionName, className = "" }: { ask: PendingAsk; sessionName: string; className?: string }) {
  const [page, setPage] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "sending" | "gone" | "error">("idle");
  const q = ask.questions[page];
  const answers = buildAnswers(ask.questions, picks, typed);
  const last = page === ask.questions.length - 1;

  const pick = (label: string) =>
    setPicks((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });

  const send = async () => {
    if (!answers) return;
    setState("sending");
    try {
      const ok = await invoke<boolean>("ask_answer", { id: ask.id, answers });
      setState(ok ? "idle" : "gone");
    } catch {
      setState("error");
    }
  };

  // A single-select single-question card answers on click, like the TUI menu.
  const oneShot = ask.questions.length === 1 && !q.multiSelect;

  return (
    <div className={`ask-card ${className}`} role="dialog" aria-label={`${sessionName} asks`}>
      <div className="ask-card-hd">{sessionName} asks{q.header ? ` · ${q.header}` : ""}</div>
      <div className="ask-card-q">{q.question}</div>
      {state === "gone" ? (
        <div className="ask-card-note">Already answered in the terminal.</div>
      ) : (
        <>
          {q.options.map((o) => {
            const on = (picks[q.question] ?? []).includes(o.label);
            return (
              <button
                key={o.label}
                type="button"
                className={`ask-card-opt ${on ? "on" : ""}`}
                disabled={state === "sending"}
                onClick={async () => {
                  pick(o.label);
                  if (oneShot) {
                    setState("sending");
                    try {
                      const ok = await invoke<boolean>("ask_answer", { id: ask.id, answers: { [q.question]: o.label } });
                      setState(ok ? "idle" : "gone");
                    } catch {
                      setState("error");
                    }
                  }
                }}
              >
                {o.label}
                {o.description && <small>{o.description}</small>}
              </button>
            );
          })}
          <input
            className="ask-card-text"
            placeholder="Type an answer…"
            value={typed[q.question] ?? ""}
            onChange={(e) => setTyped((t) => ({ ...t, [q.question]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!last) setPage(page + 1);
                else void send();
              }
            }}
          />
          <div className="ask-card-ft">
            <button type="button" className="ask-card-link" onClick={() => void invoke("ask_handoff", { id: ask.id })}>
              Answer in terminal ↗
            </button>
            {ask.questions.length > 1 && (
              <span className="ask-card-pages">
                {ask.questions.map((_, i) => <i key={i} className={i === page ? "on" : ""} />)}
              </span>
            )}
            {!oneShot &&
              (last ? (
                <button type="button" className="ask-card-send" disabled={!answers || state === "sending"} onClick={() => void send()}>
                  Send
                </button>
              ) : (
                <button type="button" className="ask-card-send" onClick={() => setPage(page + 1)}>Next</button>
              ))}
          </div>
          {state === "error" && <div className="ask-card-note">Couldn't send — try again or answer in the terminal.</div>}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: `src/components/ContinuityGraph.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { SessionAvatar, type AvatarTone } from "../avatars";
import { layoutGraph, type Pt } from "../graphLayout";
import { readPins, writePins, type GraphSnapshot, type Pulse } from "../continuityGraph";
import type { PendingAsk } from "../asks";
import { AskCard } from "./AskCard";

export type NodeView = { key: string; name: string; meta: string; tone: AvatarTone; chip: string | null; badge: number; ask?: PendingAsk };

/** DOM + SVG only — no terminals live here, so scale() is safe (crisp vectors) and none of
 *  the canvas's stacking hazards apply. World coords are centred on 0,0; the layer is
 *  translated to the viewport centre plus pan, then scaled. */
export function ContinuityGraph({
  projectId, snap, views, pulses, onPulseEnd, onOpen,
}: {
  projectId: string; snap: GraphSnapshot; views: Record<string, NodeView>; pulses: Pulse[];
  onPulseEnd: (id: string) => void; onOpen: (key: string) => void;
}) {
  const [pins, setPins] = useState(() => readPins(projectId));
  useEffect(() => setPins(readPins(projectId)), [projectId]);
  const prev = useRef<Record<string, Pt>>({});
  const keys = snap.nodes.map((n) => n.key);
  const pos = useMemo(() => {
    const p = layoutGraph(keys, snap.edges, pins, prev.current);
    prev.current = p;
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join("|"), JSON.stringify(snap.edges), JSON.stringify(pins)]);

  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{ kind: "pan" | "node"; key?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const nowIso = new Date(Date.now() - 10 * 60_000).toISOString();
  const pathOf = (a: string, b: string) => {
    const p = pos[a], q = pos[b];
    if (!p || !q) return "";
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    const nx = -(q.y - p.y) * 0.15, ny = (q.x - p.x) * 0.15;
    return `M${p.x} ${p.y} Q${mx + nx} ${my + ny} ${q.x} ${q.y}`;
  };

  return (
    <div
      className="cgraph"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".cgraph-node, .ask-card")) return;
        drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        if (d.kind === "pan") setPan({ x: d.ox + dx, y: d.oy + dy });
        else if (d.key) setPins((p) => ({ ...p, [d.key!]: { x: d.ox + dx / zoom, y: d.oy + dy / zoom } }));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.kind === "node" && d.key) {
          if (d.moved) writePins(projectId, pins);
          else onOpen(d.key);
        }
      }}
      onWheel={(e) => setZoom((z) => Math.min(2, Math.max(0.4, z * (e.deltaY > 0 ? 0.92 : 1.08))))}
    >
      <div className="cgraph-layer" style={{ transform: `translate(calc(50% + ${pan.x}px), calc(50% + ${pan.y}px)) scale(${zoom})` }}>
        <svg className="cgraph-edges" overflow="visible">
          {snap.edges.map((e) => (
            <path
              key={`${e.a}|${e.b}`}
              id={`cedge-${e.a}|${e.b}`}
              d={pathOf(e.a, e.b)}
              className={`cgraph-edge ${e.lastAt < nowIso ? "quiet" : ""}`}
              strokeWidth={Math.min(5, 1 + Math.log2(1 + e.count))}
            />
          ))}
          {pulses.map((p) =>
            reduced ? null : (
              <circle key={p.id} r={5} className="cgraph-pulse">
                <animateMotion
                  dur="1.4s"
                  fill="freeze"
                  path={pathOf(p.a, p.b)}
                  keyPoints={p.reverse ? "1;0" : "0;1"}
                  keyTimes="0;1"
                  calcMode="linear"
                  onEndEvent={() => onPulseEnd(p.id)}
                />
              </circle>
            ),
          )}
        </svg>
        {snap.nodes.map((n) => {
          const v = views[n.key];
          const p = pos[n.key];
          if (!v || !p) return null;
          return (
            <div key={n.key} className="cgraph-node" style={{ left: p.x, top: p.y }}
              onPointerDown={(e) => {
                e.stopPropagation();
                const at = pins[n.key] ?? p;
                drag.current = { kind: "node", key: n.key, sx: e.clientX, sy: e.clientY, ox: at.x, oy: at.y, moved: false };
                (e.currentTarget.closest(".cgraph") as HTMLElement).setPointerCapture(e.pointerId);
              }}
            >
              <SessionAvatar nodeKey={n.key} size={n.visitor ? 56 : 72} tone={v.tone} chipColor={v.chip} badge={v.badge} />
              <div className="cgraph-name">{v.name}</div>
              <div className={`cgraph-meta ${v.tone === "needs" ? "needs" : ""}`}>{v.meta}</div>
              {v.ask && <AskCard ask={v.ask} sessionName={v.name} className="anchored" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

(`onEndEvent` is the React prop for SVG `endEvent`. If WebKit does not fire it under React, fall back to a `setTimeout(onPulseEnd, 1500)` scheduled when the pulse is created — check in the dev app and keep whichever fires.)

- [ ] **Step 4: `src/components/ContinuityView.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useStore, findSession } from "../store";
import { resolveProjectColor } from "../layout";
import { useContinuityGraph } from "../hooks/useContinuityGraph";
import { ContinuityGraph, type NodeView } from "./ContinuityGraph";
import { SessionDrawer } from "./SessionDrawer";

/** The per-project Continuity overlay. Renders over still-mounted terminals, like the
 *  task board. Read-only toward continuity; the only action is answering a question. */
export function ContinuityView({ projectId }: { projectId: string }) {
  const { snap, pulses, dropPulse } = useContinuityGraph(projectId, true);
  const projects = useStore((s) => s.projects);
  const live = useStore((s) => s.live);
  const asks = useStore((s) => s.asks);
  const autoColors = useStore((s) => s.autoProjectColors);
  const [open, setOpen] = useState<string | null>(null);

  const views = useMemo(() => {
    const out: Record<string, NodeView> = {};
    const askBySession = new Map(Object.values(asks).map((a) => [a.session, a]));
    for (const n of snap.nodes) {
      const found = n.conduitSessionId ? findSession(projects, n.conduitSessionId) : null;
      const session = found?.session;
      const ask = n.conduitSessionId ? askBySession.get(n.conduitSessionId) : undefined;
      const status = n.conduitSessionId ? live[n.conduitSessionId]?.status : undefined;
      const tone = n.visitor ? "visitor" : ask || status === "needsInput" ? "needs"
        : session?.stopped ? "stopped" : status === "running" ? "running" : "idle";
      const meta = ask ? "waiting on you" : n.visitor ? `visitor · ${found?.project.name ?? "other checkout"}`
        : session?.stopped ? "stopped" : status === "running" ? "running" : n.status === "none" ? "not checked in" : n.status;
      const visitorProject = n.visitorProjectId ? projects.find((p) => p.id === n.visitorProjectId) : undefined;
      out[n.key] = {
        key: n.key,
        name: session?.name ?? n.label,
        meta,
        tone,
        chip: visitorProject ? resolveProjectColor(visitorProject, autoColors) : null,
        badge: snap.unanswered[n.key] ?? 0,
        ask,
      };
    }
    return out;
  }, [snap, projects, live, asks, autoColors]);

  return (
    <div className="continuity-view">
      <div className="continuity-tabs">
        <span className="continuity-tab on">Graph</span>
        {!snap.available && <span className="continuity-unavail">Continuity isn't running for this project — showing sessions only.</span>}
      </div>
      <ContinuityGraph projectId={projectId} snap={snap} views={views} pulses={pulses} onPulseEnd={dropPulse} onOpen={setOpen} />
      {snap.nodes.length === 0 && <div className="continuity-empty">No sessions in this project yet.</div>}
      {open && <SessionDrawer projectId={projectId} node={snap.nodes.find((n) => n.key === open) ?? null} onClose={() => setOpen(null)} />}
    </div>
  );
}
```

Check `resolveProjectColor`'s real signature in `layout.ts` and `findSession`'s export location, and adapt the two calls. `SessionDrawer` is Task 12 — for this task create it as the minimal real component below and Task 12 fills it in:

```tsx
// src/components/SessionDrawer.tsx (Task 11 version)
import type { GraphNode } from "../continuityGraph";
export function SessionDrawer({ node, onClose }: { projectId: string; node: GraphNode | null; onClose: () => void }) {
  if (!node) return null;
  return (
    <aside className="session-drawer">
      <button type="button" className="session-drawer-x" onClick={onClose} aria-label="Close">×</button>
      <h3>{node.label}</h3>
    </aside>
  );
}
```

- [ ] **Step 5: `src/components/AskDock.tsx` and mount**

```tsx
import { useStore, findSession } from "../store";
import { effectiveCenterMode } from "../centerViews";
import { AskCard } from "./AskCard";

/** When the Continuity view is not on screen, a captured question still has to be visible:
 *  the oldest one docks bottom-right with a count of the rest. */
export function AskDock() {
  const asks = useStore((s) => Object.values(s.asks).sort((a, b) => a.createdMs - b.createdMs));
  const viewVisible = useStore((s) => !!s.selectedProjectId &&
    effectiveCenterMode(s.centerMode[s.selectedProjectId], s) === "continuity");
  const projects = useStore((s) => s.projects);
  if (viewVisible || asks.length === 0) return null;
  const first = asks[0];
  const name = findSession(projects, first.session)?.session.name ?? "A session";
  return (
    <div className="ask-dock">
      <AskCard ask={first} sessionName={name} />
      {asks.length > 1 && <div className="ask-dock-more">+{asks.length - 1} more waiting</div>}
    </div>
  );
}
```

(The `Object.values(...).sort` selector returns a new array every render — use the file's shallow-equality selector idiom or select `s.asks` and sort in the body.) Mount `<AskDock />` once in `App.tsx` next to the toast host.

- [ ] **Step 6: Overlay + header button in `WorkspaceCenter.tsx`**

Beside the board overlay (~:616):

```tsx
        {projectId && mode === "continuity" && !canvasMode && (
          <div className="board-overlay continuity-overlay">
            <ContinuityView projectId={projectId} />
          </div>
        )}
```

In `GroupTabStrip`, before the Board button, when `isActiveGroup && prefs.continuityViewEnabled`:

```tsx
        <button
          type="button"
          className={`header-btn board-tab ${mode === "continuity" ? "active" : ""}`}
          title="Continuity view (⇧⌘K)"
          onClick={() => toggleCenterMode(projectId, "continuity")}
        >
          <span className="board-tab-dot" />
          <span>Continuity</span>
          {askCount > 0 && <span className="header-badge">{askCount}</span>}
        </button>
```

where `askCount` = number of `asks` whose session belongs to this project.

- [ ] **Step 7: CSS (`theme.css`)**

```css
/* ---- Continuity view ---- */
.continuity-view { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--panel-bg); }
.continuity-tabs { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--sidebar-bg); }
.continuity-tab { padding: 4px 10px; border-radius: 6px; color: var(--text-mid); font-size: 13px; cursor: pointer; }
.continuity-tab.on { background: var(--selection-bg); color: var(--text-bright); }
.continuity-unavail { margin-left: auto; font-size: 10.5px; color: var(--text-mid); }
.continuity-empty { position: absolute; inset: 38px 0 0; display: grid; place-items: center; color: var(--text-mid); pointer-events: none; }
.cgraph {
  position: relative; flex: 1; overflow: hidden; cursor: grab; touch-action: none;
  background-color: var(--panel-bg);
  background-image:
    linear-gradient(var(--hq-grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--hq-grid-line) 1px, transparent 1px);
  background-size: 24px 24px;
}
.cgraph:active { cursor: grabbing; }
.cgraph-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
.cgraph-edges { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; }
.cgraph-edge { fill: none; stroke: color-mix(in srgb, var(--accent) 55%, transparent); stroke-linecap: round; }
.cgraph-edge.quiet { stroke: color-mix(in srgb, var(--text-dim) 60%, transparent); }
.cgraph-pulse { fill: var(--accent); filter: drop-shadow(0 0 6px var(--accent)); }
.cgraph-node { position: absolute; width: 112px; transform: translate(-50%, -36px); display: flex; flex-direction: column; align-items: center; cursor: pointer; }
.cgraph-name { margin-top: 7px; font-size: 13px; color: var(--text-bright); white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.cgraph-meta { font-size: 10.5px; color: var(--text-mid); white-space: nowrap; }
.cgraph-meta.needs { color: var(--amber); }
.ask-card {
  width: 260px; padding: 11px 12px 12px; border-radius: 14px; text-align: left; cursor: default;
  background: color-mix(in srgb, var(--amber) 10%, var(--sidebar-bg));
  border: 1px solid color-mix(in srgb, var(--amber) 45%, var(--border));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); animation: ask-pop 0.35s ease-out both;
}
.ask-card.anchored { position: absolute; left: calc(50% + 50px); top: -6px; z-index: 3; }
.ask-card-hd { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: color-mix(in srgb, var(--amber) 75%, var(--text-bright)); }
.ask-card-q { margin: 4px 0 9px; font-size: 13px; line-height: 1.35; color: var(--text-bright); }
.ask-card-opt {
  display: block; width: 100%; margin: 0 0 6px; padding: 7px 9px; border-radius: 9px; text-align: left;
  background: var(--selection-bg); border: 1px solid var(--border); color: var(--text-bright); font: 13px var(--ui-font); cursor: pointer;
}
.ask-card-opt small { display: block; margin-top: 1px; font-size: 10.5px; color: var(--text-mid); }
.ask-card-opt:hover, .ask-card-opt.on { border-color: var(--accent); }
.ask-card-text { width: 100%; margin: 2px 0 6px; padding: 6px 9px; border-radius: 9px; border: 1px solid var(--border); background: var(--panel-bg); color: var(--text-bright); font: 13px var(--ui-font); }
.ask-card-ft { display: flex; align-items: center; gap: 8px; font-size: 10.5px; }
.ask-card-link { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; cursor: pointer; }
.ask-card-send { margin-left: auto; padding: 4px 12px; border-radius: 7px; border: 0; background: var(--accent); color: var(--panel-bg); font: 600 13px var(--ui-font); cursor: pointer; }
.ask-card-send:disabled { opacity: 0.45; cursor: default; }
.ask-card-pages { display: flex; gap: 4px; }
.ask-card-pages i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); }
.ask-card-pages i.on { background: var(--amber); }
.ask-card-note { margin-top: 6px; font-size: 10.5px; color: var(--text-mid); }
.ask-dock { position: fixed; right: 16px; bottom: 16px; z-index: 60; }
.ask-dock-more { margin-top: 6px; text-align: right; font-size: 10.5px; color: var(--text-mid); }
@keyframes ask-pop { from { opacity: 0; transform: translateY(6px) scale(0.97); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .ask-card { animation: none; } }
```

Check `--hq-grid-line` is defined at `:root` scope (theme.css ~:5647 defines it inside a selector — if it is scoped to `.hq-*`, hoist the two definitions (dark + light) to the same root/theme blocks the other tokens use, and say so in the commit).

- [ ] **Step 8: Verify in the dev app**

`pnpm exec tsc --noEmit && pnpm test`, then `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`:
1. ⇧⌘K opens the view; nodes appear for the project's sessions; pan/zoom/drag-pin work; a pinned node keeps its spot after closing and reopening.
2. Two Claude sessions in the project: ask one to `message_send` the other via Continuity → a pulse runs along their edge within ~1 s; the edge appears/thickens after the refetch.
3. A session calls `AskUserQuestion` → amber card beside its avatar; clicking an option answers it (the agent reports the answer, the TUI menu never shows).
4. Close the view, trigger another question → it docks bottom-right; click "Answer in terminal ↗" → the TUI menu appears in that session.
5. Trigger a question, then click that session's tab → the card leaves and the menu appears (hand-off).
6. Toggle Settings → Continuity view off → the button, shortcut and cards vanish; a new question goes straight to the terminal.
Record what you observed for each in the commit body.

- [ ] **Step 9: Commit**

```bash
git add src/hooks/useContinuityGraph.ts src/components/ContinuityView.tsx src/components/ContinuityGraph.tsx src/components/AskCard.tsx src/components/AskDock.tsx src/components/SessionDrawer.tsx src/components/WorkspaceCenter.tsx src/App.tsx src/theme.css
git commit -m "feat(continuity): the Continuity view — live session graph and question cards"
```

---

### Task 12: Session drawer

**Files:**
- Modify: `src/components/SessionDrawer.tsx` (full version), `src/components/SessionChat.tsx` (`readOnly` prop), `src/theme.css`

**Interfaces:**
- Consumes: `SessionChat({ sessionId, onClose, readOnly? })`, `GraphNode`, store `projects`, `selectSession` (check its real name/signature in `store.ts`), `continuityFeed` is NOT used — visitor details come from the node itself.
- Produces: the drawer described in spec §7.

- [ ] **Step 1: `SessionChat` read-only**

Add `readOnly?: boolean` to its props; when true, do not render the `.hq-thread-composer` block (~:207) and skip any focus/keyboard effect that targets the composer. Default `false` — the existing mount in `Terminal.tsx` is untouched.

- [ ] **Step 2: Drawer**

```tsx
import { useEffect } from "react";
import type { GraphNode } from "../continuityGraph";
import { useStore, findSession } from "../store";
import { SessionAvatar } from "../avatars";
import SessionChat from "./SessionChat"; // match the real export style

/** Avatar click. A Claude session reads as its conversation (read-only — the composer
 *  lives in the session's own pane); other agents get a stub; a visitor gets what
 *  continuity knows. "Open session" jumps to the real tab. */
export function SessionDrawer({ node, onClose }: { projectId: string; node: GraphNode | null; onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const selectSession = useStore((s) => s.selectSession);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  if (!node) return null;
  const found = node.conduitSessionId ? findSession(projects, node.conduitSessionId) : null;
  const isClaude = found?.session.agent === "claude";
  return (
    <aside className="session-drawer" aria-label={`${found?.session.name ?? node.label} details`}>
      <header className="session-drawer-hd">
        <SessionAvatar nodeKey={node.key} size={40} tone={node.visitor ? "visitor" : "idle"} />
        <div>
          <div className="session-drawer-name">{found?.session.name ?? node.label}</div>
          <div className="session-drawer-meta">{node.visitor ? `visitor · ${found?.project.name ?? "outside Conduit"}` : node.status}</div>
        </div>
        {found && (
          <button type="button" className="header-btn" onClick={() => { selectSession(found.project.id, found.session.id); onClose(); }}>
            Open session ↗
          </button>
        )}
        <button type="button" className="session-drawer-x" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="session-drawer-body">
        {found && isClaude ? (
          <SessionChat sessionId={found.session.id} onClose={onClose} readOnly />
        ) : found ? (
          <p className="session-drawer-note">This agent has no conversation view. Open the session to see its terminal.</p>
        ) : (
          <dl className="session-drawer-facts">
            <dt>Focus</dt><dd>{node.focus ?? "—"}</dd>
            <dt>Last seen</dt><dd>{node.lastSeenAt ?? "—"}</dd>
            <dt>Continuity id</dt><dd><code>{node.continuityId}</code></dd>
          </dl>
        )}
      </div>
    </aside>
  );
}
```

Adapt `selectSession`'s argument list to the store's real signature, and the `SessionChat` import to its real export.

- [ ] **Step 3: CSS**

```css
.session-drawer { position: absolute; top: 38px; right: 0; bottom: 0; width: 420px; max-width: 90%; z-index: 5; display: flex; flex-direction: column; background: var(--sidebar-bg); border-left: 1px solid var(--border); box-shadow: -12px 0 30px rgba(0, 0, 0, 0.35); }
.session-drawer-hd { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.session-drawer-name { font-size: 13px; color: var(--text-bright); }
.session-drawer-meta { font-size: 10.5px; color: var(--text-mid); }
.session-drawer-hd .header-btn { margin-left: auto; }
.session-drawer-x { background: none; border: 0; color: var(--text-mid); font-size: 16px; cursor: pointer; }
.session-drawer-body { position: relative; flex: 1; overflow: auto; }
.session-drawer-note { padding: 16px; color: var(--text-mid); font-size: 13px; }
.session-drawer-facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; padding: 16px; font-size: 13px; }
.session-drawer-facts dt { color: var(--text-mid); }
```

(`SessionChat` is absolutely positioned for `.term-host`; inside `.session-drawer-body` (position: relative) it fills the body. Check it does not grab focus from the graph.)

- [ ] **Step 4: Verify** — tsc, tests, dev app: click a Claude avatar → its conversation renders read-only; Esc closes; "Open session ↗" lands on the tab; a non-Claude session shows the stub; a visitor shows facts. The original chat pane (Settings → rich view) still has its composer.

- [ ] **Step 5: Commit**

```bash
git add src/components/SessionDrawer.tsx src/components/SessionChat.tsx src/theme.css
git commit -m "feat(continuity): avatar drawer with a read-only conversation"
```

---

### Task 13: Release 0.41.0

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml` (line 3), `src-tauri/tauri.conf.json`, `Cargo.lock` (via build), `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md** — add a section after "Where the continuity panels live":

```markdown
## Where the Continuity view lives

A per-project center overlay (`CenterMode` `"continuity"`, ⇧⌘K) drawing sessions as derived
animal avatars linked by the Continuity messages they exchange, plus Claude Code
`AskUserQuestion` prompts answered from a card. Conduit still never writes continuity.

- **Questions ride a BLOCKING hook, and every failure is `{}`.** `hooks.rs`'s `/ask` route +
  `asks.rs`. The protocol was pinned empirically (claude 2.1.293): `allow` + `updatedInput`
  with `answers` answers the question; an empty object makes the TUI menu appear. The three
  ceilings are ordered and a test pins it: `ASK_CEILING` 600 s < curl `-m 650` < hook
  `timeout: 660` — the default hook timeout is 60 s, so dropping the entry's `timeout` would
  silently kill every card after a minute.
- **The gate is closed unless a card can be seen** (`set_ask_gate`, `asks.ts askGateOpen`):
  view open or a Conduit window focused. The same `settings.local.json` is read by a `claude`
  the user runs by hand in that checkout; it posts `session=unknown` and is answered `{}` at once.
- **Hand-off is to the session's own terminal** (`askShouldHandOff`), and `ask_answer`
  returning `false` means "already answered there" — not an error.
- **`continuity_watch.rs` polls `PRAGMA data_version`**, which moves only on another
  connection's commit; only `messages` has a cursor because only a new message is a pulse.
- **Avatars are derived** (`avatarId.ts sessionAnimal`), never stored — same rule as
  `projectAccent`.
- Canvas and Board are opt-in (`canvasEnabled`/`boardEnabled`, default off);
  `centerViews.ts` owns the gating and the three-way exclusion — callers no longer close
  the canvas themselves.
- Design: `docs/superpowers/specs/2026-10-12-continuity-view-design.md`.
```

- [ ] **Step 2: Version + changelog**

Set `0.41.0` in the three version files, run `cargo build --manifest-path src-tauri/Cargo.toml`, run the sanity grep from CLAUDE.md. Prepend to `CHANGELOG.md` (match the file's existing entry format exactly):

```markdown
## 0.41.0 — 2026-10-12

- **Added — Continuity view.** A live map of a project's sessions (⇧⌘K): each session is a little animal, linked to the sessions it talks to through Continuity, with a pulse every time one messages another. Sessions from other projects that message in appear as dimmed visitors. Click an avatar to read its conversation.
- **Added — Answer agent questions from the map.** When a Claude session asks you a multiple-choice question, it appears as a card next to its avatar (or in the corner when the view is closed) and you can answer it there. Open that session's terminal and the question moves back to the terminal as usual.
- **Changed — Canvas and Task board are now optional.** Both are off by default; turn them on in Settings → General. Your canvas layout and board cards are kept and come back when you switch them on.
```

- [ ] **Step 3: Full gates**

```bash
pnpm exec tsc --noEmit && pnpm test && pnpm build
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all green. Record counts (vitest N/N, cargo N) in the commit body.

- [ ] **Step 4: Commit**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md CLAUDE.md
git commit -m "chore(release): 0.41.0"
```

---

# Increment 2 — 0.42.0

### Task 14: Service table reads

**Files:**
- Create: `src-tauri/src/continuity_tables.rs`
- Modify: `src-tauri/src/lib.rs` (`mod`, command `continuity_tables`, register)

**Interfaces:**
- Consumes: `continuity_feed::{resolve_session_ids, probe, placeholders, read_decisions}`, `continuity_fixture` (tests), `project_toplevels` (Task 6).
- Produces: command `continuity_tables(project_id: String, tab: String) -> TablesView`; `TablesView = { available: bool, tab: String, rows: Vec<serde_json::Value> }` with row shapes (camelCase):
  - `decisions`: `FeedDecision` as today.
  - `handoffs`: `{ id, from, to?, status, context, nextActions?, createdAt }` — `from`/`to` are continuity ids.
  - `tasks`: `{ id, repo, issue, status, claimant?, pr?, expiresAt, lastActivityAt }`.
  - `files`: `{ path, sessions: [continuityId], tools: [tool], touchedAt, collision: bool }` (last 30 min, grouped by path, `collision` = ≥ 2 distinct sessions).
  - `activity`: `{ id, type, session?, createdAt, payload? }` (newest 200).
  Scope: rows whose session column is in `resolve_session_ids` (handoffs: from OR to; tasks: claimant; files/activity: agent_session_id). An unknown `tab` → `available: false`.

- [ ] **Step 1: Failing tests** — one per tab, against `continuity_fixture::temp_db`, each inserting one in-scope and one out-of-scope row and asserting only the in-scope one returns; plus `files_groups_by_path_and_flags_collisions` (two in-scope sessions touching `src/a.ts` within 30 min → one row, `collision: true`; one touching `src/b.ts` 2 h ago → absent) and `unknown_tab_is_unavailable`. Write each test fully in the same style as Task 6's (seed `agent_sessions` with `agent_label` = a project session id; assert on returned JSON fields).

- [ ] **Step 2: Run** — `cargo test --manifest-path src-tauri/Cargo.toml continuity_tables::` → FAIL.

- [ ] **Step 3: Implement** — one `fn read_<tab>(conn, scope: &[String]) -> rusqlite::Result<Vec<Value>>` per tab with the SQL below, and `pub fn tables_from_db(path, project_sessions, toplevels, tab) -> TablesView` dispatching on `tab` (open_ro → probe → resolve scope → read; any error → `available: false`):

```sql
-- handoffs
SELECT id, from_agent_session_id, to_agent_session_id, status, context, suggested_next_actions, created_at
FROM handoffs WHERE from_agent_session_id IN (S) OR to_agent_session_id IN (S) ORDER BY created_at DESC LIMIT 200;
-- tasks
SELECT id, repo_full_name, issue_number, status, claimed_by_agent_session_id, pr_number, expires_at, last_activity_at
FROM task_claims WHERE claimed_by_agent_session_id IN (S) ORDER BY last_activity_at DESC LIMIT 200;
-- files (group in Rust)
SELECT file_path, agent_session_id, tool, touched_at FROM file_activity
WHERE agent_session_id IN (S) AND touched_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes')
ORDER BY touched_at DESC;
-- activity
SELECT id, event_type, agent_session_id, created_at, payload FROM audit_events
WHERE agent_session_id IN (S) ORDER BY created_at DESC LIMIT 200;
```

(`(S)` = `placeholders(scope.len())`; bind `scope` twice for handoffs. `decisions` reuses `read_decisions(conn, &scope, 200)` serialized with `serde_json::to_value`.) Truncate `payload` and `context` to 2 KB server-side.

- [ ] **Step 4: Run** — PASS; full cargo test + clippy + fmt.

- [ ] **Step 5: Commit** — `git commit -m "feat(continuity): scoped reads for handoffs, tasks, files and activity"`

---

### Task 15: Tables UI

**Files:**
- Create: `src/continuityTables.ts` (+ `.test.ts`), `src/components/ContinuityTables.tsx`
- Modify: `src/components/ContinuityView.tsx` (tabs), `src/components/ContinuityGraph.tsx` (`focusKey` prop: pan to and briefly ring a node), `src/theme.css`

**Interfaces:**
- Consumes: Task 14 command; `continuity-changed` event.
- Produces: `type TableTab = "graph" | "decisions" | "handoffs" | "tasks" | "files" | "activity"`; pure helpers in `continuityTables.ts`: `relativeTime(iso: string, nowMs: number): string` ("just now", "4m", "3h", "2d"), `nodeKeyForContinuityId(id: string, snap: GraphSnapshot): string | null`, `supersedeChain(decisions: FeedDecision[], id: string): string[]` (ids from newest to oldest following `supersedes`, cycle-safe).

- [ ] **Step 1: Failing tests** for the three helpers: `relativeTime` boundaries (59 s → "just now", 60 s → "1m", 90 min → "1h", 49 h → "2d"); `nodeKeyForContinuityId` maps a Conduit session's continuity id to its Conduit key and returns null for an unknown id; `supersedeChain` follows `d3 → d2 → d1`, stops at a missing link, and terminates on a cycle `a → b → a`.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the helpers. **Step 4: Run** — PASS.

- [ ] **Step 5: Component** — `ContinuityTables({ projectId, tab, snap, onFocusNode })`: fetch `continuity_tables` for the active tab on mount/tab change and on every `continuity-changed` (debounced 750 ms, same as the graph); render a `<table className="ctable">` per tab with these columns:
  - Decisions: Key · Type · Status · Author (avatar 22 px + name) · When · Chain (`a → b → c` keys, from `supersedeChain`).
  - Handoffs: From → To (avatars) · Status · Context (2-line clamp) · Next actions · When.
  - Tasks: Issue (`repo#123`) · Status · Claimant (avatar) · PR · Expires.
  - Files: Path · Who (avatars) · Tool · When; `collision` rows get class `collision` (amber left border via `box-shadow: inset 3px 0 0 var(--amber)`, plus the text "2 sessions").
  - Activity: When · Type (chip) · Who · Payload (monospace, 1-line clamp, full on hover title). Type filter chips above the table, from the distinct types present.
  Every avatar is a button: `onFocusNode(nodeKeyForContinuityId(id, snap))` switches the view to the Graph tab and passes `focusKey` to `ContinuityGraph`, which pans so that node is centred and adds a 1.2 s accent ring (dropped under reduced motion). Unavailable → "Continuity isn't running for this project." Empty → "Nothing here yet." Avatars for ids not in the snapshot render as a neutral circle with the first two characters.
- `ContinuityView` tab strip becomes real buttons for all six tabs, with counts from the last fetch where cheap (decisions/handoffs/tasks).

- [ ] **Step 6: CSS** — `.ctable { width: 100%; border-collapse: collapse; font-size: 13px; } .ctable th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-mid); padding: 8px 12px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--panel-bg); } .ctable td { padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--text-bright); vertical-align: top; } .ctable tr.collision td:first-child { box-shadow: inset 3px 0 0 var(--amber); }` plus the scroll container `.ctable-wrap { flex: 1; overflow: auto; }`.

- [ ] **Step 7: Verify** — tsc, tests, dev app: each tab shows this project's rows only (compare one row against `sqlite3 -readonly ~/.continuity/continuity.db`); clicking an avatar focuses the node on the Graph tab; a new decision written by an agent appears within ~1 s.

- [ ] **Step 8: Commit** — `git commit -m "feat(continuity): service tables for decisions, handoffs, tasks, files and activity"`

---

### Task 16: Release 0.42.0

- [ ] **Step 1:** Bump the three version files to `0.42.0`, `cargo build` for `Cargo.lock`, sanity grep.
- [ ] **Step 2:** Prepend:

```markdown
## 0.42.0 — 2026-10-12

- **Added — Continuity tables.** The Continuity view gains tabs for Decisions, Handoffs, Tasks, Files and Activity — everything your sessions record in Continuity, for this project only. Files highlights a path two sessions are editing at once. Click any session's avatar to jump to it on the map.
```

- [ ] **Step 3:** Extend CLAUDE.md's "Where the Continuity view lives" with one bullet: tables read through `continuity_tables.rs`, scoped by the same `resolve_session_ids`, and refetch on `continuity-changed`.
- [ ] **Step 4:** Full gates (Task 13 Step 3 commands). **Step 5:** `git commit -m "chore(release): 0.42.0"`.

---

## Self-review notes (plan author)

- Spec coverage: §4 → Task 7; §5.1 → Task 1; §5.2 → Task 3; §5.3 → Tasks 2, 4; §5.4 → Tasks 8, 11; §6.1 → Task 5 (with the recorded payload deviation); §6.2 → Task 6; §6.3 → Task 11; §7 → Tasks 9–12; §8 → Tasks 14–15; §9 → Tasks 4–6, 11; §10 → per-task tests + Task 11 Step 8; release/docs → Tasks 13, 16.
- Known adaptations inside the plan, called out where they occur: Task 3's adaptation to `install_profile_at`'s real signature, Task 11's `--hq-grid-line` scope check.
