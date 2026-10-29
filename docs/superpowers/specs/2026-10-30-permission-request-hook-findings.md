# PermissionRequest hook — spike findings (2026-10-30)

Measured against **claude 2.1.312** (`/opt/homebrew/Caskroom/claude-code@latest/2.1.312/claude`),
interactive TUI, `--permission-mode default`, inside tmux on a private socket, in a fresh
non-git directory with the hooks in its `.claude/settings.local.json`. The hook command was
`curl -s -m 200 -X POST --data-binary @- http://127.0.0.1:8399/perm` against a local listener
that logged the body and replied after a configurable delay. Prompts were harmless
`touch spike-<x>.txt` commands. Schema cross-checked against strings in the binary.

## Verdict: **GO**

`PermissionRequest` works in the interactive TUI for answering tool permissions out of band.
An `allow` or `deny` reply from the hook closes the TUI dialog and takes effect even while
the dialog is on screen. An empty or `{}` reply leaves the dialog in place. Three things
change the plan: AskUserQuestion also fires this event; the input has no `tool_use_id`; and
what happens to the hook when someone answers in the terminal depends on which answer they
gave. All three are covered below.

## 1. Stdin body (exact, test A)

```json
{
  "session_id": "8530efd1-686f-4569-a988-f3504645fab9",
  "transcript_path": "/Users/uzairhayat/.claude/projects/-private-tmp-…-spike-perm-work/8530efd1-686f-4569-a988-f3504645fab9.jsonl",
  "cwd": "/private/tmp/claude-501/…/scratchpad/spike-perm/work",
  "scratchpad_dir": "/private/tmp/claude-501/…/8530efd1-686f-4569-a988-f3504645fab9/scratchpad",
  "prompt_id": "2ade4458-c666-422a-9ef5-a52be998c2fa",
  "permission_mode": "default",
  "effort": {"level": "medium"},
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {"command": "touch spike-a.txt", "description": "Create empty file spike-a.txt"},
  "permission_suggestions": [
    {"type": "addDirectories", "directories": ["/private/tmp/claude-501/…/spike-perm/work"], "destination": "session"},
    {"type": "setMode", "mode": "acceptEdits", "destination": "session"}
  ]
}
```

(Paths shortened with `…` here only for width. Nothing is secret.)

- Present: `session_id`, `tool_name`, `tool_input`, `permission_suggestions`, `permission_mode`,
  `prompt_id`, `cwd`, `transcript_path`.
- **Absent: `tool_use_id`.** The binary's input schema confirms it:
  `{hook_event_name:"PermissionRequest", tool_name, tool_input, permission_suggestions?, mcp_server?}`.
  `PreToolUse` fires 20–100 ms before it with the same `tool_input` and *does* carry
  `tool_use_id` (`toolu_01QXEmXk5Yq5Z8vAsnUm3QbC` in test A), so a correlation is possible if
  one is ever needed. Conduit should key a pending permission by its own minted id plus
  `session_id`.
- `mcp_server` is optional and only appears for MCP tools.

## 2. TUI interplay while the hook is pending

The hook and the dialog run **in parallel**. Claude does not wait for the hook before it
shows the dialog. In every run the "Do you want to proceed?" dialog was on screen within
about 4 s, while the hook was still blocked.

| Case | What happened |
| --- | --- |
| Hook replies `allow` while the dialog is up (test C, 12 s delay) | The dialog closed, the tool ran, and the TUI showed `⎿ Allowed by PermissionRequest hook`. |
| Hook replies `deny` while the dialog is up (test D, 8 s delay) | The dialog closed and the tool did not run. The TUI showed `⎿ Denied by PermissionRequest hook`, and the model received the message (it replied `Command refused: "Denied from Conduit"`). **The turn continued.** It was not interrupted. |
| Hook replies `""` (test A) or `{}` (test E) | The dialog stayed up and waited for the human. That is a clean fall-through. |
| **User picks "1. Yes" in the TUI while the hook is pending** (tests B, J) | The tool ran at once. **The hook process is NOT killed.** It kept running until the listener replied 25 s / 40 s later (`status: sent`). That late reply was **ignored**: in test B it was a `deny`, and the file still existed and nothing changed. `PostToolUse` (with the `tool_use_id`) and `Stop` fired as normal. |
| **User picks "4. No" in the TUI while the hook is pending** (test I) | The turn was interrupted (`Interrupted · What should Claude do instead?`). **The hook process WAS killed** (the curl was gone within 4 s). The listener's later write failed with `BrokenPipeError`. **No `PostToolUse`, `PostToolUseFailure` or `Stop` fired.** The next event from that session was the next `UserPromptSubmit`. |
| Hook exceeds its own `timeout` (test G: timeout 30, reply at 45 s) | The hook was killed at 30 s, and its `echo` never ran because the whole `sh` was killed. The listener's write failed with `BrokenPipeError`. **The dialog stayed up**, so a timeout is a fall-through and not a deny. |

## 3. Working output shapes

These are confirmed by the binary's validator (`PermissionRequest decision must be
{"behavior": "allow"} or {"behavior": "deny", "message": "..."}`) and by the measurements:

- **Allow** (tool runs, dialog closes):
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
  Optional extras: `updatedInput` (object) and `updatedPermissions` (array, the same shape as
  `permission_suggestions`, which would persist an "always allow"). Conduit should send
  neither.
- **Deny** (tool refused, model sees the message, turn continues):
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Conduit"}}}`
  Optional `"interrupt": true` aborts the turn as well. That was not measured and the plan
  does not need it.
- **Fall through to the TUI dialog**: `{}` or empty stdout (exit 0). Both were measured.

The plan's two shapes are correct as written.

## 4. Timeout

`"timeout": 120` with a reply at 90 s was **honoured** (test F): the allow arrived at 90 s
and the tool ran. A hook that overruns its `timeout` is killed, and the dialog remains
(test G). So the ceiling ordering `PERMISSION_CEILING` 300 < curl 330 < hook `timeout` 340
is sound, and the hook `timeout` field must be set, because the default is too short.

## 5. Notification interplay

`Notification` with `notification_type: "permission_prompt"` (`message: "Claude needs your
permission"`) fires **6 s after the dialog appears**, whether or not the PermissionRequest
hook is still pending. It fired in every run where the dialog stayed up at least 6 s
(A, B, C, D, E, F, G, I, J). It did **not** fire when the hook allowed within 1 s
(test H), because the dialog closed before the 6 s mark. Consequence: a session can show
`needsInput` from the notification while the phone card is live. That is consistent, not
a conflict.

## 6. AskUserQuestion fires PermissionRequest too

**Yes, it does.** An `AskUserQuestion` call produced `PreToolUse` → `PermissionRequest`
(`tool_name: "AskUserQuestion"`, `tool_input.questions[…]`) → the question UI →
`Notification permission_prompt` 6 s later. Conduit's existing PreToolUse `/ask` route
answers questions *before* this point. When that route falls through (`{}`), the request
reaches `/permission`, which must **not** turn it into a permission card or answer it.
`allow` would run the question tool with no answers.

## Corrections to the plan's permission-hook constraint line

Replace the Global Constraints "Permission hook" bullet's tail with the following
(the shapes, ceilings and route stay the same):

- **Skip questions:** `/permission` answers `{}` immediately for
  `tool_name ∈ {AskUserQuestion, ExitPlanMode}`. They are answered by `/ask`, or by the
  TUI's own UI.
  (ExitPlanMode was not measured. It is listed because `status_rules::awaits_user` treats it
  the same way.) Doing this server-side is simpler than a matcher regex, and it keeps the
  hook row generic.
- **No `tool_use_id`:** the input carries `session_id`, `tool_name`, `tool_input`,
  `permission_suggestions`, `permission_mode` and `prompt_id`. Key the broker entry by a
  minted id and `session_id`. Do not expect `toolUseId` on `PermissionPush`.
- **The terminal can answer first, and the two answers end differently:**
  - TUI **Yes**: the hook is orphaned (still blocked on curl) and its reply is ignored, and
    `PostToolUse` + `Stop` follow. The plan's cancellation rule (a `tooluse`/`stop` hook from
    the same session resolves its pending permission as cancelled/`terminal`) covers this.
    Keep it.
  - TUI **No / Esc**: the hook is **killed** and **no** `tooluse`/`stop` hook follows. The
    entry is only cleared by the session's *next* `prompt`, which could be minutes away.
    So the `/permission` handler must also **watch its socket for peer close** while it
    blocks (a non-blocking `peek` returning 0, or an error), and resolve the entry
    `by: "terminal"` when the curl goes away. Without this, a phone keeps a dead card
    after a terminal "No".
  - A Conduit reply that loses the race is harmless. After a TUI Yes it is ignored. After a
    TUI No it fails to write (broken pipe). So "first answer wins" holds as long as the
    broker resolves once.
- **Deny does not end the turn**: the model receives `message` and keeps going. Keep the
  message user-facing ("Denied from Conduit"), because the model quotes it.
- **Never send `updatedPermissions`/`updatedInput`**: they persist rules or rewrite the call.
- **Notification overlap is expected**: `permission_prompt` fires 6 s after the dialog shows,
  even while the phone card is pending. No dedup is needed beyond what `needsInput` already
  does.

## Artifacts

Scratch listener/settings lived under the session scratchpad (`spike-perm/`). The temp dir
was non-git, so the continuity plugin wrote nothing to the real DB. Claude itself wrote two
transcript directories for the temp cwd under `~/.claude/projects/-private-tmp-…-spike-perm-work/`.
They are harmless and were left in place.
