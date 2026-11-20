# Conduit Code Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conduit Code (`conduit-code`, `@conduitcode/cli`) is an eighth agent in Conduit, resumed by the id it reports and showing live status.

**Architecture:** A `ConduitCodeAdapter` on the existing `ProviderAdapter` seam; the Command Code `sessionstart` id capture in `hooks.rs` is widened to it. The CLI reports its own lifecycle to Conduit's `/hook` server when `CONDUIT_SESSION_ID` is set, so Conduit installs no hook file for it.

**Tech Stack:** Rust (Tauri backend), TypeScript/React (desktop), Expo TS (mobile), TypeScript/Ink (the CLI, separate repo).

**Spec:** `docs/superpowers/specs/2026-11-20-conduit-code-agent-design.md`

## Global Constraints

- Wire id is exactly `conduitcode`; label exactly `Conduit Code`; binary `conduit-code`; install command `npm install -g @conduitcode/cli`.
- Conduit writes nothing under `~/.conduit`. No scan of `~/.conduit/sessions`.
- Never emit `--trust`. Never emit a prompt argument (the CLI has none).
- No version bump. CHANGELOG bullet goes under `## Unreleased`.
- Commits: Conventional Commits, no AI attribution trailer.
- Windows leg compiles a different program: no `#[cfg]`-gated code is added by this plan.
- Pre-PR checks from CONTRIBUTING.md must pass: `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`; mobile `tsc` + `jest`.

## Review Focus

- A `state.json` holding `"conduitcode"` read by this build must round-trip, and an older build must degrade it to Claude (already the lenient rule; the round-trip test must list the new id).
- A stale resume id (session deleted under `~/.conduit/sessions`) must still open a usable terminal: the `|| conduit-code<flags>` fallback.
- Two Conduit sessions must never hold one Conduit Code session id (`conversation_id_in_use`).
- A `sessionstart` with `source: "resume"` must not replace the held id; one with `"startup"` must.
- An older CLI that reports nothing: no error, no status, fresh start each launch.
- The CLI outside Conduit (`CONDUIT_SESSION_ID` unset) must make zero network calls.

---

### Task 1: The Rust adapter and id capture

**Files:**
- Modify: `src-tauri/src/agent.rs` (enum, `from_wire`, `default_profile_dir`, new adapter after `HermesAdapter`, `adapter_for`, `all_adapters`, label table, `capability_card`, tier test)
- Modify: `src-tauri/src/hooks.rs` (the `sessionstart` Command Code arm, ~line 432)
- Modify: `src-tauri/src/store.rs` (enum round-trip test, ~line 5150)
- Modify: `src-tauri/src/fleet_mcp.rs:71` (the `agent` enum list)
- Modify: any other `match` on `AgentId` the compiler reports as non-exhaustive

**Interfaces:**
- Produces: `AgentId::ConduitCode` (wire `"conduitcode"`), `pub struct ConduitCodeAdapter`, `pub fn captures_conversation_from_sessionstart(agent: AgentId) -> bool` in `hooks.rs` (true for `CommandCode` and `ConduitCode` only).

- [ ] **Step 1: Write failing tests in `agent.rs`**

```rust
#[test]
fn conduit_code_resumes_by_the_id_it_reported_and_falls_back_bare() {
    let a = ConduitCodeAdapter;
    assert_eq!(a.binary(), "conduit-code");
    assert_eq!(a.install_command().as_deref(), Some("npm install -g @conduitcode/cli"));
    assert_eq!(a.build_invocation("s", None, "", None, None), "conduit-code");
    assert_eq!(
        a.build_invocation("s", None, " --model x", None, Some("abc-1")),
        "conduit-code --model x --resume 'abc-1' || conduit-code --model x"
    );
}

#[test]
fn conduit_code_never_puts_a_prompt_or_trust_on_the_command_line() {
    let cmd = ConduitCodeAdapter.build_invocation("s", None, "", Some("'do it'"), Some("id"));
    assert!(!cmd.contains("do it") && !cmd.contains("--trust"), "{cmd}");
}

#[test]
fn conduit_code_flags_and_seams() {
    let a = ConduitCodeAdapter;
    assert!(a.supports_worktree() && a.supports_model_flags());
    assert_eq!((a.model_flag(), a.effort_flag()), ("--model", "--effort"));
    assert_eq!(a.model_switch_command("m", None, None).as_deref(), Some("/model m"));
    assert!(a.hooks_profile().is_none() && a.plugin_profile().is_none());
    assert!(a.project_mcp_config_rel_path().is_none());
    assert_eq!(AgentId::from_wire("conduitcode"), Some(AgentId::ConduitCode));
}
```

Quote form: use whatever `crate::pty::quote_arg("abc-1")` returns; fix the literal in the test to match if it is not single quotes. Add `(AgentId::ConduitCode, 2)` to `expected_tiers`, and `AgentId::Hermes, AgentId::ConduitCode` to the `store.rs` round-trip list. In `hooks.rs` tests:

```rust
#[test]
fn only_agents_that_choose_their_own_id_have_it_captured_from_sessionstart() {
    use crate::agent::AgentId::*;
    for a in [CommandCode, ConduitCode] { assert!(captures_conversation_from_sessionstart(a)); }
    for a in [Claude, Codex, Gemini, OpenCode, Antigravity, Hermes] {
        assert!(!captures_conversation_from_sessionstart(a));
    }
}
```

- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml conduit_code` — Expected: compile failure, `ConduitCodeAdapter` not found.

- [ ] **Step 3: Implement.** Adapter mirrors `CommandCodeAdapter::build_invocation` with `--resume` and no prompt. Capability card: `"agent": "conduitcode"`, tier 2, `structuredResult: false`, `mailbox: false`; `whenToUse` names its per-job model routing across Claude, GLM, local and OpenRouter models; `whenNotToUse` says no `fleet_result`, and that it takes no prompt on the command line so a dispatched brief is not delivered. `default_profile_dir` → `Some(".conduit")`. `model_for_tier` → `None`. In `hooks.rs` replace the `== AgentId::CommandCode` test with the new predicate; the body is unchanged.

- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` and `cargo fmt --manifest-path src-tauri/Cargo.toml --check` — Expected: all pass.

- [ ] **Step 5: Commit** `feat(agents): Conduit Code adapter`

### Task 2: Desktop and phone agent lists

**Files:**
- Modify: `src/agents.ts`, `src/components/AgentGlyph.tsx` (only if it holds a per-agent exhaustive map), `src/usageRows.ts` / `src/store.ts` / `Settings.tsx` / `AccountList.tsx` / `RoutingPanel.tsx` (only where `tsc` reports a non-exhaustive `Record<AgentId, …>`)
- Modify: `mobile/src/logic/agents.ts`, `mobile/src/logic/chatList.ts` (if it lists agents)
- Modify: `CHANGELOG.md`, `README.md` agent list if one exists
- Test: `src/agents.test.ts` (create if absent), `mobile/src/logic/agents.test.ts`

**Interfaces:**
- Consumes: wire id `conduitcode` from Task 1.
- Produces: `AGENTS` entry `{ id: "conduitcode", label: "Conduit Code", … }` — letter `"C"` (Claude draws a brand mark, so the monogram is free), tint `"#4fb3bf"`, `supportsWorktree: true`, `supportsMcp: false`, `supportsModelFlags: true`, `effortLevels: CLAUDE_EFFORT`, no `supportsEndpoint`, no `models`.

- [ ] **Step 1: Failing test** in `src/agents.test.ts`:

```ts
it("lists Conduit Code with the flags its CLI really takes", () => {
  const a = agentMeta("conduitcode");
  expect(a).toMatchObject({ label: "Conduit Code", supportsWorktree: true, supportsMcp: false, supportsModelFlags: true });
  expect(a.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(a.supportsEndpoint).toBeFalsy();
});
```

The mobile `agents.test.ts` already pins the phone list against the desktop file; it fails by itself once the desktop entry exists.

- [ ] **Step 2: Run** `pnpm test -- agents` — Expected: FAIL (`"conduitcode"` is not an `AgentId`).
- [ ] **Step 3: Implement** the entries; fix every site `pnpm exec tsc --noEmit` reports. `PHONE_CHAT_AGENTS` is not changed. Add the CHANGELOG bullet: `- **Added — Conduit Code as an agent.** Start Conduit Code (\`npm install -g @conduitcode/cli\`) sessions from the new-session dialog with a model and effort; a session resumes its own conversation after a restart once the CLI reports its session to Conduit.`
- [ ] **Step 4: Run** `pnpm exec tsc --noEmit && pnpm test && pnpm build`, then in `mobile/`: `pnpm exec tsc --noEmit && pnpm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(agents): list Conduit Code on desktop and phone`

### Task 3: CLAUDE.md section

**Files:** Modify `CLAUDE.md` — add "Where Conduit Code lives" after "Where Hermes Agent lives".

- [ ] **Step 1:** Record: id is captured from `sessionstart` (same arm as Command Code, one predicate); no hook file is written because the CLI reports itself from the env; no prompt argument exists; Tier 2 and why; the `conduit` bin collision with the shim and that it is unresolved; `--trust` deliberately not passed.
- [ ] **Step 2: Commit** `docs(agents): where Conduit Code lives`

### Task 4: The CLI reporter (repo `~/ooozzy/Experiments/conduit-code`, worktree `.claude/worktrees/conduit-app-report`, branch `feat/conduit-app-report`)

**Files:**
- Create: `src/conduit-app/report.ts`, `src/conduit-app/report.test.ts`
- Modify: the place the TUI consumes `AgentEvent`s and opens/answers a permission prompt (`src/tui/App.tsx`), and the exit path in `src/cli.tsx`

**Interfaces:**
- Produces:

```ts
export type Verb = "sessionstart" | "prompt" | "notification" | "pretool" | "stop" | "stopfailure" | "sessionend"
export type Reporter = { send(verb: Verb, body?: Record<string, unknown>): void }
/** null when CONDUIT_SESSION_ID is unset or no port can be found. */
export function createReporter(env: NodeJS.ProcessEnv, deps?: { fetch?: typeof fetch; readFile?: (p: string) => string }): Reporter | null
/** The verb and body an AgentEvent stands for, or null. `resumed`: this run was started with --resume. */
export function eventReport(ev: AgentEvent, resumed: boolean): { verb: Verb; body: Record<string, unknown> } | null
```

- [ ] **Step 1: Failing tests** (`report.test.ts`):
  - `createReporter({})` is `null`; with `CONDUIT_SESSION_ID=s1, CONDUIT_HOOK_PORT=8423` a `send("stop")` calls fetch once with URL `http://127.0.0.1:8423/hook?session=s1&event=stop`, method `POST`, body `{}`.
  - `CONDUIT_HOOK_ENDPOINT` naming a file containing `CONDUIT_HOOK_PORT=8430` wins over the env port `8423`; an unreadable file falls back to the env port.
  - A rejecting fetch and a throwing fetch do not throw out of `send`.
  - A session id needing escaping is URL-encoded.
  - `eventReport({type:"init", sessionId:"abc", …}, false)` → `sessionstart` `{session_id:"abc", source:"startup"}`; with `true` → `source:"resume"`.
  - `turn_result` ok → `stop` `{}`; not ok with `subtype:"error_max_turns"` → `stopfailure` `{error:"error_max_turns"}`; `text_delta` → `null`.

  Read the real endpoint file format from `hook-endpoint.sh` in Conduit's data dir (it is a `sh` file exporting `CONDUIT_HOOK_PORT`) and parse `CONDUIT_HOOK_PORT=<digits>` from it by regex; never execute it.

- [ ] **Step 2: Run** `pnpm vitest run src/conduit-app` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** `send` uses `fetch` with `AbortSignal.timeout(2000)`, swallows everything, and does not await. Wire: every `AgentEvent` through `eventReport`; `prompt` when the user submits a message; `notification` `{notification_type:"permission_prompt"}` when a permission request is shown and `pretool` `{}` when it is answered; `sessionend` on exit.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: pass. Also `architecture.test.ts` must still pass (it constrains imports between layers; place the module where it allows).
- [ ] **Step 5: Commit** `feat(conduit-app): report session lifecycle to the Conduit desktop app`

### Task 5: End to end

- [ ] **Step 1:** In the Conduit worktree run a throwaway hook listener is not needed: start a `python3 -m http.server`-style one-file listener on a free port in the scratchpad that logs request lines and bodies.
- [ ] **Step 2:** Run the CLI branch build with `CONDUIT_SESSION_ID=test-1 CONDUIT_HOOK_PORT=<port>` in a non-git temp dir, send one prompt, quit. Expected log, in order: `sessionstart` with a uuid `session_id` and `source: startup`, `prompt`, `stop`, `sessionend`. Run again with `--resume <that id>`: `source: resume`.
- [ ] **Step 3:** Report results as measured. The Conduit GUI itself is not launched (the installed app is running; a dev build needs `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev` and the founder's go-ahead).
