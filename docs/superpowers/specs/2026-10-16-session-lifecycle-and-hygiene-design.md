# Session lifecycle, hook hygiene and storage: design and plan

Status: **implemented on `feat/session-lifecycle` (0.44.0).** Written 2026-10-16 after `MEMORY_FINDINGS.md`.
Decisions taken (section 7):

- Idle auto-stop defaults to 5 minutes after the agent finishes, and is a setting.
- Sessions waiting on you are not auto-stopped by default (a setting turns it on). They
  close on restart unless "also resume sessions that were waiting for me" is on.
- Only agents still mid-task resume at launch.
- Windows hooks go through a `.cmd` relay. Body-only session lookup was rejected because
  it cannot follow a `/clear`.
- The base is `build/0.43.0` + `origin/main` + `fix/codex-hooks-windows`.
- The existing NUL files and leftover per-session files were cleaned up.

## 0. Where the code stands versus upstream

Fetched 2026-10-16. Upstream `origin/main` (uziiuzair/conduit) is at `4276577`, released as
0.42.0 on 2026-10-12.

| Line | vs `origin/main` | Contents not upstream |
|---|---|---|
| `build/0.42.0` (current checkout, installed 0.42.1) | 16 ahead / 37 behind | 14 commits: Windows/Linux shortcuts, Hermes + OpenRouter + endpoint pool, live model switch, OpenRouter spend meter, Agent tab and skill editing, UI-thread perf, PTY spawn serialization |
| `build/0.43.0` (worktree folder deleted, branch kept) | superset of the above + 10 | Codex: honor routed model/effort, local rate-limit windows, stale-quota routing, served fleet models, launch-flag retry; IDE lock clippy fix; orchestration policy P1 (inert policy + context display) |
| `fix/codex-hooks-windows` | 3 commits in neither build line | Codex lifecycle hooks per launch, Windows cmd relay for Codex hooks |
| Open upstream PRs by you | #38 (windows-parity), #41 (Windows CI + profile windows), #42 (UI-thread perf) | All still open and unmerged |

Upstream's 37 new commits are all the Continuity view (graph, question cards, blocking
`/ask` route, live DB watch) plus an account-env-under-tmux fix (0.40.1). A trial merge of
upstream into `build/0.42.0` conflicts **only** in `CHANGELOG.md`, `package.json`,
`Cargo.toml`, `Cargo.lock` and `tauri.conf.json`. The code merges cleanly.

**Version collision.** Upstream shipped its own 0.41.0 and 0.42.0 with different contents,
while your local lines already used 0.42.0, 0.42.1 and 0.43.0. The next installer should be
**0.44.0** with a fresh `## Unreleased` changelog. Reusing 0.42.x or 0.43.0 would name two
different artifacts with one number.

**Proposed base for this work:** a new `feat/session-lifecycle` branch from `build/0.43.0`
with `origin/main` merged in, resolving only the version files and changelog. Optionally
fold in `fix/codex-hooks-windows`.

## 1. The NUL files, and a bigger bug behind them

**Cause (confirmed).** On Windows, Conduit's Claude hooks are written as cmd syntax
(`hooks.rs:1139-1146`):

`curl ... "http://127.0.0.1:PORT/hook?session=%CONDUIT_SESSION_ID%&event=X" >NUL 2>&1 || ver >NUL`

The code comment assumes Claude Code runs hooks through cmd.exe. It runs them through
**Git Bash**. In bash, `>NUL` creates a real file called `NUL` in the agent's current
directory, and the file contains `ok`, which is the hook server's reply. Evidence:

- `NUL` files exist in more than 20 folders under `CODE\`.
- `src-tauri\src\NUL` was created at 15:51:58 today, the minute this session's shell
  `cd`'d into that folder.

**Bigger bug (confirmed).** Bash does not expand `%CONDUIT_SESSION_ID%`, so the server
receives the literal text. `bash -c` printed `session=%CONDUIT_SESSION_ID%`, while cmd
printed the real ID. The provenance gate (`hooks.rs:325`) then drops the event as a
foreign session. Consequences on Windows:

- The status dots never move.
- The fleet `running` set stays empty, so the quit guard and "Stop idle sessions" cannot
  tell a working agent from an idle one.
- The SessionStart conversation capture after `/clear` never runs.
- Usage and to-dos never update.

The auto-close feature in section 2 depends on this status, so this fix comes first.

**Fix.**

1. **Make the command shell-neutral.** Use no shell redirection, no `||` and no `%VAR%` in
   the string:

   `curl -s -m 2 -o NUL -X POST -H "Content-Type: application/json" --data-binary @- "http://127.0.0.1:PORT/hook?event=X"`

   Here `-o NUL` is opened by curl itself through the Windows API, so it is the null device
   under either shell. `-s` keeps errors quiet.
2. **Identify the session server-side** without needing the env var. Claude puts
   `session_id` (its conversation id) and `cwd` in every hook body. Resolve it with
   `store.session_for_conversation`, plus the pinned `--session-id`, which equals the Conduit
   id until a `/clear`. Keep the provenance gate: an id that maps to no Conduit session is
   still dropped.
   - *Alternative:* point hooks at a generated `ConduitTauri\hook.cmd <event>`. Both shells
     can run a `.cmd`, and inside it cmd expands `%CONDUIT_SESSION_ID%` correctly. It costs
     one extra `cmd.exe` per hook.
3. **Accept the old command form.** `is_conduit_entry` must keep matching the old command
   so installs replace it and never stack a second copy. Add a test for exactly that. The
   POSIX form is unchanged.
4. **Clean up existing files.** A one-time sweep of `NUL` files containing exactly `ok` in
   project roots Conduit knows about. Opt-in, listed before anything is deleted.
5. **Same bug elsewhere:**
   - `hooks.rs:750` (`.conduit\result.cmd`) runs under cmd via `call`, so it is fine.
   - The continuity plugin's hooks are `node` argv, so they are fine.
   - Codex hooks are already handled on `fix/codex-hooks-windows`.

**Verify.**

- Unit tests for the command string and for body-based session resolution.
- Manual check: run a session, confirm the status dot moves, confirm `fleet_list` shows
  `running`, and confirm no new `NUL` file appears.

## 2. Session lifecycle: close idle agents, start lazily, resume only what was working

**Rationale.** The process is disposable and the conversation is not; Claude resumes it
with `--resume`. This matches Anthropic's Managed Agents design (session as a durable event
log, harness and sandbox swappable), from the AI Engineer base, talk
`anthropic-eng.managed-agents`, speaker Lance Martin. There is also a cost argument (my
knowledge, not from the base): prompt caching expires after about 5 minutes (1 hour if
extended), so an agent idle longer than that pays the same to resume as to keep alive. Only
RAM differs, about 0.85 GB per session measured.

**Measured today.** Conduit restarted at 22:16 and relaunched 10 sessions within a minute,
8.7 GB total, of which the UI was 1.17 GB.

**Behaviour.**

1. **Launch.**
   - No session spawns automatically, except those recorded as working at the last shutdown.
   - Every other session shows its scrollback snapshot and "stopped, click to resume".
   - The setting "Restore sessions when opening a project" changes meaning to "Resume
     sessions that were working when Conduit closed" (default on). The old
     "spawn everything" behaviour stays available as an explicit choice.
2. **Shutdown or restart.**
   - Normal quit, last window close, update install and crash must all leave the same state.
   - At `ExitRequested`, record `Session.resume_on_launch = true` for sessions the fleet
     reports `running` (cross-checked against a live PTY, as `live_running_agent` does).
     All others are false.
   - At launch, every session without the flag is treated as `stopped`.
   - Crash and update paths cannot run cleanup, so also write the flag continuously: set it
     on `pretool`/`prompt`, clear it on `stop`/idle. The last write before a crash is then
     already correct.
3. **Idle auto-close.**
   - Candidates:
     - status is `done` or `idle`;
     - not `needsInput` (waiting on you is not "finished");
     - no diff review open;
     - no PTY output or input for T minutes;
     - not one of the panes on screen, or allowed after a longer T2.
   - Action: retire through the existing `stop_session` path. It tree-kills on Windows,
     keeps the scrollback and resumes on click.
   - A visible "Auto-stopped after N min idle" line goes into the pane.
   - A setting, with the threshold editable.
4. **Resuming a session that was working.**
   - `claude --resume` restores the conversation but not the in-flight turn.
   - Options: just reopen it, or reopen and offer a one-click "continue" (never auto-typed;
     see section 7).
5. **Background processes.**
   - A retire kills dev servers or watchers the agent started.
   - Option: skip auto-close while the agent's process subtree holds anything other than its
     MCP servers. Detectable from the same process snapshot the measure script uses.

**Where.**

- Store: `Session.resume_on_launch` (`#[serde(default)]`; Rust round-trip test, per the
  orphan-sweep rule).
- Status writes: hooks status path.
- Launch gate: `Terminal.tsx` eager effect (`:689-703`).
- Exit hook: `lib.rs:3365`.
- Idle policy: as a pure, tested function (`idle_close_targets(now, sessions, activity,
  visible, status)`), driven by a 60 s timer.
  - Rust needs a last-activity timestamp per PTY (reader and `write()` update an atomic).
  - The frontend sends visibility, or Rust reads the layout.
  - macOS: the same policy applies. Retire also kills the tmux session there, which is what
    frees memory.
- Windows also needs the updater before-exit hook (`lib.rs:2914`) to call `kill_all` after
  writing the flags.

**Mounted terminals.** About 79 sessions are in your sidebar (one scrollback snapshot each
survives the startup sweep). Every one keeps a mounted xterm with 5,000 lines and a WebGL
context attempt, running or not (`WorkspaceCenter.tsx:321-324`).

- Mount a terminal only once it has spawned or has a snapshot to show, then never unmount
  it. That still honours the keep-alive rule: the rule protects live PTYs, not panes that
  never had one.
- Attach WebGL only while a pane is visible.

## 3. Claude working on C:\ instead of the project folder

**What Conduit controls, and what it gets wrong today:**

- **Agent sessions.** Spawned with an explicit cwd, the project or worktree
  (`pty.rs:498`). Conduit passes no permission-bypass flag anywhere.
- **Titler.** `claude -p` with **no cwd** (`lib.rs:2353`). It inherits Conduit's own working
  directory: `C:\Program Files\Conduit`, or `C:\WINDOWS\system32` when an update or the MSI
  relaunched Conduit. It also writes a transcript there and loads every MCP server.
- **Root chat.** Defaults to your **home directory** when no workspace root is set
  (`root_chat.rs:56`).
- **Account-pinned sessions.** `HOME` and `USERPROFILE` are set to the profile folder
  (`agent.rs:194-208`, confirmed in this session). So `~` in Bash, `.gitconfig` lookups and
  any tool writing to "home" land in `.claude-split\<profile>`, not your real home.
- **Bash tool.** Claude Code's Bash runs in Git Bash, where `/` is `C:\Program Files\Git`
  and `cd` persists between commands. A `cd /` or `cd ~` moves the agent away from the
  project for the rest of the session.

**Plan.**

1. At startup, set Conduit's own process cwd to its data dir, so nothing can inherit
   System32 or Program Files.
2. Give the titler an explicit scratch cwd. Also add `--strict-mcp-config`, a timeout with
   tree kill, and `--no-session-persistence` if `claude --help` confirms the flag.
3. Root chat: require or ask for a workspace root instead of silently using home.
4. Refuse to spawn if the session dir does not exist, with a visible error, instead of any
   fallback.
5. Set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` in Claude's spawn env. This documented
   Claude Code variable returns Bash to the project dir after every command.
6. **Optional project fence.** Conduit already receives `PreToolUse`. It could deny Write,
   Edit and NotebookEdit targeting paths outside the session's project, worktree and an
   allowlist (the data dir, `%TEMP%`). The hook would need to return stdout, and the current
   Windows command discards it. This is a policy layer; real isolation (container or
   restricted user) is what the AI Engineer base calls a coding-agent sandbox, and is out of
   scope here.

**To confirm the actual cause:** I need to list the transcript folder names under your
other profiles' `.claude\projects` (default, IOTA, Voxera). Folders named `C--`,
`C--WINDOWS-system32`, `C--Program-Files-Conduit` or `C--Users-UsmanKaisser` would show
which path started Claude outside a project. The Arlo profile has only the three project
folders. Those paths are outside this profile's allowed reads, so I need your OK.

## 4. More memory and storage savings found

| # | Finding | Fix | Size |
|---|---|---|---|
| a | 155 `spawn-<id>.cmd`, 57 `conductor-persona-*`, 60 `conductor-mcp-*` in `%APPDATA%\ConduitTauri`; about 76 belong to deleted sessions. Only scrollback is swept. | Delete per-session files on destroy; startup sweep against the store, like `scrollback::sweep`. | Clutter (KBs each) |
| b | Scrollback rewritten every 20 s per live terminal even when unchanged (`lib.rs:3150`). 47 snapshots were written today. | Generation counter in `RingBuffer`; skip unchanged. | Up to ~1 GB/day of writes per busy terminal |
| c | Titler: a full `claude` + all MCP servers per new session, plus a transcript per title. | Item 3.2. | ~0.5 GB transient each |
| d | MCP servers per session: 3 servers = 9 processes, 165 MB. | Project-level MCP allowlist (reuses the per-session machinery). Later, a shared local endpoint per server: the MCP-gateway pattern in the AI Engineer base, one streamable-HTTP endpoint fronting many servers. | ~110 to 165 MB per session |
| e | Unspawned sessions mounted as terminals (79 here). | Item 2, "Mounted terminals". | Large part of the 1.17 GB UI |
| f | WebGL context per pane; GPU process 0.5 GB. | Visible panes only; measure with the Canvas setting first. | Up to ~0.5 GB |
| g | Root chat Stop kills only `cmd.exe`; `claude -p` runs on. Not covered by `kill_all`. | Tree kill. | Correctness |
| h | Crash or End task leaves no cleanup (no Job Object). | Per-session Job Object (`KILL_ON_JOB_CLOSE`). | Orphan prevention |
| i | WebView2 profile: 255 MB (Code Cache 115 MB, Cache 57 MB). | Optional: clear code cache after an update. | Disk |
| j | Each hook spawns bash + curl on every tool call (`PreToolUse` and `PostToolUse` both). | Keep it, but share one relay or fold `pretool` into `tooluse` where status allows. | CPU and Defender scans |

## 5. Order of work

1. **Sync and branch** (section 0). No behaviour change.
2. **Hook fix** (section 1). Unblocks reliable status. Small, high value.
3. **cwd hardening + titler** (3.1 to 3.5, item 4c). Small.
4. **Lifecycle** (section 2): launch gate + `resume_on_launch`, then idle auto-close, then
   lazy mounting.
5. **Storage hygiene** (4a, 4b, 4g). Small.
6. **Bigger items** (4d project allowlist, 4f WebGL, 4h Job Objects, 3.6 fence). Each gets
   its own spec.

Every step is checked with `pnpm exec tsc --noEmit`, `pnpm test`, cargo fmt/clippy/test, and
`scripts/measure-sessions.ps1` before and after. UI changes are verified by running the dev
build under `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`.

## 6. Risks

- **Auto-close kills background processes the agent started**: mitigated by the subtree
  check and a setting.
- **Body-based session resolution** must never accept a foreign Claude in the same folder.
  It only maps ids already recorded on Conduit sessions.
- **Changing the hook command rewrites `.claude/settings.local.json`** in every project
  (it already does on every spawn); old entries must be replaced, not duplicated.
- **Resume after a crash** relies on the flags written continuously during work.

## 7. Decisions needed

1. Idle threshold: how long after the agent finishes before auto-close (e.g. 30 min)? Also
   close sessions on screen (after a longer time), or never?
2. Close sessions waiting on you (`needsInput`), or keep them alive?
3. Sessions that were working at shutdown: just reopen, or reopen and offer "continue"?
4. Hook session identity: body-based lookup (no extra process) or the `hook.cmd` relay?
5. Base: `build/0.43.0` + upstream, and include `fix/codex-hooks-windows`?
6. May I list the transcript folder names in your other Claude profiles to pin down the
   C:\ cause?
7. Clean up the existing `NUL` files and leftover per-session files, list first?
