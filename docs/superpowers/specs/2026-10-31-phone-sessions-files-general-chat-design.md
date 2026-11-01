# Phone: titled sessions, live list, Antigravity chats, project files, general chat

Date: 2026-10-31. Follows port mirroring (`2026-10-31-port-mirroring-design.md`) on the same
branch. Five asks from testing the phone app, built together because they share the bridge.

## 1. A title, and no first message required

`spawn` gains an optional `name`; `prompt` defaults to empty. `spawn_name` prefers a typed
title (one line, control characters to spaces, capped like derived names), else derives one
from the first message, else "Mobile". An empty prompt was always accepted by Rust -- only
the phone refused it -- and it starts the agent idle (`mergeSpawnedSession` stores no pending
prompt). The title also names the worktree branch (`store.rs` slugs the name).

## 2. The list follows the computer

Cause of "deleted, but still listed until refresh": the bridge acks `sessionaction` at once,
the phone re-lists immediately, and the desktop's `removeSession` had not landed yet, so the
phone got the old list and kept it for its 10 s poll.

Fix: `Store` counts successful saves (`save_generation`). A socket that has listed once
re-sends `projects` whenever the count moved, at most every 700 ms (`PROJECTS_PUSH_GAP`).
That also carries desktop renames and new sessions. Built in loop step 2d; `list` only sets
a flag, so there is one builder.

## 3. Antigravity as a real chat

Only Claude was offered because the phone renders a chat from a transcript. Antigravity's
conversation is `~/.gemini/antigravity-cli/conversations/<uuid>.db`, SQLite + protobuf; the
format is pinned in `2026-10-31-agy-conversation-format-findings.md`. `agy_transcript.rs`
rewrites each step as the equivalent Claude JSONL line and runs it through
`transcript::parse_line`, so the phone's renderer needed no change.

- Attach: an agy session gets a `Tail`; loop step 4c stats the db + WAL every 500 ms and
  re-reads only when one moved. New items only at the end go as `chat` frames; an item
  changed in place (a step finishing) re-sends `history`. The first read replaces the empty
  Claude-path history.
- The conversation id is the one `hooks.rs` already captures (`agent_conversation_id`), under
  the session's agy home (`resolve_agy_home`). Until it is captured the chat is empty.
- Opening the db must not create `-wal`/`-shm` next to agy's file: `immutable=1` when there
  is no WAL, read-only otherwise.
- Sending is unchanged: bracketed paste + Enter (agy is Bubble Tea v2, which handles paste).
- Other agents stay "opens on your computer only"; each needs its own reader.

## 4. Project files

`phone_fs.rs`, session-scoped (the session's directory -- worktree once it exists, never
"the project root instead"), so the private-session gate (`session_scope`) covers it.

- Paths arrive relative with `/`. `segments` refuses `..`, `.`, empty, `\`, `:` (drives,
  NTFS streams), NUL, trailing dot/space, Windows device names, `.git`, the upload folder and
  editor temp files. `resolve` walks from the root with `symlink_metadata` and refuses any
  link or junction, then re-checks with canonicalize + `strip_prefix`.
- `fslist` (2000 entries), `fsread` (1 MB text; larger is a truncated read-only preview;
  binary/non-UTF-8 read-only), `fswrite` (existing editable text only, refused as `conflict`
  unless the size and mtime are the ones the phone read), `fsdownload` (50 MB, 384 KiB raw
  chunks, one per `fsack`, file opened once, dropped after 120 s without an ack).
- Secrets (`.env*` but not `.env.example`, keys, `.npmrc`, credentials files) are listed and
  marked, need `confirm` to read or download, and are never written.
- Saves + downloads: 120 per 10 min per phone.

## 5. General chat (root chat on the phone)

Root chat already was the general chat; it only ran from the desktop window.

- `root_chat::send_turn` is the Tauri command's body, callable from the bridge. The
  workspace root (a desktop setting) is remembered from the desktop's last turn.
- `RootChatState` has subscribers: every user/item/done/error is published to them as well
  as emitted. A phone socket subscribes on its first `rootchat*` message and forwards events
  as `rootChatEvent`. A phone turn emits `root-chat-user` so the desktop shows the bubble.
- `RootChat.scope: Option<ChatScope { allProfiles, profiles: [id|null], projects }>`. None =
  everything (every older chat). `store.projects_for_chat` applies it to the roster in the
  charter and to every root-MCP tool (`sessions_list`, `session_peek`, `dispatch_work`);
  `chats_list`/`chat_read` show a scoped chat only chats in its own or its named profiles.
- File reads: measured against claude 2.x -- an allow list does NOT narrow Read/Glob/Grep
  (they need no permission; a scoped allow still read an out-of-scope file). A deny does.
  So a scoped chat gets `--disallowedTools Read(//<path>/**),Glob(...),Grep(...)` for every
  registered project outside its scope (never a folder containing an in-scope project).
  Paths use Claude's syntax (`//c/Users/...` on Windows). Files that are not registered
  projects remain readable, as before.
- `RootChat.phone` (sticky): a chat a phone has driven never `session_peek`s a private
  (silo/local-only) session, whatever private mode says -- the phone link refuses private
  sessions everywhere else (`chat_may_peek`).
- Sends: 60 per hour per phone (each is a paid `claude -p` turn). The phone view of a chat
  is built field by field (`root_chat_view`) and never carries `accountId`.
- Approving `dispatch_work` proposals stays on the desktop for now (routing picks the agent
  in the frontend).
