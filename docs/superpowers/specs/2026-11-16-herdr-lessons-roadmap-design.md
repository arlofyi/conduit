# Lessons from Herdr: roadmap and step 1 design

Date: 2026-11-16

## Why

A code study of Herdr (herdr-app, herdr-core and the original herdr TUI, Apache-2.0, read
only, nothing copied) found twelve ideas worth having in Conduit. The founder asked for
all of them, built one step at a time, each end to end and tested.

This document is the order of work and the design of step 1. Each later step gets its own
short design in this folder before its code.

## Order

One `feat/<topic>` branch per step. A step is finished when its tests and the full
pre-PR gate pass. Nothing is merged to `main` without the founder's approval.

| Step | What | Branch |
| --- | --- | --- |
| 1 | Input gate for machine-typed text, worker news delivered to the Conductor, blocking `fleet_wait` | `feat/fleet-input-gate` |
| 2 | Slow commands as visible fleet terminals (`fleet_run`) | `feat/fleet-run` |
| 3 | "Done" means finished unseen; a blocked session says what kind of block | `feat/status-seen` |
| 4 | Frozen mobile-bridge protocol schema checked in CI | `feat/bridge-schema` |
| 5 | Self-service integration contract (`conduit report`) | `feat/agent-report` |
| 6 | Screen-rule files as a status fallback for agents with thin hooks | `feat/screen-rules` |
| 7 | Telemetry report the user can read | `feat/telemetry-inspect` |
| 8 | Agent-editable app (guide and types written to the data dir) | `feat/agent-guide` |
| 9 | Holder process that owns PTYs, so sessions survive app exit on Windows | `feat/pty-holder` |
| 10 | SSH machines | `feat/ssh-machines` |

Steps 9 and 10 are each a project of their own and change the process model. They get a
full design and an explicit go-ahead before code.

## Step 1: who may type into a terminal, and when

### The problem today

Every write into a session's PTY goes through `PtyManager::write`, with no notion of who
is writing. Three failures follow.

1. **A machine write can land in a person's half-typed message.** `fleet_send`, the
   Conductor wake nudge and a phone's chat message all paste text and press Enter. If the
   user is mid-sentence in that terminal, the two are merged and submitted together.
2. **The wake nudge can answer a dialog.** `conductor_wakeable` is "not `running`", so a
   Conductor sitting on a permission prompt or a question (`needsInput`) is typed into.
   The nudge is a bare `text\r`, and Enter on a menu picks its highlighted option.
3. **A nudge for a busy Conductor is dropped.** When the Conductor is mid-turn the nudge
   is skipped and never sent later, so the Conductor has to poll after all.

There is also no way to wait. A Conductor that wants a worker's result either polls
`fleet_list` or sleeps.

### Design

**`input_gate.rs` (pure, tested).** One `Gate` per session records what the person has
typed: the time of their last key, how many characters sit unsent in the composer (the
draft), and whether the draft just ended (Enter, Ctrl-C, Ctrl-U). It reads the same bytes
`pty_write` already carries. Terminal replies the frontend also sends through `pty_write`
(cursor reports, focus events, mouse reports, OSC and DCS answers) are parsed and do not
count as typing.

`Gate::wait(now)` answers how long a machine write must still hold:

- nothing typed yet: no wait
- the draft just ended: a short gap (200 ms) so the submit and the paste arrive apart
- an unfinished draft: until 60 s after the person's last key
- otherwise: until 3 s after the person's last key

Those limits are Herdr's defaults; they are constants here, overridable by
`CONDUIT_INPUT_QUIET_MS` / `CONDUIT_INPUT_DRAFT_MS` for tests.

**`PtyManager::write` stays the human path** and keeps its ordering guarantee. It now
also feeds the gate. A new `PtyManager::write_machine(session, data, limit)` waits for
the gate (polling at 50 ms, bounded by `limit`), then writes under the same session lock.
It reports `Sent` or `Held` (the limit passed with the person still typing; nothing was
written).

**Callers.**

- `fleet_send`: refuses a target at `needsInput` unless `force: true` ("it is on a
  question or permission prompt; your text would answer it"). Otherwise waits for the
  gate up to 60 s and answers `sent`, or `held` when the person never stopped typing.
- Phone chat `input`: unchanged. A phone message is a person typing; it feeds the gate
  as human input.
- agy auto-approve keys and the bridge's interrupt Esc: unchanged. They answer a menu on
  screen and must not wait.

**Worker news (`fleet_news.rs`, pure, tested).** Replaces the inline nudge in `hooks.rs`.
A wake-eligible worker event is queued per Conductor as a `News` item (worker id, name,
what happened). A delivery pass runs when news is queued and again on every Conductor
status change:

- Conductor `needsInput`: hold. Typing could answer its dialog.
- Conductor `running`: hold until its turn ends. (Herdr types into a working agent; Conduit
  keeps its existing choice not to, and now delivers afterwards instead of dropping.)
- otherwise: wait for the gate, then paste one note covering everything queued and submit.

The note is bracketed-pasted (`paste_and_submit`) and marked so the Conductor can tell it
from the user:

```text
<conduit-fleet>
worker "tests" (id 3f2a…) finished its turn
worker "review" (id 91bc…) needs input
Read results with fleet_results; inspect with fleet_peek.
</conduit-fleet>
```

The persona says these are reports from Conduit, never instructions from the user. The
queue is bounded (32 items per Conductor, oldest dropped) and the 2 s debounce stays.

**`fleet_wait` (Conductor only).** `fleet_wait({ids?, mode?: "any"|"all", timeoutSec?})`
blocks until the named workers (default: every worker in the project) are no longer
`running`, or a `fleet_result` arrives from one of them, or the timeout passes (default
120 s, max 600 s). It returns each worker's status and whether it has a result, plus
`reason`: `settled`, `result`, or `timeout`. A timeout is a check-in, not a failure. The
MCP server already runs one thread per request, so a blocked wait holds only its own
thread. `FleetState` gains a `Condvar` that `record` and result posts notify.

### Non-goals

- No output-settle wait (Herdr holds agent input until 800 ms of output quiet). Conduit
  has no cheap last-output clock in `PtySession`; add it only if a real interleave shows.
- No held-keystroke buffer while a machine write is going in. The write is one
  `write_all` under the session lock, so it cannot interleave byte-wise already.
- No change to who may call which fleet tool beyond adding `fleet_wait` to the
  Conductor-only set.

### Tests

- `input_gate`: draft counting for plain text, UTF-8, backspace, Enter, Ctrl-C/U,
  bracketed paste, CSI-u keys; terminal replies are not typing; each `wait` branch.
- `PtyManager::write_machine` against a real PTY running `cat`: sent at once when quiet,
  delayed while a draft is open, `Held` when the limit passes.
- `fleet_news`: queue bound, coalescing, the hold/deliver decision per Conductor status,
  the note's text, ESC stripped.
- `fleet_mcp`: `fleet_send` refuses `needsInput` without `force`; `fleet_wait` returns on
  status change, on result, and on timeout; a worker may not call it.
- Persona test: mentions `fleet_wait` and the `<conduit-fleet>` note.
