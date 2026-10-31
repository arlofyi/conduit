# agy conversation format -- findings (2026-10-31)

Reverse-engineered READ-ONLY from 13 conversations under
`~/.gemini/antigravity-cli/conversations/` (agy 1.4.5, Windows), copied to a temp dir first.
Reader: `src-tauri/src/agy_transcript.rs`.

## Files

| Path | What |
| --- | --- |
| `conversations/<uuid>.db` | SQLite, `journal_mode=wal`. The conversation. Authoritative. |
| `brain/<uuid>/.system_generated/logs/transcript{,_full}.jsonl` | JSON rendering of the same steps (`step_index`, `type` name, `status`, `created_at`, `content`, `tool_calls` with double-encoded args, `thinking`). Written for the MODEL to re-read after a checkpoint; carries NO tool-call ids and lags the DB (steps read `RUNNING` there that are `DONE` in the DB). Useful only as a decoder ring for type names. |
| `brain/<uuid>/.system_generated/steps/<idx>/output.txt` | Full tool output a step was truncated from. |
| `history.jsonl` | Typed-prompt history (`display`, ms `timestamp`, `workspace`, sometimes `conversationId`). |
| `conversation_summaries.db` | Per-conversation titles; not needed for a chat view. |

## Schema

Tables: `trajectory_meta(trajectory_id, cascade_id = the conversation uuid, trajectory_type, source)`,
**`steps(idx PK, step_type, status, has_subtrajectory, metadata, error_details, permissions, task_details, render_info, step_payload, step_format)`**,
`gen_metadata(idx, data, size)` (one per model call: model name, token counts),
`executor_metadata`, `parent_references`, `trajectory_metadata_blob`, `battle_mode_infos`.

One row per step, ordered by `idx` (0-based, contiguous). Blobs are protobuf
(`gemini_coder.Step`, Windsurf "Cortex trajectory" lineage), decoded schema-less.

`step_payload` = `{1: step_type, 4: status, 5: metadata (same bytes as the column), <oneof body>}`.
`metadata`: `1` created-at Timestamp `{1: secs, 2: nanos}`, `3` source (4 user, 2 model, 5 system),
`4` **the tool call this step executes** `{1: id, 2: name, 3: args JSON}`, `26` status history,
`30`/`31` toolSummary/toolAction.

| step_type | name | body field | content |
| --- | --- | --- | --- |
| 14 | USER_INPUT | 19 | `2` text as typed (also `3.1`), `12` workspace/config |
| 15 | PLANNER_RESPONSE | 20 | `1` reply text (`8` = same, post-processed), `3` thinking summary, `6` message id, `7` tool call (repeated, parallel calls) `{1 id, 2 name, 3 args JSON, 7 opaque signature, 9 name}`, `11` thinking stats, `12` stop reason, `14` encrypted signature |
| 21 | RUN_COMMAND | 28 | `2` cwd, `6` **exit code**, `21.1` output, `23` command, `31` shell |
| 8 / 7 / 9 / 5 | VIEW_FILE / GREP_SEARCH / LIST_DIRECTORY / CODE_ACTION | 14 / 13 / 15 / 10 (+56, 133, 147 permission data) | tool output |
| 132 | GENERIC (any tool, newer builds) | 140 | `1` args as k/v, `2.1` result text, `2.6` Any wrapping the typed step, `2.7` output.txt URI; `31.2` error |
| 17 | ERROR_MESSAGE | 24 | `3.2` text (API 503, "stream was interrupted"); with metadata.4 set it is a rejected tool call |
| 23 | CHECKPOINT | 30 | `5` summary (only on a real compaction), `4` title, `19` user requests |
| 101 | SYSTEM_MESSAGE | 114 | `3` kind (`task_notification`), `2.1` title, `2.2`/`2.10.1` body, `4.3` task id |
| 98 | CONVERSATION_HISTORY | 111 | empty marker |

`status`: 3 DONE, 6 CANCELED (e.g. parallel calls abandoned at exit), 7 ERROR (`error_details`
`{2,3}` text); 1/2/9 seen in history = generating/running/waiting on permission.

**Pairing:** the result step is a separate row after the planner row; its `metadata.4.1` equals
the planner's `7.1` call id. All 13 conversations pair 100% (0 unpaired, 0 orphan).

**Growth:** append-only by `idx`, plus in-place status updates (running -> done). While agy runs,
recent pages live in `<uuid>.db-wal` (+ `-shm`); after exit there is no `-wal`. Measured: a
`mode=ro` open of a WAL db with no `-wal` CREATES `-wal`/`-shm` sidecars, so the reader opens
`immutable=1` when there is no `-wal` and plain `mode=ro` when there is.

## Mapping to chat items

Each step is rewritten as the equivalent Claude JSONL line and passed through
`transcript::parse_line`, so shapes are identical by construction.

| agy | item |
| --- | --- |
| USER_INPUT | `bubble` role user (origin human) |
| PLANNER text | `bubble` role assistant; thinking dropped (as Claude) |
| tool call | `event` with `toolUseId`: run_command->bash, view_file/read_file->read, write_to_file/replace_file_content/multi_replace_file_content->edit, grep_search/list_dir/find_by_name->search, read_url_content/search_web->web, invoke_subagent->subagent, else generic with agy's `toolSummary` as `mono` |
| tool step DONE/ERROR/CANCELED | `result` (`isError`, `errorText`); non-zero exit -> `Exit code N\n<output>` so the same error-line picker applies; still running -> no result (renders running) |
| ERROR_MESSAGE without tool | `divider` tone warning (first line) |
| CHECKPOINT with summary | `divider` "Conversation compacted" |
| SYSTEM_MESSAGE task_notification | `task` (status `completed`); other notices -> info `divider` |
| timestamps | `at` from metadata.1 (RFC 3339 ms UTC) |

## Gaps / uncertain

- No `usage` items (gen_metadata `1.4.2`/`1.4.3` look like input/output tokens; unverified).
- No edit `diff` (agy's CODE_ACTION diff fields not decoded). No images.
- `ask_question`, `find_by_name`, `search_web`, `read_url_content`, `invoke_subagent` never
  appeared; their argument names are guesses with a `toolSummary` fallback. ask_question renders
  as an event, not a `question` card.
- Status 1/2/9 semantics inferred from status histories, not observed live.
- Field numbers are an undocumented internal format and can move with any agy update; the reader
  skips what it cannot parse.

## Submitting text to agy's TUI

agy.exe (Go) is built on **Bubble Tea v2** and its binary contains `?2004h`/`?2004l` and
`BracketedPaste` handling, so `pty::paste_and_submit` (`ESC[200~ text ESC[201~ \r`) should land
as one paste followed by Enter, as with Claude. **Unverified interactively**: agy was not run
for this spike, and on Windows the paste passes through ConPTY, whose handling of bracketed
paste markers depends on the app enabling VT input. Check before relying on it: send a
multi-line message from the phone to an agy session and confirm it submits once, not per line.
