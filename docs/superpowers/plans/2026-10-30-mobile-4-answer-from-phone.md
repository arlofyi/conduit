# Mobile 4 — Answer questions and permission prompts from the phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Claude session asks a question (`AskUserQuestion`) or needs a tool permission, a paired phone sees it within a second, can answer it with a tap, and every surface (phone, desktop card, terminal) collapses it once anyone answers — first answer wins.

**Architecture:** Questions reuse the existing blocking `/ask` hook (`asks.rs`): the hold gate becomes "desktop gate open OR an authenticated remote phone is connected", resolutions carry who answered (`by`), and asks whose turn ended are cancelled. Permissions use Claude Code's `PermissionRequest` hook event (fires only when a permission dialog would be shown) on a new blocking `/permission` route backed by the existing `broker.rs` — IF Task 1's spike confirms it works in the interactive TUI. The bridge pushes `pending` / `pendingAdded` / `resolved` frames to every authenticated phone by diffing the pending lists each tick, and accepts `answer` / `approve`. The phone turns transcript question cards and a new permission card live.

**Tech Stack:** Rust (tiny_http hook server, tungstenite bridge), React 19 + TS (vitest), React Native / Expo SDK 56 (jest).

**Spec:** `docs/superpowers/specs/2026-10-29-mobile-over-tailscale-design.md` §6, §7. Builds on plans 1–3. CLAUDE.md "Where the Continuity view lives" (the `/ask` protocol and its three ceilings) and "Where the mobile bridge lives".

## Global Constraints

- **Question hook protocol is unchanged** (pinned against claude 2.1.293; installed 2.1.312): answered → `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":…,"updatedInput":{…tool_input,"answers":{"<question>":"<answer>"}}}}`; hand-off/timeout → `{}`. Answers: exact question texts as keys, non-empty strings ≤ 4096 bytes, multi-select joined with `", "`. Ceilings `ASK_CEILING` 600 s < curl 650 < hook timeout 660 stay.
- **Gate:** hold an ask when `desktop_gate_open || bridge.has_remote_phone()`; `has_remote_phone` = the controller's `live` map is non-empty (authenticated non-loopback phones only). A siloed / local-only session's ask is held ONLY by the desktop gate, never because a phone is connected.
- **Silo:** the phone never receives question text/options or permission input for `silo || local_only` sessions, and the bridge refuses `answer`/`approve` for them (`{"type":"answerResult","askId",…,"ok":false}`); they appear in `pending` as `{id, sessionId, kind, private: true}` only.
- **Attribution:** every resolution carries `by ∈ {"phone","desktop","terminal","timeout","cancelled"}`. Tauri events `ask-resolved` / `permission-resolved` gain `by`; the bridge frame is `{"type":"resolved","id","by"}`.
- **Cancellation:** when a session emits `stop`, `prompt`, `sessionend` or a `tooluse` hook (its turn moved on), every pending ask/permission of THAT session resolves `cancelled` (the blocked hook replies `{}`) so no surface keeps a dead card.
- **Bridge frames (new, additive; `PROTOCOL_VERSION` stays 1 — old phones ignore unknown frames):** server → phone `pending {asks: [AskPush], permissions: [PermissionPush]}` right after auth (and on loopback connect), `pendingAdded {item: AskPush | PermissionPush}`, `resolved {id, by}`, `answerResult {askId, ok}`, `approveResult {id, ok}`; phone → server `answer {askId, answers: {[question]: string}}`, `approve {id, allow: bool}`. `AskPush = {kind:"ask", id, sessionId, toolUseId, questions, createdMs}`; `PermissionPush = {kind:"permission", id, sessionId, toolName, summary, createdMs}` where `summary` is a one-line description of the tool input (Bash → the command; Edit/Write/Read → the file path; other → tool name), ≤ 200 chars. Private items omit `questions`/`toolName`/`summary`. All camelCase, pinned by Rust AND phone tests.
- **Push cadence:** each authenticated connection diffs `Asks::pending()` + `Broker::pending()` at most every 250 ms (not every 20 ms tick).
- **Permission hook (only if Task 1 confirms):** event `PermissionRequest`, blocking route `/permission`, same Origin refusal and `session=unknown` skip as `/ask`, ceilings `PERMISSION_CEILING` 300 s < curl 330 < hook timeout 340, gate as questions; reply allow → `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`, deny → `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Conduit"}}}`, hand-off/timeout/cancel → `{}` (Claude shows its own dialog). Exact shapes are whatever Task 1 measures — Task 1's findings override this line.
- **Windows:** any new hook row needs the relay-script treatment (`conduit-ask.cmd` pattern, never `%VAR%`/redirects in the hook command string); `windows_hook_commands_are_shell_neutral` must keep passing; Windows CI leg compiles everything.
- No new crates. `#[tauri::command(async)]` for anything that blocks. Conventional Commits; NO `Co-Authored-By`/AI trailer. CHANGELOG under `## Unreleased`. Never touch the installed Conduit or its data dir; any live test uses `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev` and a NON-git project directory.

## Review Focus

1. A question answered on the desktop card while the phone shows it: the phone card must collapse ("Answered on your Mac") within a second, and a late phone tap must get "already answered", never a second answer. → Task 2 test `second_answer_loses` + Task 5 test.
2. The user presses Esc in the terminal while a question is held: the card must disappear everywhere (cancelled), not linger 10 minutes. → Task 2 test `turn_end_cancels_pending`.
3. The only phone disconnects while it is the reason an ask is held and no desktop window is focused: the ask must hand off to the terminal promptly (not wait 600 s). → Task 2 test `last_phone_leaving_hands_off`.
4. A siloed session asks a question with only the phone connected: it is not held, and nothing about it reaches the phone. → Task 2 test `silo_ask_not_held_for_phone`.
5. Two phones paired: both see the card; one answers; the other collapses. → Task 2 bridge diff test (two subscribers).

---

### Task 1: Spike — does `PermissionRequest` work in the interactive TUI?

**Files:** Create `docs/superpowers/specs/2026-10-30-permission-request-hook-findings.md` (committed). Scratch work only under the session scratchpad.

- [ ] **Step 1:** In a fresh NON-git temp directory under the scratchpad, write `.claude/settings.local.json` with a `PermissionRequest` hook whose command posts the hook stdin to a tiny local HTTP listener you run (Python `http.server` subclass or `nc`), which records the body and replies after a delay with a chosen JSON. Run `claude` interactively inside `tmux` (its own `tmux -L spike` socket), ask it to run a harmless Bash command that needs permission (e.g. `touch spike.txt`), and observe.
- [ ] **Step 2:** Record: the exact stdin JSON (fields: `session_id`, `tool_name`, `tool_input`, `tool_use_id`?, `permission_suggestions`?); whether the TUI dialog shows WHILE the hook is pending or only after it replies `{}`; whether allow/deny shapes work (tool runs / is refused, message shown); whether the hook `timeout` field is honoured beyond 60 s; what happens if the user answers in the TUI while the hook is pending (hook killed? both?); whether a `Notification` `permission_prompt` still fires. Kill the spike tmux server and remove the temp dir.
- [ ] **Step 3:** Write the findings doc (measured facts, the exact working allow/deny/fallthrough JSON, a GO / NO-GO verdict for Task 3, and any changes to the Global Constraints' permission line).
- [ ] **Step 4: Commit** `spike(mobile): measure Claude's PermissionRequest hook`

### Task 2: Questions — gate, attribution, cancellation, bridge push and answer

**Files:** `src-tauri/src/asks.rs`, `hooks.rs`, `bridge.rs` (+ `bridge_view.rs` for the pure push builders), `lib.rs`; tests beside them.

**Interfaces:**
- `asks.rs`: `AskOutcome::Answered{answers, by: By}`; `pub enum By { Phone, Desktop, Terminal, Timeout, Cancelled }` (serde lowercase); `Asks::resolve(id, outcome) -> bool` unchanged contract; `Asks::cancel_session(session) -> Vec<String>` (resolves that session's pending asks `Cancelled`); `Asks::hand_off_where(pred) -> Vec<String>`.
- `hooks.rs`: `handle_ask` gate = `gate.is_open() || (phone_connected && !silo)`; `ask-resolved` payload `{id, how, by}`; the generic hook handler calls `asks.cancel_session(session)` on `stop`/`prompt`/`sessionend`/`tooluse`.
- `BridgeController::has_remote_phone() -> bool`; when the last remote phone deregisters and the desktop gate is closed, hand off every ask that is held only because of the phone (non-silo asks created while no desktop gate was open — track `held_for_phone: bool` on the entry).
- Bridge: pure `fn diff_pending(prev: &HashSet<String>, now: &[PushItem]) -> (Vec<PushItem> /*added*/, Vec<String> /*gone*/)`; `fn ask_push(view: &AskView, private: bool) -> Value`; connection sends `pending` after auth, then every ≥ 250 ms sends `pendingAdded`/`resolved` (`by` read from a small `Asks::recent_resolutions()` ring buffer of the last 64 `(id, by)` so a `resolved` can name who answered; unknown → `"cancelled"`); `answer` → `Asks::get` + `validate_answers` + silo check + `resolve(Answered{by: Phone})` → `answerResult{askId, ok}`.
- Tauri `ask_answer` passes `By::Desktop`; `ask_handoff` → `Terminal`; timeout → `Timeout`.

- [ ] **Step 1: Failing tests:** `second_answer_loses`, `answer_by_is_recorded`, `turn_end_cancels_pending`, `last_phone_leaving_hands_off` (pure controller-level), `silo_ask_not_held_for_phone`, `diff_pending_added_and_gone`, `ask_push_shape_and_private_shape`, `answer_msg_parses_camel_case`, `answer_refused_for_silo`.
- [ ] **Step 2–4:** fail → implement → `cargo test`/`fmt --check`/`clippy --all-targets -D warnings` pass.
- [ ] **Step 5: Commit** `feat(mobile): phones see and answer Claude's questions; first answer wins`

### Task 3: Permissions (only if Task 1 is GO)

**Files:** `src-tauri/src/broker.rs`, `hooks.rs` (new `PermissionRequest` hook row, `permission_command`, Windows relay script, `/permission` route replacing the dormant `/approve`), `bridge.rs`/`bridge_view.rs`, `lib.rs` (commands `permission_pending`, `permission_respond(id, allow) -> bool`; events `permission-request`, `permission-resolved {id, by}`).

**Interfaces:** `Broker::register(session, tool, input) -> (id, rx)`, `Broker::resolve(id, decision, by) -> bool`, `Broker::pending() -> Vec<PermissionView{id, session, toolName, summary, createdMs}>`, `Broker::cancel_session(session)`; `fn permission_summary(tool, input) -> String`; `fn permission_response(outcome) -> Value` per Task 1's measured shapes; ceilings as Global Constraints with a compile-time ordering assert; the same gate, silo, cancellation and `by` rules as questions; bridge `approve` → `approveResult{id, ok}`. Remove the dead `/approve` route, `Presence`, and their tests if nothing else uses them.

If Task 1 is NO-GO: skip this task; the phone shows a permission `needs` row as read-only "Needs a permission — answer it on your Mac"; record the ruling.

- [ ] **Step 1: Failing tests:** `permission_response_shapes`, `ceilings_ordered`, `summary_for_bash_edit_other`, `permission_first_answer_wins`, `permission_cancelled_on_turn_end`, `windows_hook_commands_are_shell_neutral` (existing, must include the new row), `approve_refused_for_silo`.
- [ ] **Step 2–4:** fail → implement → Rust checks pass.
- [ ] **Step 5: Commit** `feat(mobile): approve or deny tool permissions from the phone or the Mac`

### Task 4: Desktop UI

**Files:** `src/components/AskCard.tsx` (+ store), `src/components/PermissionCard.tsx` + mount next to `AskDock` in `App.tsx` (only if Task 3 shipped), `src/askProtocol.ts`/a new pure `src/permissionView.ts` (+ tests).

- `ask-resolved` with `by:"phone"` shows "Answered on your phone" (not "Sent to …") before the card leaves; `by:"cancelled"` removes the card silently.
- PermissionCard: tool name, summary (monospace), Deny / Allow buttons, "Answered on your phone" on remote resolution; listeners before a `permission_pending` catch-up; idempotent removal; never inside the terminal tree; no native controls.

- [ ] **Step 1:** pure helpers tested (`resolvedCopy(by)`); implement; `pnpm test && pnpm exec tsc --noEmit && pnpm build`.
- [ ] **Step 2: Commit** `feat(mobile): desktop cards say when the phone answered`

### Task 5: Phone — live question and permission cards

**Files:** `mobile/src/bridge/protocol.ts` (+test), `LiveProvider.tsx`, `mobile/src/logic/pending.ts` (+test), `ChatScreen.tsx` (QuestionCard live via `toolUseId` join, ApprovalCard live), `banner.ts` (instant banner from `pendingAdded`), `chatList.ts` (needs preview from pending).

- Pending state per Mac from `pending`/`pendingAdded`/`resolved`; a transcript `question` item whose `toolUseId` matches a pending ask becomes interactive: numbered options, "(Recommended)" tag, multi-select checkboxes + "Send N", "Something else…" free text; sending → `answer`, card shows "Sending…", then "Answered" on `answerResult ok` + `resolved`, or "Already answered on your Mac" when `ok:false`/`resolved by≠phone`. A pending ask with no transcript card yet renders as a card at the end of the feed.
- Permission card (if Task 3): tool + summary + Deny/Allow → `approve`; same result states.
- Banners fire immediately on `pendingAdded` (still respecting toggles, open chat, silo copy); the 10 s poll stays for the list.
- Private items: never interactive; "Private session — answer it on your Mac".

- [ ] **Step 1: Failing tests:** wire shapes (`answer`, `approve`, `pending`, `pendingAdded`, `resolved`, `answerResult`), `pending_reducer_add_resolve`, `question_card_live_by_tool_use_id`, `multiselect_joins_with_comma_space`, `late_tap_shows_already_answered`, `private_item_not_interactive`.
- [ ] **Step 2–4:** fail → implement → `cd mobile && npm test && npm run typecheck`.
- [ ] **Step 5: Commit** `feat(mobile): answer questions and permissions from the phone`

### Task 6: End-to-end in the Simulator, docs

Same safety rules as plan 3 Task 7 (isolated `ConduitTauri-dev`, NON-git project, Simulator only via the computer-use skill, pick the dev build's port, never the installed Conduit, stop only processes you started).

- [ ] **Step 1:** Rebuild the Simulator app; start the dev desktop; from the phone, open the session and send: "Use the AskUserQuestion tool to ask me which colour I prefer, with options Red, Green, Blue." Answer on the phone → verify Claude receives it (reply mentions the colour) and the dev desktop's card (if visible in logs/events) collapses. Screenshots.
- [ ] **Step 2 (if Task 3 shipped):** in the same session, set Claude to default permission mode and ask it to `touch e2e-permission.txt`; approve from the phone; verify the file exists. Then once more and Deny; verify it does not run. Screenshots.
- [ ] **Step 3:** Docs: CHANGELOG under `## Unreleased`:

```
- **Added — Answer Claude from your phone.** When a session asks a question or needs permission to run a tool, your phone shows it straight away; tap an answer and every other screen clears it. Private sessions still only ask on your Mac.
```

(drop "or needs permission to run a tool" if Task 3 was skipped); CLAUDE.md: extend "Where the mobile bridge lives" with the gate/silo/`by`/cancellation rules and the `PermissionRequest` facts (or the NO-GO note); `mobile/README.md` features.
- [ ] **Step 4:** Teardown (stop what you started; restore dev state backup); commit `docs(mobile): answering from the phone`.
