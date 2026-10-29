# Mobile 1 — Chat message model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every kind of line Claude Code writes into a session transcript renders as what it is — on the desktop chat mode and on the phone — from one Rust parser, so a `<task-notification>` never again shows as a bubble from the user.

**Architecture:** `transcript::parse_line` stays the single classifier; user-line and system-line classification moves into a new `transcript_user.rs`, and the set of item kinds it can emit is pinned by a JSON manifest that the Rust, desktop (vitest) and mobile (jest) test suites all read. The desktop renders the new kinds in `SessionChat.tsx` (with tool runs grouped into one expandable line); the phone maps them in `mobile/src/bridge/live.ts` and renders them in `ChatScreen.tsx`. Bridge, root chat and desktop all call `parse_line` already, so no transport change is needed.

**Tech Stack:** Rust (serde_json), React 19 + TS (vitest), React Native / Expo SDK 56 (jest).

**Spec:** `docs/superpowers/specs/2026-10-29-mobile-over-tailscale-design.md` — §5 "One shared message model". This is plan 1 of 4 (2: Tailscale + pairing, 3: phone UI, 4: answering from the phone).

## Global Constraints

- One classifier: only `src-tauri/src/transcript.rs` / `transcript_user.rs` decide what a line is. Renderers never re-classify raw text.
- Desktop and phone receive the SAME items; the phone is not a filtered subset.
- Unknown leading tags degrade to a `note` item showing the tag name — never to a user bubble.
- A line whose `origin.kind` is `"human"` is ALWAYS a user bubble, whatever its text starts with.
- Assistant `thinking` blocks are dropped (spec: my call, revisit later).
- `usage` items keep their exact current shape (`context_window`/SPEC-G readers depend on it) and are never rendered in chat.
- Renderers render an unknown `kind` as nothing (root chat's `RootChatView.tsx` already does; keep it that way).
- Mobile: read https://docs.expo.dev/versions/v56.0.0/ before writing mobile code (`mobile/AGENTS.md`).
- Conventional Commits scoped `chat` or `mobile`; NO `Co-Authored-By` / AI trailer (CLAUDE.md).
- CHANGELOG bullets go under `## Unreleased`; do not touch the three version files.
- Worktree has no `node_modules`: run `pnpm install` at the repo root and `npm ci` in `mobile/` once before the first TS/RN test.

## Review Focus

1. A human prompt that starts with markup (pasting `<div>…` or `<task-notification>` as text) on a line with `origin.kind == "human"` must stay a user bubble. → Task 1 test `human_origin_wins_over_leading_tag`.
2. A pasted screenshot is a base64 image of several MB; shipping it in every history frame to a phone would stall the bridge. Images over 256 KiB of base64 carry no `data`. → Task 1 test `large_image_drops_data`.
3. `/compact` and `!cmd` output contains ANSI escapes (`\u001b[2m…`); they must be stripped, not shown as garbage. → Task 1 test `command_output_strips_ansi`.
4. A `<task-notification>` missing `<status>` or `<summary>` (older CLIs, `stopped` ones with only a `<note>`) must still be a `task` item, with status `"unknown"` / summary from `<note>`. → Task 1 test `task_notification_tolerates_missing_fields`.
5. The phone receives `usage` items in history today and maps them to a generic "used a tool" event — a visible bug. Any kind the phone does not render must map to nothing. → Task 4 test `mapChatItem drops usage and unknown kinds`.

---

### Task 1: Classify user lines (`transcript_user.rs`)

**Files:**
- Create: `src-tauri/src/transcript_user.rs`
- Create: `src-tauri/src/transcript_item_kinds.json`
- Modify: `src-tauri/src/transcript.rs:38-50` (the `"user"` arm delegates), `src-tauri/src/lib.rs:69` (add `mod transcript_user;`)

**Interfaces:**
- Produces: `pub fn parse_user(v: &serde_json::Value) -> Vec<serde_json::Value>` and `pub fn strip_ansi(s: &str) -> String` in `transcript_user.rs`.
- Produces the item shapes (camelCase keys, every item has `"kind"`):
  - `bubble` `{ role: "user", text }` (existing shape)
  - `task` `{ taskId: string|null, status: string, summary: string }` — status is `<status>` text or `"unknown"`
  - `peer` `{ from: string, text: string }` — `from` = `origin.name` else `origin.from` else `"another session"`
  - `auto` `{ label: string, text: string }` — label is the first line of the text, cut to 80 chars
  - `command` `{ name: string, args: string }` — `!` bash input is `name: "!"`
  - `command_output` `{ text: string, stream: "stdout" | "stderr" }`
  - `skill` `{ name: string }` — last path segment of "Base directory for this skill: <path>"
  - `image` `{ mediaType: string, data: string|null }`
  - `divider` `{ label: string, tone: "info" | "warning" }`
  - `note` `{ tag: string, text: string }`
- Produces `transcript_item_kinds.json`: a JSON array of every kind `parse_line` can emit, exactly
  `["bubble","event","usage","task","peer","auto","command","command_output","skill","image","divider","question","plan","note"]`.

Classification order for a `type == "user"` line (first match wins):
1. `origin.kind == "human"` → string content: one user `bubble`; array content: as rule 9.
2. `isCompactSummary == true` → nothing (the `compact_boundary` system line draws the divider).
3. `origin.kind == "task-notification"` or string content starting `<task-notification>` → `task` (parse `<task-id>`, `<status>`, `<summary>`, falling back to `<note>` for summary).
4. `origin.kind == "peer"` → `peer` with `text` = `origin.body` else the content text.
5. String starting `<local-command-caveat>` → nothing.
6. String starting `<command-name>` or `<command-message>` → `command` (`name` from `<command-name>` with the leading `/` kept, `args` from `<command-args>`); `<bash-input>` → `command {name:"!", args}`.
7. String starting `<local-command-stdout>` / `<bash-stdout>` → `command_output stdout`; `<local-command-stderr>` / `<bash-stderr>` → `stderr`; text ANSI-stripped and trimmed; empty → nothing.
8. `isMeta == true`: text starting `Base directory for this skill:` → `skill`; otherwise → `auto`.
9. Array content: `text` block equal to `[Request interrupted by user]` or starting `[Request interrupted by user` → `divider {label:"Interrupted", tone:"info"}`; other `text` blocks → user `bubble` (skip blank); `image` blocks → `image` (`data` = base64 when its length ≤ 262144, else null); `tool_result` blocks → nothing (as today).
10. String starting with `<[a-z][a-z0-9-]*>` (no origin) → `note {tag, text}`.
11. Any other string → user `bubble`.

- [ ] **Step 1: Write the failing tests** in `transcript_user.rs` `#[cfg(test)] mod tests`, each building the line with `json!` from the real shapes below (scrubbed from the founder's transcripts):

```rust
#[test] fn human_origin_wins_over_leading_tag() {
    let v = json!({"type":"user","origin":{"kind":"human"},"message":{"content":"<task-notification> pasted"}});
    let items = parse_user(&v);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], "bubble");
    assert_eq!(items[0]["role"], "user");
}
#[test] fn task_notification_becomes_task() {
    let v = json!({"type":"user","origin":{"kind":"task-notification","producer":"session-task"},
      "message":{"content":"<task-notification>\n<task-id>b1276wxdl</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Background command \"sleep 20\" completed (exit code 0)</summary>\n</task-notification>"}});
    let i = &parse_user(&v)[0];
    assert_eq!(i["kind"], "task"); assert_eq!(i["taskId"], "b1276wxdl");
    assert_eq!(i["status"], "completed");
    assert_eq!(i["summary"], "Background command \"sleep 20\" completed (exit code 0)");
}
#[test] fn task_notification_without_origin_still_task() { /* same content, no origin key → kind "task" */ }
#[test] fn task_notification_tolerates_missing_fields() {
    // content: "<task-notification>\n<task-id>b2</task-id>\n<note>No completion record was found</note>\n</task-notification>"
    // → status "unknown", summary "No completion record was found"
}
#[test] fn peer_message_uses_origin_name_and_body() {
    // isMeta:true, origin {kind:"peer", from:"a8b6", name:"general-purpose", body:"[Subagent hand-back] report"}
    // → kind "peer", from "general-purpose", text "[Subagent hand-back] report"
}
#[test] fn slash_command_becomes_command() {
    // content "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>"
    // → kind "command", name "/compact", args ""
}
#[test] fn bash_input_becomes_bang_command() { /* "<bash-input>ls -la</bash-input>" → name "!", args "ls -la" */ }
#[test] fn command_output_strips_ansi() {
    // "<local-command-stdout>\u{1b}[2mCompacted (ctrl+o to see full summary)\u{1b}[22m</local-command-stdout>"
    // → kind "command_output", stream "stdout", text "Compacted (ctrl+o to see full summary)"
}
#[test] fn caveat_and_compact_summary_are_dropped() {
    // isMeta + "<local-command-caveat>…" → empty; isCompactSummary:true + string → empty
}
#[test] fn skill_body_becomes_skill() {
    // isMeta:true, content [{type:"text", text:"Base directory for this skill: /Users/x/.claude/plugins/cache/p/superpowers/7.0.0/skills/brainstorming\n\n# Brainstorming"}]
    // → kind "skill", name "brainstorming"
}
#[test] fn meta_prompt_becomes_auto() {
    // isMeta:true, content "CONTINUITY RELAY TICK — Arlo Consumer plan session.\nmore"
    // → kind "auto", label "CONTINUITY RELAY TICK — Arlo Consumer plan session.", text = full content
}
#[test] fn interrupt_becomes_divider() {
    // content [{type:"text", text:"[Request interrupted by user]"}] → divider label "Interrupted" tone "info"
}
#[test] fn typed_text_with_images_is_bubble_plus_images() {
    // origin human, content [{type:"text",text:"look"},{type:"image",source:{type:"base64",media_type:"image/png",data:"AAAA"}}]
    // → [bubble "look", image mediaType "image/png" data "AAAA"]
}
#[test] fn large_image_drops_data() { /* data = "A".repeat(262_145) → image data null */ }
#[test] fn unknown_tag_without_origin_is_note() { /* "<weird-tag>x</weird-tag>" → note tag "weird-tag" */ }
#[test] fn plain_string_without_origin_is_bubble() { /* "add rate limiting" → user bubble (regression: old transcripts) */ }
```

Fill the commented tests with the exact JSON and assertions in their comments, in the style of the first two.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcript_user`
Expected: FAIL to compile — `parse_user` not defined.

- [ ] **Step 3: Implement `parse_user` and `strip_ansi`** following the classification order above. Tag extraction is a small private `fn tag_text(s: &str, tag: &str) -> Option<String>` (substring between `<tag>` and `</tag>`, trimmed); `strip_ansi` removes `ESC [ … final-byte` sequences without a regex crate. Create `transcript_item_kinds.json`. Change `transcript.rs`'s `"user"` arm to `out.extend(crate::transcript_user::parse_user(&v))`.

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcript`
Expected: all `transcript_user` tests PASS, and the existing `transcript::tests` (incl. `parses_user_text_bubble`, `skips_tool_result_and_meta_lines`) still PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript_user.rs src-tauri/src/transcript_item_kinds.json src-tauri/src/transcript.rs src-tauri/src/lib.rs
git commit -m "feat(chat): classify Claude's injected user lines instead of showing them as prompts"
```

### Task 2: System lines, tool calls, and the kinds manifest

**Files:**
- Modify: `src-tauri/src/transcript.rs` (`parse_line`'s `match kind`, `tool_event`)
- Modify: `src-tauri/src/transcript_user.rs` (add `parse_system`)

**Interfaces:**
- Consumes: Task 1's item shapes and `transcript_item_kinds.json`.
- Produces: `pub fn parse_system(v: &Value) -> Vec<Value>` in `transcript_user.rs`, plus these from assistant `tool_use` blocks:
  - `AskUserQuestion` → `question { toolUseId, questions: [{ question, header, multiSelect, options: [{ label, description }] }] }` (copied from `input.questions`; missing fields default to `""` / `false` / `[]`)
  - `ExitPlanMode` → `plan { markdown }` from `input.plan` (`""` if absent)
  - `Agent` and `Task` → existing `event` shape with `event: "subagent"`, `label: "subagent"`, `mono: input.description`
- `pub const ITEM_KINDS_JSON: &str = include_str!("transcript_item_kinds.json");` in `transcript.rs`.

System-line mapping (`type == "system"`, by `subtype`):
- `compact_boundary` → `divider { label: "Conversation compacted", tone: "info" }`
- `model_refusal_fallback` → `divider { label: <content up to the first blank line>, tone: "warning" }`
- `informational` → `divider { label: content, tone: "info" }`
- `scheduled_task_fire` → `auto { label: content, text: content }`
- everything else (`stop_hook_summary`, `turn_duration`, `away_summary`, …) → nothing.

- [ ] **Step 1: Write the failing tests** in `transcript.rs` tests:

```rust
#[test] fn compact_boundary_is_divider() {
    let l = json!({"type":"system","subtype":"compact_boundary","content":"Conversation compacted","level":"info"}).to_string();
    let i = &parse_line(&l)[0];
    assert_eq!(i["kind"], "divider"); assert_eq!(i["label"], "Conversation compacted"); assert_eq!(i["tone"], "info");
}
#[test] fn refusal_fallback_is_warning_divider() { /* content "Opus 5.5's safeguards flagged this session. …\n\nDetails: `[cyber]`" → tone "warning", label has no "Details" */ }
#[test] fn scheduled_fire_is_auto() { /* content "Running scheduled task (Sep 13 3:00am)" → auto */ }
#[test] fn noise_system_lines_are_dropped() { /* stop_hook_summary, turn_duration, away_summary → empty */ }
#[test] fn ask_user_question_becomes_question() {
    // assistant tool_use {id:"toolu_01Bw", name:"AskUserQuestion", input:{questions:[{question:"What do you see in the menu bar right now?", header:"Symptom", multiSelect:false, options:[{label:"No icon at all", description:"The ring … gone"}]}]}}
    // → kind "question", toolUseId "toolu_01Bw", questions[0].options[0].label "No icon at all"
}
#[test] fn exit_plan_mode_becomes_plan() { /* input {plan:"# Plan\n- a"} → plan markdown "# Plan\n- a" */ }
#[test] fn agent_tool_is_subagent_event() { /* name "Agent", input {description:"Builder check"} → event "subagent", mono "Builder check" */ }
#[test] fn thinking_blocks_are_dropped() { /* assistant content [{type:"thinking",thinking:"hm"}] → only usage-free empty vec */ }
#[test] fn every_emitted_kind_is_in_the_manifest() {
    let kinds: Vec<String> = serde_json::from_str(ITEM_KINDS_JSON).unwrap();
    // run parse_line over one fixture line per kind (reuse the JSON above and Task 1's) and
    // assert every item's "kind" is in `kinds`, AND that every entry of `kinds` was produced
    // by at least one fixture -- the manifest may neither lag nor lead the parser.
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcript`
Expected: FAIL (system lines produce nothing; AskUserQuestion is a generic event).

- [ ] **Step 3: Implement** the `"system"` arm calling `parse_system`, the three `tool_use` special cases ahead of `tool_event`, and `ITEM_KINDS_JSON`.

- [ ] **Step 4: Run tests, fmt, clippy**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo fmt --manifest-path src-tauri/Cargo.toml --check && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: PASS, no diff, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript.rs src-tauri/src/transcript_user.rs
git commit -m "feat(chat): parse compaction, refusals, questions, plans and subagents from transcripts"
```

### Task 3: Desktop item model + tool grouping (`src/chatItems.ts`)

**Files:**
- Create: `src/chatItems.ts`, `src/chatItems.test.ts`
- Modify: `src/store.ts:469-481` — replace the loose `TranscriptItem` interface with `export type { TranscriptItem } from "./chatItems";`

**Interfaces:**
- Consumes: Task 1/2 item shapes; `src-tauri/src/transcript_item_kinds.json`.
- Produces in `src/chatItems.ts`:
  - `export type TranscriptItem` — a discriminated union on `kind` with one member per manifest kind, fields exactly as Tasks 1–2 define (keep `usage`'s current fields).
  - `export const RENDERED_KINDS: readonly string[]` — every manifest kind except `usage`.
  - `export type ChatRow = { type: "item"; item: TranscriptItem } | { type: "tools"; events: Extract<TranscriptItem, { kind: "event" }>[] }`
  - `export function groupTools(items: TranscriptItem[]): ChatRow[]` — drops `usage`; merges each run of consecutive `event` items (ignoring `usage` between them) into one `tools` row.
  - `export function toolsSummary(events): string` — e.g. `"searched busy_sessions · read 4 files · edited 3 files"`: per event kind in first-seen order, `<verb> <mono>` when that kind occurs once, `<verb> <n> files` (read/edit) or `<verb> <n> times` (others) when more.
  - `export function taskLine(status: string): { mark: "ok" | "bad" | "info"; text: string }` — `completed` → ok "Background task finished", `failed`/`error` → bad "Background task failed", `stopped`/`killed` → info "Background task stopped", else info "Background task update".

- [ ] **Step 1: Write the failing tests** in `src/chatItems.test.ts`:

```ts
import kinds from "../src-tauri/src/transcript_item_kinds.json";
it("renders every kind Rust can emit except usage", () => {
  expect([...RENDERED_KINDS].sort()).toEqual(kinds.filter((k) => k !== "usage").sort());
});
it("groupTools merges a run of events across usage lines", () => {
  const rows = groupTools([
    { kind: "bubble", role: "user", text: "go" },
    { kind: "event", event: "read", label: "read", mono: "a.rs" },
    { kind: "usage", model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { kind: "event", event: "edit", label: "edited", mono: "b.rs" },
    { kind: "bubble", role: "assistant", text: "done" },
  ]);
  expect(rows.map((r) => r.type)).toEqual(["item", "tools", "item"]);
  expect(rows[1].type === "tools" && rows[1].events.length).toBe(2);
});
it("toolsSummary counts repeated kinds", () => {
  expect(toolsSummary([ev("search","busy_sessions"), ev("read","a"), ev("read","b"), ev("edit","c")]))
    .toBe("searched busy_sessions · read 2 files · edited c");
});
it("taskLine maps statuses", () => {
  expect(taskLine("completed")).toEqual({ mark: "ok", text: "Background task finished" });
  expect(taskLine("stopped").mark).toBe("info");
  expect(taskLine("failed").mark).toBe("bad");
  expect(taskLine("weird").text).toBe("Background task update");
});
```

(`ev(kind, mono)` is a local helper building an `event` item with the verb from `EVENT_MARK`'s values: read→"read", edit→"edited", search→"searched", bash→"ran", web→"browsed".)

- [ ] **Step 2: Run to verify fail** — `pnpm install && pnpm test -- chatItems` → FAIL, module not found.
- [ ] **Step 3: Implement `src/chatItems.ts`** and the `store.ts` re-export.
- [ ] **Step 4: Run** — `pnpm test && pnpm exec tsc --noEmit` → PASS (SessionChat still compiles: it only reads `kind`, `role`, `text`, `event`, `mono`).
- [ ] **Step 5: Commit** — `git add src/chatItems.ts src/chatItems.test.ts src/store.ts && git commit -m "feat(chat): typed transcript item model with tool-run grouping"`

### Task 4: Phone item mapping (`mobile/src/bridge`)

**Files:**
- Modify: `mobile/src/bridge/protocol.ts` (`WireChatItem` gets every manifest kind, same fields as Task 3's union)
- Modify: `mobile/src/data/types.ts` (new UI items below; `ChatItem` union extended)
- Modify: `mobile/src/bridge/live.ts` (`mapChatItem`), `mobile/src/bridge/LiveProvider.tsx` (filter nulls on `history` and `chat`)
- Test: `mobile/src/bridge/live.test.ts`

**Interfaces:**
- Consumes: Task 1/2 shapes, `../../../src-tauri/src/transcript_item_kinds.json`.
- Produces in `types.ts` (each with `id: string`):
  - `NoticeItem { kind: "notice"; tone: "ok" | "bad" | "info"; text: string; detail?: string }` — from `task` (text/tone via the same status table as Task 3's `taskLine`, `detail` = summary), `peer` (text `"Message from <from>"`, detail = text), `auto` (text = label, detail = text), `skill` (text `"Loaded skill <name>"`), `note` (text = `<tag>`, detail = text)
  - `DividerItem { kind: "divider"; label: string; tone: "info" | "warning" }`
  - `CommandItem { kind: "command"; name: string; args: string; output?: string }` — `command_output` immediately after a `command` is folded into its `output` by `mapHistory`; a lone one becomes a `CommandItem` with `name: ""`
  - `ImageItem { kind: "image"; mediaType: string; data: string | null }`
  - `QuestionItem { kind: "question"; toolUseId: string; questions: WireQuestion[] }`
  - `PlanItem { kind: "plan"; markdown: string }`
- `export function mapChatItem(w: WireChatItem): ChatItem | null` — `usage` and unknown kinds → `null`; `event` unchanged.
- `export function mapHistory(ws: WireChatItem[]): ChatItem[]` — maps, drops nulls, folds command output.
- `export const PHONE_KINDS: readonly string[]` — every wire kind `mapChatItem` handles (manifest minus `usage`).

- [ ] **Step 1: Write the failing tests** in `live.test.ts`:

```ts
const kinds: string[] = require("../../../src-tauri/src/transcript_item_kinds.json");
it("handles every kind Rust can emit except usage", () => {
  expect([...PHONE_KINDS].sort()).toEqual(kinds.filter((k) => k !== "usage").sort());
});
it("mapChatItem drops usage and unknown kinds", () => {
  expect(mapChatItem({ kind: "usage" } as never)).toBeNull();
  expect(mapChatItem({ kind: "from-the-future" } as never)).toBeNull();
});
it("task becomes an ok notice with the summary as detail", () => {
  const n = mapChatItem({ kind: "task", taskId: "b1", status: "completed", summary: "exit 0" });
  expect(n).toMatchObject({ kind: "notice", tone: "ok", text: "Background task finished", detail: "exit 0" });
});
it("mapHistory folds command output into its command", () => {
  const out = mapHistory([
    { kind: "command", name: "/compact", args: "" },
    { kind: "command_output", text: "Compacted", stream: "stdout" },
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ kind: "command", name: "/compact", output: "Compacted" });
});
```

- [ ] **Step 2: Run to verify fail** — `cd mobile && npm ci && npm test -- live` → FAIL.
- [ ] **Step 3: Implement** the types, `mapChatItem`, `mapHistory`, `PHONE_KINDS`; `LiveProvider` uses `mapHistory` for `history` and `mapChatItem` (skipping null, folding a `command_output` into the previous `command`) for `chat`.
- [ ] **Step 4: Run** — `npm test && npm run typecheck` (in `mobile/`) → PASS. `ChatScreen`'s `switch` may now fail exhaustiveness; if `typecheck` fails only there, add `default: return null;` — Task 6 renders the new kinds.
- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): map every transcript item kind, drop usage"` with the four files.

### Task 5: Desktop rendering

**Files:**
- Modify: `src/components/SessionChat.tsx` (render via `groupTools`; new `Item` cases)
- Modify: `src/theme.css` (next to `.hq-tool-line`, ~line 5799)

**Interfaces:**
- Consumes: Task 3's `groupTools`, `toolsSummary`, `taskLine`, `TranscriptItem`.

Rendering, all inside the existing `.hq-column`, using `--hq-*` tokens only:
- `tools` row → one `.hq-tool-line` showing `toolsSummary(events)`; click toggles a list of the individual lines (verb + `<code>mono</code>`) underneath. Single-event runs render exactly as today.
- `task` → `.hq-note` centred pill, `✓`/`✕`/`•` by `taskLine().mark`, coloured green/red/ink-3; click toggles `summary`.
- `peer` → `.hq-note` "Message from <from>", click toggles `text` (pre-wrap).
- `auto` → `.hq-note` with `label`, click toggles `text`.
- `skill` → `.hq-note` "Loaded skill <name>" (no toggle).
- `note` → `.hq-note` "<tag>", click toggles `text`.
- `command` → right-aligned `.hq-command` chip `name args` in monospace; `command_output` → `.hq-command-output` collapsed `<pre>` (first 3 lines, click to expand).
- `image` with `data` → `<img class="hq-image" src="data:<mediaType>;base64,<data>">` max-width 240px; without data → `.hq-note` "Image".
- `divider` → `.hq-divider` full-width hairline with centred label; `tone: "warning"` uses `--hq-warn` (add the token beside the other `--hq-*` if absent, from the theme's amber).
- `question` → `.hq-question` card: header chip, question text, numbered options with descriptions, `(Recommended)` suffix shown as a tag; read-only in this plan (answering is plan 4).
- `plan` → `.hq-plan` card rendering `renderMarkdown(markdown)`, titled "Plan".

- [ ] **Step 1: Implement** the rendering and CSS.
- [ ] **Step 2: Verify build** — `pnpm exec tsc --noEmit && pnpm build` → PASS.
- [ ] **Step 3: Verify in the app** — the installed Conduit is running (do NOT clobber its state): `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, add this repo as a project, open a Claude session, run `/compact`, a `!ls`, ask it to "run `sleep 5` in the background and tell me when done", and to "ask me a multiple-choice question with AskUserQuestion". Open the rich session view (Settings → General) and confirm: the slash command is a chip, the background task is a `✓` note (not a bubble), compaction is a divider, the question is a card, tool runs collapse into one line that expands on click. Screenshot it.
- [ ] **Step 4: Commit** — `git commit -m "feat(chat): render task notices, commands, dividers, questions and plans in session chat"`

### Task 6: Phone rendering + docs

**Files:**
- Modify: `mobile/src/screens/ChatScreen.tsx` (`FeedRowView` cases), `mobile/README.md` (drop the "mock-backed" status; describe the live bridge and that Tailscale connection lands in plan 2)
- Modify: `CHANGELOG.md` (`## Unreleased`), `CLAUDE.md` ("Where the transcript readers live": one paragraph on `transcript_user.rs`, the manifest, and the human-origin rule)

**Interfaces:**
- Consumes: Task 4's UI item types.

Rendering mirrors Task 5 in RN with the existing palette tokens: `notice` → centred pill (`p.green`/`p.red`/`p.textMid`), tap toggles `detail`; `divider` → hairline with label (`p.amber` for warning); `command` → right-aligned monospace chip, `output` collapsed below; `image` → `<Image source={{ uri: "data:…" }}>` max 220 wide, or a "Image" pill without data; `question` → card styled like the existing `ApprovalCard` border/background (`p.amber`, `p.needsBg`), options listed read-only; `plan` → card with the markdown as plain text (no RN markdown dependency in this plan).

- [ ] **Step 1: Implement** the cases (remove the temporary `default` from Task 4).
- [ ] **Step 2: Verify** — `cd mobile && npm test && npm run typecheck` → PASS.
- [ ] **Step 3: Verify on the simulator** — with the dev desktop from Task 5 running (bridge on loopback), `cd mobile && npx expo run:ios`, open the same session, confirm the same items render as on desktop (no raw `<task-notification>`). Screenshot.
- [ ] **Step 4: Changelog** under `## Unreleased`:

```
- **Fixed — Session chat no longer shows Claude's own messages as yours.** Background-task notices, messages from other sessions, scheduled check-ins, slash commands and loaded skills now appear as small notes instead of chat bubbles from you.
- **Added — Session chat shows compaction, questions and plans.** "Conversation compacted" and interruptions appear as dividers, AskUserQuestion prompts show their options, plans render as a card, and runs of tool calls collapse into one expandable line.
```

- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): render the full transcript item set; docs"`
