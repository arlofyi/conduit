# Phone: session controls, usage, agy permissions, general chat options

Date: 2026-11-01. Round 3 of phone feedback on `feat/port-mirroring` (after
`2026-10-31-phone-sessions-files-general-chat-design.md`). This doc is the CONTRACT between the
Rust bridge and the phone; wire names below are exact.

## Findings that drove it

- **agy asked in its TUI and the phone showed nothing.** agy marks a tool step waiting on the
  user with `steps.status = 9` (measured live: a `run_command` step, payload `5.4` = the call,
  `56.21.2` = the command line). Nothing read it.
- **"Lots of failed tool calls" in a general chat were real denials, not a renderer bug.** The
  transcript parser was checked against the user's chat: 24 calls, 3 errors, all permission
  refusals (`A variable in this command can't be checked`, `requires approval`). `claude -p`
  auto-denies anything not allowed, and the charter never told the model it has no shell, so
  it kept trying Bash/PowerShell. The desktop simply does not render tool results.

## 1. agy permissions (Rust: `agy_prompts.rs`)

A watcher thread polls every live agy session that has a captured conversation id (stat db +
`-wal`, re-query only when one moved) for `status = 9` steps. Each new one is registered in the
EXISTING `Broker` (`register_held`, tool `Bash` + `{command}` for run_command, else agy's tool
name + its args), so the desktop hold-dock, the phone push diff and `approve` all work
unchanged. Registered only when `hooks::holder_for` says someone can see a card. A waiter
thread per prompt turns `Allow` / `Deny` into keystrokes on the session's PTY (keys pinned by a
live measurement, recorded below); `By::Terminal` (the step left status 9 on its own -- answered
in the TUI) sends nothing. Before sending, the step is re-read: still 9, or nothing is sent.

## 2. Session controls (Rust: bridge + store)

Projects view sessions gain `model`, `effort`, `keepRunning`, `usageKey` (whitelisted, key-list
test updated). `Session.keep_running` moves from desktop localStorage into `state.json`
(`#[serde(default)]`); the desktop reads it (legacy localStorage pins are migrated once).

- `{type:"sessionoptions", sessionId, requestId}` -> `{type:"sessionOptions", requestId,
  sessionId, agent, model, effort, keepRunning, modelLive, models:[{id,label}],
  efforts:[string], commands:[{name, description, kind:"builtin"|"command"|"skill"}],
  mcps:[{name, source, enabled}]}`. Session-scoped (private gate).
- `{type:"sessionset", sessionId, requestId, model?, effort?, name?, keepRunning?}` ->
  `{type:"sessionSetResult", requestId, ok, note}`. Model goes through the same path as the
  desktop's `switch_session_model` (live `/model` when the agent has one). Effort is persisted
  and applies at the next start; when the session is idle the desktop restarts it
  (`mobile-session-action` `restart`). Rename -> `mobile-session-action` `rename`, so the
  desktop's own action runs.
- `{type:"usage", requestId}` -> `{type:"usage", requestId, agents:[{key, agent, label, plan,
  windows:[{kind, label, used, resetsAt}], money?, models?, updatedAt, source}]}` from CACHED
  reads only (the OAuth usage endpoint rate-limits; see "Where the usage meter's semantics
  live"). `used` is the fraction consumed, as everywhere else.

## 3. General chat (Rust: root_chat + bridge)

`RootChat` gains `agent` (claude | antigravity, fixed per chat), `model`, `effort`, `research`,
`mcps` (user MCP server names opted in). All `#[serde(default)]`.

- `rootchatcreate` gains `agent`, `model`, `effort`, `research`, `mcps`.
- `{type:"rootchatsettings", chatId, requestId, model?, effort?, research?, mcps?}` ->
  `{type:"rootChatSettings", requestId, ok, chat}`.
- `{type:"rootchatoptions", requestId}` -> `{type:"rootChatOptions", requestId,
  agents:[{id, label, models:[{id,label}], efforts:[string]}], skills:[{name, description}],
  mcps:[{name}]}`.
- Charter tool policy: states exactly what the chat can run (no general shell; Glob results
  are newest-first, so use Glob for "recently changed").
- Deep research: effort raised + a research brief (many searches, read sources, cite).
- Antigravity chats run `agy -p --output-format stream-json` per turn (`--conversation` to
  resume), cwd = the chat's scratch dir, in-scope projects via `--add-dir`; history from the
  conversation db through `agy_transcript`. They have no Conduit tools (no dispatch) and say so.

## 4. Phone UI

- Tabs: "Chats" -> **Sessions**, "General" -> **Chats**.
- Settings order: **Usage** (compact 5 h + week gauges per agent; tap expands plan, every
  window, reset times, models) -> Notify me -> Theme -> Connection.
- Session header: name, project, status, model, effort, and a mini gauge of that agent's usage.
  The stop button is replaced by a preferences button: Files; Session (model, effort, rename,
  keep running); Commands & skills; MCP servers; Compact / Clear / Stop.
- Composer: `/` at the start of a message offers that agent's commands and skills.
- General "new chat": profile picker, scope, agent, model, effort, deep research, MCP servers.
  A chat's header opens the same settings mid-chat.
- Download: "Save to folder" (Android Storage Access Framework, last folder remembered) is the
  primary action; the share sheet stays as "Share".

## 5. Round 4 (user testing feedback, 2026-11-01)

- **One session sheet.** The title tap (session info) and the preferences button open the
  SAME sheet: the info view's look on top, the preferences' detail below. The sheet shows the
  ACTIVE model and effort: `sessionOptions.model`/`effort` are the PINNED values (null when
  unpinned), so the sheet falls back to the session view's live `model` and reads an unpinned
  effort as "Default".
- **Two-line header.** Line 1: name. Line 2: project · status · model · effort as signal bars.
  Right: a usage gauge the size of the preferences button, unmistakably usage (e.g. ring +
  "5h" caption), then the preferences button. Context usage becomes a coloured ring around the
  agent avatar.
- **Chats start fast.** "+" asks only for the agent; the chat opens at once with NO projects
  attached (`scope: {allProfiles:false, profiles:[], projects:[]}` = sees nothing). Model,
  effort, deep research, MCP servers and "Attach" (profiles / projects, like attaching a
  folder) live in the chat's settings sheet and apply from the next message.
- **Auto-approve (agy).** agy's own `--mode auto` still prompts for every command (measured:
  `echo` prompted under `--mode auto`), so Conduit answers instead. `Session.auto_approve`
  (`#[serde(default)]`); while on, `agy_prompts.rs` presses Allow for every waiting step
  itself (same keys, same re-read) and raises no card. Wire: projects view session
  `autoApprove`; `sessionOptions.autoApprove` + `autoApproveSupported` (agy only for now);
  `sessionset {autoApprove: bool}`. Session-scoped, so private sessions are refused by the
  existing gate.
- **Notifications with the screen off.** The phone closes its socket when backgrounded, and
  "Notify me" only ever drove in-app banners, so nothing reached a locked phone. An Android
  foreground service keeps a light authenticated socket while the app is in the background
  and posts system notifications for questions, permissions and finished turns (per the
  Notify me switches); tapping one opens that chat.
