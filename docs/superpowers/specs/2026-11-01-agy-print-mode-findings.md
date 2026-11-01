# agy print mode -- findings (2026-11-01)

Measured against agy 1.4.12 on Windows, in a temp dir outside any git repo, with the real
home profile (a HOME-redirected shell sees a fresh, signed-out agy). Seven tiny turns,
`gemini-3.8-flash-low` where a model was pinned. Used by `src-tauri/src/root_chat_agy.rs`.

## Invocation

- `-p` / `--print` takes the prompt as its OWN value (`-p "text"`); `-p` with the prompt on
  stdin fails (`flag needs an argument`), and `-p --output-format ...` is rejected ("-p took
  --output-format as its prompt").
- **Use `--output-format stream-json --input-format stream-json` and no `-p`.** stdin then
  takes NDJSON, one turn per line; the process exits at EOF. The input line is
  `{"event":"user","message":{"role":"user","content":"<text>"}}` (found by error probing:
  `event` is required, `message` must be an object, an empty one is "has no content"). This
  keeps the prompt off the command line entirely, which is what Windows needs.
- `--model <id>` and `--effort low|medium|high|xhigh|max` are accepted in print mode.
- `--conversation <uuid>` resumes: a second turn knew the first turn's answer and continued
  the same step indices (2..) in the same `conversations/<uuid>.db`.
- `--settings <file>` takes a JSON object of settings.json keys for this session only.

## Output lines (stream-json)

```
{"event":"init","conversation_id":"<uuid>","init":{"cwd":"...","tools":[...],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"<uuid>","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{...,"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"po"}}
{"event":"step_update","step_update":{...,"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"ng\n","usage":{...}}}
{"event":"step_update","step_update":{...,"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"C:/..."}}}}
{"event":"step_update","step_update":{...,"step_index":2,"state":"DONE","step_type":"tool",...,"tool_info":{...,"output":"1 lines, 10 bytes"}}}
{"event":"step_update","step_update":{...,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{...,"error":{"type":"TOOL_ERROR","message":"..."}}}}
{"event":"result","result":{"conversation_id":"<uuid>","status":"SUCCESS","response":"pong\n","num_turns":1,"usage":{...},"denied_actions":[...]}}
```

- **The conversation id of a first turn is on the `init` line** (also on every step and the
  result). No filesystem scan needed. The db appears under
  `<home>/.gemini/antigravity-cli/conversations/<uuid>.db` as with the TUI.
- Reply text arrives as `text_delta` pieces of one `agent_response` step; a step with no
  delta and `DONE` is a planning step with no visible text. `system_message` steps appear.
- A failed turn: `{"event":"result","result":{"status":"ERROR","error":"...","num_turns":0}}`,
  exit code 1.
- Tool `output` is a SUMMARY ("1 lines, 10 bytes"), not the content.

## Permissions in print mode

- **It does not hang.** A tool that would prompt is auto-denied at once
  (`user denied permission to run command`), the turn continues, and stderr explains
  ("headless mode cannot prompt"). `result.denied_actions` lists them.
- **The user's own `permissions.allow` applies** (this machine's allows `git commit`, `npx`,
  `pnpm exec` ...), so "unallowed = denied" is not enough for a read-only chat.
- **Deny rules in `--settings` win over those allows** (measured: `git status`, allowed
  globally, refused with "Matches user-configured deny rule"). Kinds seen in the binary:
  `command(<prefix>)`, `read_file(<abs path>)`, `write_file(<abs path>)`, `read_url(<domain>)`,
  `execute_url(<domain>)`, `mcp(*)`; `*` matches everything.
- `read_file(<dir>)` denies the whole tree (forward slashes). **`read_file()` with an empty
  path denied the working directory** -- never emit one.
- Reads outside the workspace are NOT restricted by default (a file outside the cwd, with no
  `--add-dir`, was read), so `--add-dir` gives context, not a boundary; out-of-scope
  projects need deny rules.
- `search_web` worked headless with no rule. `read_url_content` was never attempted in these
  runs (the model tried a PowerShell download first, which was denied), so whether reading a
  URL needs an allow rule in print mode is unverified.
- Not used: `--dangerously-skip-permissions`, `--mode` (not needed once deny rules exist).

## System prompt

No system-prompt flag. **agy follows an `AGENTS.md` in its working directory** (measured: a
role + "end every reply with BANANA" was obeyed), so a general chat writes its charter there;
the chat's cwd is its own scratch dir. `GEMINI.md` is also referenced in the binary
(untested).

## Not measured

- `--input-format stream-json` with more than one line (multi-turn in one process).
- Whether `grep_search` / `list_dir` are governed by `read_file` rules (assumed).
- Behaviour when the `--conversation` id no longer exists (Conduit starts fresh instead).
