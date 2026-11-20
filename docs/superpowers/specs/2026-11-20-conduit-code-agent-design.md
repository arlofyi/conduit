# Conduit Code as an agent

Date: 2026-11-20. Size: a small change (an eighth adapter on an existing seam), plus a
small reporter in the Conduit Code CLI repo.

## Intent

Conduit Code (`npm install -g @conduitcode/cli`, binary `conduit-code`) is the founder's own
TUI coding harness. It should be a first-class agent in Conduit: startable from the new
session dialog, resumed on restart, with a working status dot.

## Facts measured (CLI 0.1.1 source and `conduit-code --help`)

- `--resume <session-id>` continues a session. There is no `--session-id`, so Conduit
  cannot pin its own id; the id is the CLI's.
- The id `--resume` takes is the PROVIDER's session id (the `init` event's `sessionId`),
  not the name of the CLI's own record folder under `~/.conduit/sessions/`. `--resume`
  continues Claude-backed sessions only; another target warns and starts fresh. The
  provider announces the id only once the first turn is under way.
- `--model <id>` and `--effort low|medium|high|xhigh|max`, spelled as Claude spells them.
  `/model` switches mid-session.
- No positional prompt and no prompt flag.
- No worktree manager of its own.
- It reads no external hook config and never reads `~/.claude`. Its hooks are in-process.
- It reads `<repo>/.mcp.json` only once the repo is trusted, and `~/.conduit/mcp.json`.
  There is no `mcp add` subcommand.
- `CONDUIT_HOME` moves its config root (`~/.conduit`).
- The npm package installs TWO bins: `conduit-code` and `conduit`. `conduit` is also the
  name of Conduit's own CLI shim.

## Approaches

1. **The CLI reports itself (chosen by the founder).** When `CONDUIT_SESSION_ID` is in its
   environment, `conduit-code` POSTs lifecycle events to Conduit's hook server. The session
   id arrives in the same request as Conduit's session id, so resume is exact, and status
   is real. Costs a change in the CLI repo and an npm publish.
2. **Conduit-only.** Scan `~/.conduit/sessions` against a spawn-time baseline, as agy does,
   and show no status. No CLI change, but two sessions started together can cross-capture
   and a session never reads as running.
3. **Screen rules.** Rejected: there is no measured rule file for this TUI, and writing our
   own patterns is what that module exists to avoid.

The Conduit half ships first. With an older CLI that reports nothing, a session starts
fresh on every launch and shows no status ring; nothing errors.

## Design: Conduit side

- `AgentId::ConduitCode`, wire id `conduitcode`, label "Conduit Code". Added to
  `from_wire`, `adapter_for`, `all_adapters`, the label table, the lenient-enum round-trip
  test, `src/agents.ts`, `mobile/src/logic/agents.ts`, and `default_profile_dir`
  (`.conduit`).
- `ConduitCodeAdapter`: binary `conduit-code`; install command
  `npm install -g @conduitcode/cli`; `supports_worktree` false (that flag means "takes
  Claude's `--worktree`", which this CLI rejects; the dialog's worktree box stays
  Claude-only, and a fleet worker still gets a Conduit-made worktree); `supports_model_flags` true
  with the default `--model` / `--effort`; `model_switch_command` is `/model <id>`.
- `build_invocation`: with a resume token,
  `conduit-code<flags> --resume <id> || conduit-code<flags>`; without one, a single bare
  invocation. Same shape and same reason as Command Code. No prompt argument is ever
  emitted (the CLI has none); an initial prompt goes through the existing paste path.
- **Id capture:** the `sessionstart` arm in `hooks.rs` that serves Command Code is widened
  to Conduit Code. Same rule: `source != "resume"` replaces the held id, and an id another
  session owns is refused.
- No `hooks_profile` and no `plugin_profile`: Conduit writes no file for this agent. The
  CLI finds the hook server from the environment Conduit already exports
  (`CONDUIT_SESSION_ID`, `CONDUIT_HOOK_PORT`, `CONDUIT_HOOK_ENDPOINT`).
- Capability card: Tier 2. `structuredResult` and `mailbox` stay false until a Conduit Code
  worker is verified against the fleet MCP server. No routing default names it yet.
- Frontend: tint and letter glyph "C" variant distinct from Claude and Codex (no brand
  mark shipped, so `AgentGlyph` falls back to the letter); `supportsMcp` false;
  `supportsEndpoint` false; effort levels `low, medium, high, xhigh, max`.
- Phone: listed and labelled, not offered in the phone's "new chat" (it offers only the
  agents whose chat it can render).
- CHANGELOG: one `Added` bullet under `## Unreleased`. No version bump.

## Design: CLI side (`Experiments/conduit-code`, own branch and worktree)

A reporter that is inert unless `CONDUIT_SESSION_ID` is set. It POSTs JSON to
`http://127.0.0.1:<port>/hook?session=<CONDUIT_SESSION_ID>&event=<verb>`, port from the
file `CONDUIT_HOOK_ENDPOINT` names when readable, else `CONDUIT_HOOK_PORT`.

| When | verb | body |
| --- | --- | --- |
| `init` event | `sessionstart` | `{session_id, source: "startup" \| "resume"}` |
| a prompt is sent | `prompt` | `{}` |
| a permission prompt opens | `notification` | `{notification_type: "permission_prompt"}` |
| the permission is answered | `pretool` | `{}` |
| `turn_result`, ok | `stop` | `{}` |
| `turn_result`, not ok | `stopfailure` | `{error: <subtype>}` |
| the app exits | `sessionend` | `{}` |

As built (CLI branch `feat/conduit-app-report`, `src/conduit-app/report.ts`), with three
additions to the table: `prompt` carries the first 500 characters of the prompt (Conduit
names the session from it), each tool start sends `pretool` `{tool_name}`, and a
`sessionstart` that lands mid-turn is followed by a repeated `prompt`, because Conduit
reads a session start as "not working". `source` is `resume` only when the announced id
equals the `--resume` value. A secret prompt sends `notification`
`{notification_type: "elicitation_dialog"}`.

Measured 2026-11-20 against a local listener, one haiku turn then a resumed one:
`prompt`, `sessionstart` (`startup`), `prompt`, `stop`, `sessionend`; resumed run identical
with `source: "resume"` and the same id.

Fire and forget, 2 s timeout, every failure swallowed: a status report must never break
the work it reports. No token is involved; `/hook` is display data behind the provenance
gate.

## Non-goals

- Accounts (`CONDUIT_HOME` redirect), a usage meter, the Agent tab, MCP management, the
  per-session MCP allowlist, fleet Tier 1.
- Passing `--trust`. Trusting a repo is the user's call, as it is with Claude.

## Anti-goals

- Conduit writing anything under `~/.conduit`. That directory is machine-wide.
- A scan of `~/.conduit/sessions`. If the CLI does not report, there is no resume.

## Open issue, not solved here

`@conduitcode/cli` installs a bin named `conduit`. Where npm's bin directory precedes
Conduit's shim on `PATH`, `conduit run`, `conduit report` and `conduit .` start the TUI
instead. Conduit's shim installer already refuses to overwrite a `conduit` it did not
write. The clean fix is in the package (drop the `conduit` bin); that is the founder's
decision and a breaking change for anyone using that name.

## My calls (not the founder's)

Wire id `conduitcode`; Tier 2; no routing default; no `--trust`; lifecycle verbs posted
directly rather than through `event=report` (the `sessionstart` body has to carry the id,
which a report cannot); phone lists but does not spawn.

## Left to the builder

The exact tint; where in the CLI the reporter subscribes (the `AgentEvent` stream and the
permission prompt); how an initial prompt is delivered to an agent with no prompt argument
if the existing paste path does not already cover it.
