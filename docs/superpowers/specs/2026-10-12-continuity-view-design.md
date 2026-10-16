# Continuity view — design

Date: 2026-10-12 · Status: approved in brainstorming, pending spec review
Increments: **0.41.0** (graph + question cards + view gating) → **0.42.0** (service tables)

## 1. Intent

Conduit sessions coordinate through Continuity (messages, decisions, handoffs, task
claims, file activity). Today that traffic is invisible unless you read a session's
terminal or open the read-only Decisions/Messages panels. The user wants to **watch the
fleet talk**: a per-project graph of sessions drawn as little animal avatars, a pulse
along an edge each time one session messages another, and — the one interactive part —
Claude Code's `AskUserQuestion` prompts surfacing as a card beside the asking avatar,
answerable right there.

What the user said, verbatim intent:
- ReactNode-like UI, one avatar per session, avatars linked; a pulse per Continuity message.
- A session's question shows up for recommendation/answer next to the avatar, momentarily.
- A decisions table, and a table/UI for every Continuity service.
- "Little agents with avatars (without the chat)"; clicking an avatar shows that chat.
- **The human never interacts with Continuity.** Continuity is observed, never written.
- Canvas and Board are hidden by default and enabled from Settings.

Success: at a glance you can tell who is talking to whom, who is blocked on you, and what
got decided — without opening terminals — and you can answer a blocked agent from the graph.

## 2. Decisions taken (brainstorming record)

| # | Question | Decision |
|---|---|---|
| D1 | How do answers reach agents? | Questions are Claude Code `AskUserQuestion`, not Continuity messages. Conduit never writes the Continuity DB. |
| D2 | Card interaction | Show first; answer from the card (spike proved it — §5.1). |
| D3 | Graph scope | **Per project.** Sessions from other projects that message in/out appear as dimmed **visitors**. |
| D4 | Node membership | In-scope Continuity sessions that are `active`/`idle` **plus** every Conduit session of the project (stopped ones dimmed, for a stable layout). Visitors stay for 10 min after their last message. |
| D5 | Layout | Force layout; edges exist only between sessions that have messaged; thickness = volume; a dragged node is pinned. |
| D6 | Visual | Conduit palette, gridded surface, cartoon animal per session in a rounded square, status on the border (mockup `graph-conduit-v2.html`, approved "Love it!"). |
| D7 | Card hand-off | Card holds the question until the user opens that session's terminal or **600 s** pass, whichever first; then the TUI menu appears. Card only captures while the view is open or a Conduit window is focused. |
| D8 | Avatar click | A **drawer** inside the view: read-only `SessionChat` for Claude sessions, stub for others, Continuity summary for visitors, "Open session ↗". |
| D9 | Liveness transport | **Rust watcher**: `PRAGMA data_version` poll + cursors → event. No new deps. |
| D10 | Scope split | 0.41.0 graph/cards/gating; 0.42.0 tables. Both MINOR. |

## 3. Out of scope

Any write to Continuity · a cross-project/global graph · question cards for non-Claude
agents (only Claude has `AskUserQuestion`) · answering from the phone (the registry makes
it possible later) · chat composition from the drawer · persisting avatar choices.

## 4. Settings gating (0.41.0)

Three booleans in **Settings → General**, each the established localStorage pref shape
(`readX()`/`writeX()` try/catch pair in `store.ts`, `SettingRow` in `GeneralSettings.tsx`):

| Pref | Key | Default |
|---|---|---|
| `canvasEnabled` | `conduit.canvasEnabled` | off (`=== "1"`) |
| `boardEnabled` | `conduit.boardEnabled` | off (`=== "1"`) |
| `continuityViewEnabled` | `conduit.continuityViewEnabled` | on (`!== "0"`) |

Disabled means **every entry point is gone** and an open view closes:
- Canvas: `CanvasToggleButton` (`WorkspaceCenter.tsx`), ⇧⌘C (`App.tsx`), palette `view-canvas`.
- Board: Board button in `GroupTabStrip`, ⇧⌘B and the native menu `toggle-board` (`App.tsx`),
  palette `view-board`.
- Continuity: its header button, its shortcut (⇧⌘K — verify free during planning), palette entry.

`setCanvasOpen` refuses `true` while `canvasEnabled` is false (the same guard shape as its
existing non-main-window refusal), and `setCenterMode` refuses a disabled mode. Turning a
pref off while its view is open closes it. **No data is deleted**: `conduit.canvas` and
`.conduit/board/` are untouched, so re-enabling restores everything.

Targeted fix while here: the board/canvas exclusion is ad hoc today (the palette and menu
board paths do not close the canvas; opening the canvas does not reset `centerMode`). The
new view makes it three-way, so exclusion moves into the store: `setCenterMode` to a
non-`terminals` mode closes the canvas, and `setCanvasOpen(true)` resets the selected
project's `centerMode` to `terminals`. The render gates stay as a second line.

CHANGELOG 0.41.0 carries a **Changed** bullet telling existing users where Canvas and Board went.

## 5. Question cards

### 5.1 Protocol (empirically pinned, claude 2.1.293)

Spike, interactive TUI under tmux (memory `conduit-askuserquestion-hook-answer`):
- A `PreToolUse` hook matching `AskUserQuestion` that returns
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{…tool_input,"answers":{"<question text>":"<answer>"}}}}`
  answers it: the menu never renders; the transcript records "User answered Claude's questions".
- Free text is accepted (need not match an option label).
- A blocking hook works; the TUI shows `running PreToolUse hook · Ns`. With `"timeout": 660`
  on the hook entry, a **75 s** block was honoured (default hook timeout is 60 s — `hooks.rs:598`).
- An **empty** response hands the question back: the normal TUI menu appears.
- Payload: `session_id`, `tool_use_id`, `tool_input.questions[]` (`question`, `header`,
  `options[{label,description}]`, `multiSelect`).
- `claude -p` does not expose the tool — root chats and `-p` titlers are unaffected.

Pinned (Task 1 probe, `claude --version` = 2.1.293 (Claude Code)): both previously open shapes
work. One AskUserQuestion call with two questions (a `multiSelect` one and a single-select one),
answered by a PreToolUse hook returning `answers` = `{"Pick fruits": "Apple, Banana", "Pick a color": "Red"}`
(multiSelect labels joined with `, `, one key per question text), showed no menu and rendered:

```
User answered Claude's questions:
  · Pick fruits → Apple, Banana
  · Pick a color → Red
Q1=Apple, Banana Q2=Red
```

Constants: `MULTISELECT_ANSWERS_SUPPORTED = true`, `MULTISELECT_JOIN = ", "`,
`MULTI_QUESTION_SUPPORTED = true` (`src/askProtocol.ts`).

### 5.2 Hook install

A new Claude row in `hooks::claude_profile()`: event `PreToolUse`, **matcher
`AskUserQuestion`**, verb route **`/ask`**, entry-level `"timeout": 660`, and curl
`-m 650` (POSIX) / the same on the Windows arm. Every other row keeps `-m 2` and no
`timeout`. The existing unmatched `pretool` row still fires for `AskUserQuestion` too —
harmless, it only feeds activity.

Ordering of ceilings, which must hold and is pinned by a test:
`ASK_CEILING (600 s) < curl -m (650 s) < hook timeout (660 s)`. Conduit always answers
(even if only `{}`) before curl or Claude gives up, so a card can never "answer into the void".

### 5.3 `asks.rs` (new; not `broker.rs`)

`broker.rs` decides allow/deny and is dormant and approval-shaped; an ask carries answers
and a hand-off. Same lesson as `proposals.rs` vs `broker.rs` — separate registries, merged
only in the UI if ever.

```rust
pub enum AskOutcome { Answered(serde_json::Map<String, Value>), HandOff }
pub struct Asks { … }               // Mutex<HashMap<String, Pending>> + AtomicU64 ids "ask-N"
impl Asks {
  pub fn register(&self, session: String, tool_use_id: String, input: Value) -> (String, Receiver<AskOutcome>);
  pub fn resolve(&self, id: &str, outcome: AskOutcome) -> bool;   // first responder wins
  pub fn forget(&self, id: &str);
  pub fn pending(&self) -> Vec<AskView>;                          // catch-up for a reload/new window
}
pub struct AskGate(AtomicBool);     // set by the frontend; closed = never intercept
pub fn ask_response(input: &Value, outcome: Option<&AskOutcome>) -> Value; // pure
```

`handle_ask` in `hooks.rs` (dispatched beside `/approve`, on its own thread):
1. Parse session + body. If the gate is closed, the session is unknown, or the questions
   shape is unsupported (§5.1) → respond `{}` immediately (fail-open, same as `/approve`).
2. `register`, emit **`ask-request`** `{ id, session, toolUseId, questions }`.
3. `recv_timeout(ASK_CEILING)`. Answered → `allow` + `updatedInput` (original `tool_input`
   with `answers` merged). HandOff or timeout → `{}`.
4. Always `forget` and emit **`ask-resolved`** `{ id, how: "answered"|"handoff"|"timeout" }`.

Trust model: `/ask` is display-trust like `/hook`, not authenticated like `/open`. It never
acts on Conduit's state — the user's answer is returned only on the HTTP response to the
very request that asked — so a forged local POST can at most show a card whose answer goes
back to the forger. It still refuses any request carrying `Origin` (checked first, as `/open`
does), so a browser page cannot raise cards.

Tauri commands: `ask_answer(id, answers)`, `ask_handoff(id)`, `ask_pending()`,
`set_ask_gate(open)`. `ask_answer` validates that every key is one of the registered
questions' texts and every value is a non-empty string ≤ 4 KB; anything else is refused.

### 5.4 Frontend rules

- **Gate** (`set_ask_gate`): open iff `continuityViewEnabled` AND (the Continuity view is
  open in some window OR any Conduit window has focus). A new `windowFocused` store flag is
  maintained from `focus`/`blur` in `App.tsx`. Closed gate → the hook returns at once and
  nothing changes for the user versus today.
- **Hand-off** (pure `askShouldHandOff(ask, view)` in `src/asks.ts`, tested): hand off when
  `globalSelectedSessionId === ask.session` and the Continuity view is not the visible
  surface — i.e. the user is looking at that terminal, where the menu is about to be useful.
  Also on the card's "Answer in terminal ↗".
- **Where it shows:** beside the avatar in the graph; when the view is closed, a compact
  toast-style card anchored bottom-right in the main window (one at a time, queue count),
  so an intercepted question is never invisible. `ask_pending()` on mount repopulates.
- A handed-off/timeout card leaves a 6 s "answer in terminal" ghost, then disappears.

## 6. Data layer

### 6.1 `continuity_watch.rs` (new)

One app-wide thread (started in `lib.rs` setup) with a read-only connection to
`continuity_read::db_path()`:
- Every 500 ms read `PRAGMA data_version`. Unchanged → sleep. (SQLite bumps it only on a
  commit by **another** connection, i.e. Continuity.)
- Changed → read `messages` newer than a single `(created_at, id)` cursor (ISO-8601 `…Z`
  strings order as text; `id` breaks ties). Only `messages` has a cursor: only a NEW message
  becomes a pulse, and a cursor on update-heavy tables (`agent_sessions.last_seen_at`, a
  handoff's status) cannot be one monotonic column.
- Emit **`continuity-changed`** `{ messages: [{id, from, to, kind, createdAt}] }` on EVERY
  observed commit, possibly with zero messages — consumers refetch on it. (Deliberately no
  per-table list; the message rows are tiny, ~170/h across all projects.)
- Missing DB / schema drift / open failure → back off to a 10 s retry, emit nothing; the view
  shows its existing "Continuity unavailable" state. Never panics, never writes.
- On first start, cursors initialise to "now" (no pulse storm for history).

### 6.2 `continuity_graph(project_id)` (new command, in `continuity_feed.rs`)

Reuses the existing scope (`resolve_session_ids`: `agent_label IN` project session ids, OR
`cwd_hash IN` sha256(toplevel)[..16]; toplevels gathered in Rust exactly as `continuity_feed`
does at `lib.rs:1552`). Returns:

```ts
type GraphSnapshot = {
  available: boolean;
  nodes: GraphNode[];   // {key, conduitSessionId?, continuityId?, label, agent?, status, focus?, lastSeenAt, visitor, visitorProjectId?}
  edges: GraphEdge[];   // {a, b, count, lastAt}  undirected, keyed min/max
  unread: Record<string, number>; // pending inbound per node
};
```

Membership (D4), decided in Rust and unit-tested on a temp DB:
- In-scope Continuity sessions with `status IN ('active','idle')`.
- Every Conduit session of the project, with or without a Continuity row (status from the
  store on the frontend; `stopped` dims it).
- Visitors: out-of-scope sessions that sent to or received from an in-scope session in the
  last 10 min. A visitor whose `agent_label` is another project's Conduit session carries that
  `visitorProjectId` (for its colour chip and click-through).
- Edges: message pairs among shown nodes over the last 24 h; `count` drives thickness, `lastAt`
  drives fade (idle > 10 min → faint).

Node key = `conduitSessionId ?? continuityId`, so a Conduit session keeps one identity before
and after it registers with Continuity.

### 6.3 Frontend wiring

`src/hooks/useContinuityGraph.ts`: fetch the snapshot on open; on `continuity-changed`, turn
each message whose endpoints are both on screen into a pulse **immediately**, then refetch the
snapshot debounced 750 ms when any table changed. Only polls while the view is open; the
watcher thread is the only thing running when it is closed.

## 7. UI

All DOM + SVG — no terminals, so the canvas hazards (stacking vs `.term-stack`, font-zoom
ladder, keep-alive) do not apply.

- **Mount:** `CenterMode` gains `"continuity"`; the view renders as an overlay exactly like
  `board-overlay` (`WorkspaceCenter.tsx:616`), gated `centerMode === "continuity" && !canvasMode`.
  Terminals stay mounted beneath.
- **`ContinuityView.tsx`**: tab strip (Graph now; tables in 0.42.0), project chip, the graph.
- **`ContinuityGraph.tsx`**: SVG edge layer + absolutely positioned avatar nodes; pan by drag
  on empty space, wheel zoom via `transform: scale()` on the layer (DOM/SVG stays crisp).
  Pulses are SVG `animateMotion` circles keyed by message id, removed on `endEvent`; reversed
  with `keyPoints="1;0"` when the message travels b→a. Reduced motion: no pulse, edge flash only.
- **`graphLayout.ts`** (pure, tested): deterministic force layout seeded from node keys
  (repulsion + edge springs + centering, fixed iteration count, pinned nodes immovable); new
  nodes enter near their first neighbour. Pins in localStorage `conduit.continuityPins`
  (`{[projectId]: {[nodeKey]: {x,y}}}`), read defensively like `readCanvas`.
- **Avatars:** `src/avatars.tsx` — 12 hand-drawn animal SVGs in their source viewBox (same rule
  as `AGENT_MARKS`); `sessionAnimal(key)` = FNV-1a (reuse `projectHue`'s hash) mod 12. Never
  stored. Rounded-square container, border by status: running green, needs-you amber with the
  1.6 s breathe (compositor-only, dropped under reduced motion), idle plain, stopped dimmed,
  visitor dashed + smaller + project-colour chip via `resolveProjectColor`. Unread badge in accent.
  Status text under the name, so meaning never rests on hue alone. Contrast of the art against
  `--selection-bg` checked in light theme too.
- **Question card** (`AskCard.tsx`): header "<name> asks · <header>", question, one button per
  option (description as subtitle), free-text input, "Answer in terminal ↗". Multi-question
  calls page through with a dot indicator and submit once.
- **Drawer** (`SessionDrawer.tsx`): right side, 420 px, over the graph. Claude session →
  `SessionChat` with a new `readOnly` prop (no composer, no `pty_write`); other agents → stub
  ("This agent has no transcript view") + "Open session ↗"; visitor → Continuity summary
  (focus, last seen, recent messages with this project, claimed tasks). Esc closes.
- Light theme: every colour via theme tokens (`--panel-bg`, `--accent`, `--amber`, `--green`,
  `--hq-grid-line`), none hard-coded except the animal art.

## 8. Service tables (0.42.0)

Tabs in `ContinuityView`, all read-only, all scoped by the same `resolve_session_ids`, each a
new read in `continuity_feed.rs` returning `available:false` on drift:

| Tab | Rows | Notes |
|---|---|---|
| Decisions | key, type, status, author avatar, created, supersede chain | Supersedes the right-column Decisions panel's data source; the panel stays. |
| Handoffs | from → to avatars, status, context excerpt, next actions | |
| Tasks | repo#issue, status, claimant avatar, PR, expires | |
| Files | path, avatar(s), tool, touched | last 30 min; a path touched by ≥ 2 sessions is highlighted as a collision |
| Activity | audit_events timeline | type filter chips |

Clicking an author avatar in any table switches to Graph and focuses that node. The
watcher's `tables` list drives a refetch of only the visible tab.

## 9. Error handling

- No/unsupported Continuity → view shows the existing unavailable empty state; question cards
  still work (they do not depend on Continuity).
- Ask route: every failure path answers `{}` — fail-open, never deny, never hang past the ceiling.
- `ask_answer` on an already-resolved id → `false`, card shows "Already answered".
- Snapshot read error → keep the last good snapshot, show a subtle stale marker.

## 10. Testing

Rust (`cargo test`, both CI legs):
- `asks.rs`: register/resolve first-wins, forget, pending, timeout → None; `ask_response`
  shapes (answered merges `answers` into the original input; handoff/None → `{}`).
- Ceiling ordering test (§5.2) and a hook-row test: the `AskUserQuestion` row has matcher,
  `timeout: 660`, `-m 650`; no other row grew a `timeout`.
- `ask_answer` validation (unknown key, empty, oversize refused).
- Watcher: cursor query against a temp DB (`temp_db_path` helper) returns only newer rows,
  tie-break by id, initial cursor = now; drift → no emit.
- `continuity_graph` membership: active/idle in, gone out, visitor window, edge 24 h window,
  Conduit session without a Continuity row present.

TypeScript (`vitest`, colocated):
- `askShouldHandOff`, `sessionAnimal` stability/spread, `graphLayout` determinism + pins,
  pulse filter (both endpoints on screen, direction), pref readers' defaults, the three-way
  exclusion in the store-free helpers.

Manual (CLAUDE.md: never claim UI works from a typecheck): dev app under
`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`, two Claude sessions messaging via Continuity →
pulses; one calls `AskUserQuestion` → card → answer lands in the agent; open its terminal →
hand-off menu appears; toggles in Settings hide/restore Canvas and Board.

## 11. Files

New: `src-tauri/src/asks.rs`, `src-tauri/src/continuity_watch.rs`, `src/asks.ts`,
`src/avatars.tsx`, `src/graphLayout.ts`, `src/hooks/useContinuityGraph.ts`,
`src/components/{ContinuityView,ContinuityGraph,AskCard,SessionDrawer}.tsx` (+ tests).
Changed: `hooks.rs` (row, `/ask` dispatch, `handle_ask`), `continuity_feed.rs`
(`continuity_graph`), `lib.rs` (commands, managed state, watcher start), `store.ts`
(prefs, `CenterMode`, exclusion, `windowFocused`, asks state), `App.tsx` (listeners, shortcut
gating, focus), `WorkspaceCenter.tsx`, `CommandPalette.tsx`, `GeneralSettings.tsx`,
`SessionChat.tsx` (`readOnly`), `theme.css`, `CLAUDE.md` (a "Where the Continuity view lives"
section), version files + `CHANGELOG.md`.
