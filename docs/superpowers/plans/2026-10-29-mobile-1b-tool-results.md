# Mobile 1b — Tool results, failures and edit diffs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tool call that failed or edited a file is always visible on its own line (failure with its first error line, edit with `+N −M` and a short diff); only finished, successful, non-edit calls fold into the summary line.

**Architecture:** The Rust parser pairs nothing — it emits each `tool_use` as an `event` carrying its `toolUseId`, and each `tool_result` as a new `result` item (`toolUseId`, `isError`, `errorText`, `diff`). Each renderer pairs them by id in its existing pure grouping function (`src/chatItems.ts` `groupTools`, `mobile/src/logic/feed.ts` `groupFeed`) and folds only "quiet" calls, the rule borrowed from `~/ooozzy/experiments/conduit-code/src/tui/groups.ts`.

**Tech Stack:** Rust (serde_json), React 19 + TS (vitest), React Native / Expo SDK 56 (jest).

**Spec:** `docs/superpowers/specs/2026-10-29-mobile-over-tailscale-design.md` §5 (one shared message model). Builds on plan 1 (`2026-10-29-mobile-1-chat-message-model.md`).

## Global Constraints

- One classifier: only `transcript.rs` / `transcript_user.rs` read raw transcript lines; renderers pair and fold typed items only.
- Desktop and phone fold with the SAME rule: a call is **quiet** when it has a result, `isError` is false, and it has no `diff`. A run of ≥ 2 consecutive quiet calls folds into one summary row; everything else (no result yet, failed, edit with diff, a lone quiet call) renders on its own line.
- Summary label: buckets in descending count, joined with `, `, first letter capitalised: Bash → `ran N shell command(s)`, Read → `read N file(s)`, Grep/Glob (event `search`) → `searched N time(s)`, web → `browsed N page(s)`, subagent → `ran N subagent(s)`, everything else → `called N tool(s)`. Singular when N = 1 (`ran 1 shell command`).
- Status glyphs: no result → `◐` (running), ok → `●`, error → `✕`; colours ink-3 / green / red tokens.
- Diff cap: 16 rendered lines, then `… N more lines`; new file shows `created · +N lines` with no body.
- `errorText` is the first non-empty line of the result content, cut to 200 chars.
- A `result` with no matching `event` in the list (its call fell off the tail) is dropped silently; a `result` is never rendered on its own. Real transcripts interleave them (`event A, result A, event B, result B`), so `result` and `usage` items never break a run of calls.
- `transcript_item_kinds.json` gains `"result"` (15 kinds); all three manifest tests must stay green.
- `VIEW_LIMIT` in `transcript.rs` rises from 400 to 800, because results roughly double the item count while rendering nothing themselves.
- No TodoWrite/to-do panel in this plan: 0 TodoWrite/TaskCreate calls in the founder's last 60 transcripts (Ruling recorded in the ledger).
- Conventional Commits; NO `Co-Authored-By` / AI trailer. CHANGELOG under `## Unreleased`. Do not launch the desktop dev app or the iOS simulator.

## Review Focus

1. A tool call whose result arrives in a LATER transcript line than the call (always true) must pair across lines, including across a `usage` item and across an assistant text bubble that interleaves. → Task 2 test `pairs_result_across_interleaved_items`.
2. The newest call of a running turn has no result yet; it must show `◐`, never `●`, and must not fold. → Task 2 test `call_without_result_is_running_and_standalone`.
3. Failed `Bash` results start `Exit code 1\n…`, a line that says nothing useful on its own. `errorText` is the first non-empty line AFTER a leading `Exit code N` line when present, else the first non-empty line. → Task 1 test `error_text_skips_exit_code_line`.
4. A `Write` that creates a file has `structuredPatch: []` and `type: "create"` with `content`; it must produce `created · +N lines`, not an empty diff. → Task 1 test `write_create_is_created_diff`.
5. `tool_result.content` may be a string OR an array of `{type:"text",text}` blocks (and image blocks); `errorText` must handle both. → Task 1 test `error_text_from_block_array`.

---

### Task 1: Rust — `toolUseId` on events, `result` items with diffs

**Files:**
- Modify: `src-tauri/src/transcript.rs` (`tool_event` gains the id; `VIEW_LIMIT` 400 → 800; manifest test gets a `result` fixture)
- Modify: `src-tauri/src/transcript_user.rs` (tool_result blocks → `result` items)
- Modify: `src-tauri/src/transcript_item_kinds.json` (add `"result"`)

**Interfaces:**
- Produces: every `event` item gains `toolUseId: string | null` (from the `tool_use` block's `id`; question/plan items already carry theirs).
- Produces `result` items: `{ kind: "result", toolUseId: string, isError: bool, errorText: string | null, diff: Diff | null }` where `Diff = { filePath: string, added: number, removed: number, created: bool, lines: DiffLine[], more: number }` and `DiffLine = { kind: "add" | "del" | "ctx" | "gap", text: string, oldNo: number | null, newNo: number | null }`.
- Source shapes (real, from the founder's transcripts): a user line whose `message.content` is `[{"type":"tool_result","tool_use_id":"toolu_…","is_error":true|false|absent,"content": "…" | [{type:"text",text:"…"}]}]`; the same line's top-level `toolUseResult` (object) carries `filePath` and `structuredPatch: [{oldStart, oldLines, newStart, newLines, lines: ["  ctx", "-old", "+new"]}]` for Edit/MultiEdit, and for Write either the same patch or `{type:"create", content, structuredPatch: []}`. `toolUseResult` may also be a string or array — only an object with `structuredPatch` produces a diff.
- `diff` rules: `added`/`removed` count `+`/`-` lines across all hunks; `lines` renders each hunk's lines with numbers (old/new counters from `oldStart`/`newStart`), keeping at most 1 context line on each side of a change and collapsing longer context runs into one `gap` line; stop after 16 rendered lines and put the remainder count in `more`. `created: true` (from `type == "create"`) sets `added` = line count of `content`, `lines: []`, `more: 0`. An empty patch that is not a create → `diff: null`.
- `isError` = `is_error == true`; `errorText` only when `isError` (rule in Review Focus 3/5).

- [ ] **Step 1: Write failing tests** in `transcript_user.rs`: `ok_result_has_no_error_text`, `error_result_has_first_line` (`content: "Traceback…\nline2"` → `"Traceback…"`), `error_text_skips_exit_code_line` (`"Exit code 1\n\nnpm ERR! missing script"` → `"npm ERR! missing script"`), `error_text_from_block_array`, `error_text_capped_at_200`, `edit_result_has_diff` (one hunk `oldStart 61, newStart 61, lines [" a"," b","-c","+C"," d"," e"]` → added 1, removed 1, and `lines` exactly: `gap`, `ctx b (old 62, new 62)`, `del c (old 63, new null)`, `add C (old null, new 63)`, `ctx d (old 64, new 64)`, `gap` — the leading `a` and trailing `e` are beyond the 1-line context window and collapse to gaps), `diff_caps_at_16_lines_with_more`, `write_create_is_created_diff`, `non_object_tool_use_result_has_no_diff`; and in `transcript.rs`: `event_carries_tool_use_id`, plus a `result` fixture in `every_emitted_kind_is_in_the_manifest`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml transcript` → FAIL (no `result` kind).
- [ ] **Step 3: Implement** `fn result_item(block: &Value, tool_use_result: Option<&Value>) -> Value` and `fn diff_from(tool_use_result: &Value) -> Option<Value>` in `transcript_user.rs`; `parse_blocks` calls `result_item` for `tool_result` blocks (passing the line's `toolUseResult`) instead of skipping them; `tool_event` adds `toolUseId`.
- [ ] **Step 4: Verify** `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (all with `--manifest-path src-tauri/Cargo.toml`) → PASS. Update the `skips_tool_result…` test expectation it now contradicts.
- [ ] **Step 5: Commit** `feat(chat): emit tool results with failures and edit diffs`

### Task 2: Desktop — pair, fold only quiet calls, render status/errors/diffs

**Files:**
- Modify: `src/chatItems.ts`, `src/chatItems.test.ts`, `src/components/SessionChat.tsx`, `src/theme.css`

**Interfaces:**
- Consumes: Task 1 shapes.
- Produces in `chatItems.ts`: `result` member in `TranscriptItem` (+ `Diff`, `DiffLine` types); `event` member gains `toolUseId: string | null`; `RENDERED_KINDS` stays "manifest minus usage" — now including `result`, which is consumed by pairing; `export type Call = { event: EventItem; status: "running" | "ok" | "error"; errorText: string | null; diff: Diff | null }`; `ChatRow` becomes `{ type: "item"; item } | { type: "call"; call: Call } | { type: "tools"; calls: Call[] }`; `groupTools(items)` pairs events with results by `toolUseId` across the whole list, drops `usage` and `result`, folds runs of ≥ 2 quiet calls (Global Constraints rule) into `tools`, emits other calls as `call`; `export function groupLabel(calls: Call[]): string` per the Global Constraints buckets (replaces `toolsSummary`, which is deleted along with its test).
- Rendering: `call` row → glyph + verb + `<code>mono</code>`; `error` adds the `errorText` in red beneath; `diff` adds a `.hq-diff` block (`+N −M` header in green/red, then gutter rows: old/new numbers, `+`/`-`/space marker, text; `gap` rows render `⋮`; `more` → `… N more lines`; `created` → `created · +N lines`). `tools` row → one `.hq-tool-line` with `groupLabel` (dim), click toggles its calls listed beneath as `call`-style lines. Keys use `seq` as today.

- [ ] **Step 1: Failing tests** in `chatItems.test.ts`: `pairs_result_across_interleaved_items` (event A, usage, event B, result A, result B → A and B both `ok` and folded into one `tools` row; and event A, assistant bubble, result A → `call` A ok followed by the bubble), `call_without_result_is_running_and_standalone`, `two quiet calls fold, a failed call between them splits the run` (quiet, error, quiet → call, call, call), `three quiet calls fold into tools`, `edit with diff stays standalone`, `orphan result is dropped`, `groupLabel` cases (`[bash, bash, read]` → `"Ran 2 shell commands, read 1 file"`; `[grep]` → `"Searched 1 time"`; mixed generic → `"called N tools"` bucket). Keep the manifest test green.
- [ ] **Step 2: Run** `pnpm test -- chatItems` → FAIL.
- [ ] **Step 3: Implement** `chatItems.ts`, then the rendering + CSS in `SessionChat.tsx` / `theme.css` (tokens `--hq-ok`, `--hq-bad`, `--hq-ink-3` exist).
- [ ] **Step 4: Verify** `pnpm test && pnpm exec tsc --noEmit && pnpm build` → PASS.
- [ ] **Step 5: Commit** `feat(chat): show failed calls and edit diffs; fold only quiet tool calls`

### Task 3: Phone — same pairing and folding

**Files:**
- Modify: `mobile/src/bridge/protocol.ts`, `mobile/src/data/types.ts`, `mobile/src/bridge/live.ts`, `mobile/src/logic/feed.ts`, `mobile/src/logic/feed.test.ts`, `mobile/src/bridge/live.test.ts`, `mobile/src/screens/ChatScreen.tsx`, `mobile/README.md` (only if it describes tool rows)

**Interfaces:**
- Consumes: Task 1 wire shapes; the Global Constraints rule and label (replicated — the phone cannot import `src/`).
- Produces: `EventItem` gains `toolUseId?: string`; new `ResultItem { kind: "result"; id; toolUseId; isError; errorText: string | null; diff: WireDiff | null }`; `PHONE_KINDS` gains `"result"`; `groupFeed(items)` returns rows `{type:"item"} | {type:"call", call} | {type:"tools", id, calls}` with the same pairing/fold rule; `export function groupLabel(calls): string` in `feed.ts` matching desktop text exactly.
- Rendering (`ChatScreen.tsx`): `call` → glyph + label + mono (red error line beneath; diff block with `+N −M`, up to 16 monospace rows coloured by kind, `… N more lines`, or `created · +N lines`); `tools` → one dim line with the label, tap toggles the list (replaces the old always-open `EventRail` for folded runs).

- [ ] **Step 1: Failing tests** in `feed.test.ts` mirroring Task 2's grouping cases and `groupLabel` cases with identical expected strings; `live.test.ts`: `result` maps to a `ResultItem`, `PHONE_KINDS` parity still green.
- [ ] **Step 2: Run** `cd mobile && npm test` → FAIL.
- [ ] **Step 3: Implement** types, mapping, `groupFeed`, rendering.
- [ ] **Step 4: Verify** `cd mobile && npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(mobile): show failed calls and edit diffs; fold only quiet tool calls`

### Task 4: Docs

**Files:** `CHANGELOG.md` (`## Unreleased`), `CLAUDE.md` ("Where the transcript readers live" paragraph from plan 1)

- [ ] **Step 1: Changelog bullet** under `## Unreleased`:

```
- **Changed — Tool calls in session chat show what matters.** A failed call stays on its own line with its error, a file edit shows `+N −M` and a short diff, and only finished, successful calls fold into a one-line summary such as "Ran 2 shell commands, read 3 files" — on desktop and phone alike.
```

- [ ] **Step 2: CLAUDE.md** — one sentence added to plan 1's paragraph: results arrive as separate `result` items paired by `toolUseId` in each renderer's grouping function, and the quiet-fold rule must stay identical in `src/chatItems.ts` and `mobile/src/logic/feed.ts`.
- [ ] **Step 3: Commit** `docs(chat): tool results and quiet folding`
