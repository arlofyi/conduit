# `conduit` command session options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `conduit <path> --agent <id>` gains `--worktree <slug>`, `--name <text>` and `--prompt-file <file>`, so another tool can open a named session, in a worktree it named, with a first prompt.

**Architecture:** The shim forwards the three options in the existing token-authenticated `/open` body. Rust validates them and reads the prompt file, turning `OpenRequest` into an `OpenPayload` that carries the prompt text; the sink, the pending-open queue and the frontend take `OpenPayload`. The frontend passes name, worktree slug and prompt to `addSession`; the prompt rides the existing `pendingPrompts` path into `initial_prompt`.

**Tech Stack:** Rust (Tauri v2, tiny_http, serde), React 19 + TS + Zustand, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-28-cli-open-session-options-design.md`

## Global Constraints

- No new dependencies (Rust or JS).
- `/open` keeps its three layers: per-boot token, `Origin` refusal, no CORS preflight answer. Nothing here weakens them.
- Prompt file: absolute path, regular file, at most 64 KB (65536 bytes), UTF-8; anything else is a 400 and the sink never fires.
- Slug: `^[a-z0-9]+(-[a-z0-9]+)*$`, 1 to 60 chars; else 400.
- Name: trimmed, capped at 80 chars (chars, not bytes); empty after trim means "no name".
- `--worktree`, `--name`, `--prompt-file` without `--agent`: shim exits 2 with usage; Rust also rejects such a body (400).
- Shim marker becomes `conduit-cli-shim-v2`. `install`, `remove` and `status` recognise both v1 and v2; neither marker means "not ours", refused as today.
- Old v1 bodies (`{path}` / `{path, agent}`) still parse and behave exactly as before.
- Dev runs use `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev` (CLAUDE.md).
- Pre-PR checks from CONTRIBUTING.md: `cargo fmt`, `cargo clippy`, `cargo test`, `pnpm exec tsc --noEmit`, `pnpm test`.

## Review Focus

1. A name or path containing `"`, `\`, `$` or a newline reaches Rust intact and never breaks the shim's JSON (Task 3 test).
2. A prompt file that is a symlink to a regular file is accepted; a symlink to a directory or a FIFO is rejected without blocking (Task 1 test: `metadata` after following links, `is_file()`; never open a FIFO).
3. An open queued for a window that does not exist yet keeps its prompt and slug when drained by `take_pending_opens` (Task 1 changes the queue's type; Task 4 test drains a full payload).
4. `--worktree` on a path that is not a git work tree: session still opens, without a worktree, stderr note from the shim (Task 3 test) and `use_worktree` false (Task 2 test).
5. The prompt is consumed exactly once: reopening the session tab, or a restart, does not resend it (Task 4 test).

---

### Task 1: `OpenRequest` fields, validation and prompt reading

**Files:**
- Modify: `src-tauri/src/cli_open.rs`
- Modify: `src-tauri/src/hooks.rs` (sink receives `OpenPayload`)
- Modify: `src-tauri/src/window_registry.rs` (`PendingOpens` stores `OpenPayload`)
- Modify: `src-tauri/src/lib.rs` (`take_pending_opens` returns `Vec<cli_open::OpenPayload>`)

**Interfaces:**
- Produces:
  - `OpenRequest { path: String, agent: Option<String>, #[serde(default)] worktree: Option<String>, #[serde(default)] name: Option<String>, #[serde(default)] prompt_file: Option<String> }`
  - `OpenPayload { path: String, agent: Option<String>, worktree: Option<String>, name: Option<String>, prompt: Option<String> }` (Serialize + Deserialize + Clone + PartialEq), the shape emitted as the `cli-open` event and returned by `take_pending_opens`. JSON field names exactly as written (snake_case).
  - `pub fn resolve(req: OpenRequest) -> Result<OpenPayload, Reject>`: validates slug, name, agent-required rule; reads the prompt file.
  - `pub const MAX_PROMPT_BYTES: u64 = 65_536;`
  - `handle_open`'s sink type becomes `FnOnce(OpenPayload)`; `parse_open` still returns `OpenRequest` and `handle_open` calls `resolve` after it.

- [ ] **Step 1: Write failing unit tests in `cli_open.rs`'s `mod tests`**

```rust
#[test]
fn v1_bodies_still_resolve_unchanged() {
    let h = hdrs(&[("X-Conduit-Token", TOK)]);
    let req = parse_open(&h, r#"{"path":"/tmp/p","agent":"claude"}"#, TOK).unwrap();
    assert_eq!(resolve(req).unwrap(), OpenPayload { path: "/tmp/p".into(), agent: Some("claude".into()), worktree: None, name: None, prompt: None });
}

#[test]
fn options_without_agent_are_rejected() {
    for body in [r#"{"path":"/p","worktree":"fix-a"}"#, r#"{"path":"/p","name":"x"}"#, r#"{"path":"/p","prompt_file":"/tmp/x"}"#] {
        let req: OpenRequest = serde_json::from_str(body).unwrap();
        assert_eq!(resolve(req), Err(Reject::BadBody), "{body}");
    }
}

#[test]
fn slug_must_be_safe() {
    for bad in ["", "Fix-A", "fix_a", "-fix", "fix-", "fix--a", "../x", &"a".repeat(61)] {
        assert_eq!(resolve(req_with(|r| r.worktree = Some(bad.into()))), Err(Reject::BadBody), "{bad}");
    }
    assert_eq!(resolve(req_with(|r| r.worktree = Some("fix-push-main-01abcd".into()))).unwrap().worktree.as_deref(), Some("fix-push-main-01abcd"));
}

#[test]
fn name_is_trimmed_and_capped_by_chars() {
    let long = "é".repeat(100);
    let got = resolve(req_with(|r| r.name = Some(format!("  {long}  ")))).unwrap();
    assert_eq!(got.name.unwrap().chars().count(), 80);
    assert_eq!(resolve(req_with(|r| r.name = Some("   ".into()))).unwrap().name, None);
}

#[test]
fn prompt_file_is_read_and_checked() {
    let dir = tmpdir();
    let ok = dir.join("brief.md");
    fs::write(&ok, "Fix: push main\n").unwrap();
    assert_eq!(resolve(req_with(|r| r.prompt_file = Some(ok.display().to_string()))).unwrap().prompt.as_deref(), Some("Fix: push main\n"));

    let big = dir.join("big.md");
    fs::write(&big, vec![b'a'; 65_537]).unwrap();
    let not_utf8 = dir.join("bin.md");
    fs::write(&not_utf8, [0xff, 0xfe, 0x00]).unwrap();
    for bad in [dir.join("missing.md"), dir.clone(), big, not_utf8, PathBuf::from("relative.md")] {
        assert_eq!(resolve(req_with(|r| r.prompt_file = Some(bad.display().to_string()))), Err(Reject::BadBody), "{}", bad.display());
    }
}

#[cfg(unix)]
#[test]
fn prompt_file_symlinks_follow_but_fifos_are_refused() {
    // symlink -> regular file accepted; symlink -> dir and a mkfifo'd path rejected (and the test must not hang).
}
```

`req_with(f)` builds `OpenRequest { path: "/tmp/p", agent: Some("claude"), ..None }` and applies `f`; `tmpdir()` matches the existing `conduit-tok-<uuid>` pattern. Extend `handle_open_feeds_the_sink_and_answers_200` so its body includes `"name":"Fix: x","worktree":"fix-x"` and asserts both arrive on the `OpenPayload`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_open`
Expected: FAIL (compile errors: `resolve`, `OpenPayload` not found).

- [ ] **Step 3: Implement the fields, `OpenPayload`, `resolve`, and switch `handle_open`, the `hooks.rs` sink, `PendingOpens` and `take_pending_opens` to `OpenPayload`**

Prompt read: `fs::metadata` (follows links) must be `is_file()` and `len() <= MAX_PROMPT_BYTES` before opening, so a FIFO is never opened; then `fs::read` + `String::from_utf8`. Path must be absolute. Update the module doc comment's sink description.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, including existing `window_registry` and `tests/cli_open.rs`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli_open.rs src-tauri/src/hooks.rs src-tauri/src/window_registry.rs src-tauri/src/lib.rs
git commit -m "feat(cli): /open accepts worktree slug, session name and prompt file"
```

### Task 2: `add_session` takes an explicit worktree slug

**Files:**
- Modify: `src-tauri/src/store.rs` (new `Store::set_session_worktree_slug`)
- Modify: `src-tauri/src/lib.rs` (`add_session` command gains `worktree_slug: Option<String>`)

**Interfaces:**
- Consumes: `crate::worktree::{worktree_path, branch_name}`.
- Produces: Tauri command `add_session(..., worktree_slug: Option<String>)` (frontend passes `worktreeSlug`). `Store::set_session_worktree_slug(&self, session_id: &str, project_path: &str, slug: &str) -> Option<Session>` recomputes `worktree_path` and `branch` from the slug, saves, returns the updated session. Applied as a follow-up write, the same pattern the command already uses for `mcp_servers` and `model`, because `Store::add_session` has 40+ call sites.

- [ ] **Step 1: Write the failing test in `store.rs` tests**

```rust
#[test]
fn explicit_worktree_slug_replaces_the_derived_one() {
    let (store, pid, path) = store_with_project();
    let s = store.add_session(&pid, "Fix: push".into(), true, AgentId::Claude, SessionRole::Worker).unwrap();
    let s = store.set_session_worktree_slug(&s.id, &path, "fix-push-01abcd").unwrap();
    assert_eq!(s.worktree_path.as_deref(), Some(Path::new(&path).join(".claude/worktrees/fix-push-01abcd").to_str().unwrap()));
    assert_eq!(s.branch.as_deref(), Some("worktree-fix-push-01abcd"));
}

#[test]
fn explicit_slug_is_ignored_for_a_session_without_a_worktree() {
    // use_worktree false -> set_session_worktree_slug returns the session unchanged (worktree_path None)
}
```

Use whatever project fixture helper `store.rs` tests already use; name above is illustrative.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml explicit_worktree_slug`
Expected: FAIL (method not found).

- [ ] **Step 3: Implement `set_session_worktree_slug` and wire `worktree_slug` into the `add_session` command (only when `use_worktree` and the slug is `Some`)**

The command re-validates the slug with the same rule as Task 1 (share one `pub fn valid_slug(&str) -> bool` in `worktree.rs`, used by both).

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/store.rs src-tauri/src/lib.rs src-tauri/src/worktree.rs src-tauri/src/cli_open.rs
git commit -m "feat(sessions): add_session accepts an explicit worktree slug"
```

### Task 3: Shim v2 (sh and cmd), install/remove/status for both markers

**Files:**
- Modify: `src-tauri/src/cli_shim.rs`
- Modify: `src-tauri/tests/cli_open.rs`
- Modify: `src/components/GeneralSettings.tsx` (shows "Update" when outdated)

**Interfaces:**
- Produces: `SHIM_MARKER = "conduit-cli-shim-v2"`, `LEGACY_MARKERS: &[&str] = &["conduit-cli-shim-v1"]`. `ShimStatus` gains `outdated: bool` (true when the file carries a legacy marker; `installed` stays true for either). Usage line: `usage: conduit <path> [--agent <id>] [--worktree <slug>] [--name <text>] [--prompt-file <file>]`.
- Shim behaviour: `--prompt-file` is resolved to an absolute path in the shim (`cd "$(dirname "$f")" && pwd -P` + basename) and must exist as a file, else exit 1 with `conduit: not a file: <f>`. `--worktree` on a non-git path: shim prints `conduit: <path> is not a git work tree; opening without a worktree` to stderr and drops the slug. Name and paths JSON-escaped (backslash, double quote, and control chars including newline and tab) with the same `sed`-based escaping extended for `\n`/`\t`; the cmd variant gets the same flags.

- [ ] **Step 1: Write failing tests**

In `cli_shim.rs` tests:
```rust
#[test]
fn shims_carry_the_v2_marker_and_new_flags() {
    for t in [shim_sh(), shim_cmd()] {
        assert!(t.contains("conduit-cli-shim-v2"));
        for f in ["--worktree", "--name", "--prompt-file"] { assert!(t.contains(f), "{f}"); }
    }
}

#[test]
fn a_v1_shim_reads_as_installed_but_outdated_and_can_be_replaced_or_removed() {
    // write a file containing "conduit-cli-shim-v1" into a temp dir:
    // status_in -> installed true, outdated true; install_in succeeds and status_in -> outdated false;
    // write v1 again, remove_in succeeds; a file with neither marker: install_in and remove_in both Err.
}
```

In `tests/cli_open.rs` (real shim against the real handler, as today), add:
- `shim_forwards_name_worktree_and_prompt_file`: run the generated sh shim with `--agent claude --worktree fix-a --name 'He said "hi" $HOME \ ok' --prompt-file <tmp>/brief.md` against a git-initialised temp dir; assert the sink saw exactly that name, `worktree == Some("fix-a")`, and `prompt == Some(<file contents>)`.
- `shim_drops_worktree_outside_git`: same against a plain temp dir; stderr contains `is not a git work tree`; sink saw `worktree == None`.
- `options_without_agent_exit_2`: `--name x` alone exits 2, sink never fires.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test cli_open && cargo test --manifest-path src-tauri/Cargo.toml cli_shim`
Expected: FAIL.

- [ ] **Step 3: Implement shim v2 text (sh and cmd), legacy-marker handling, `outdated`, and the Settings button label ("Update command line tool" when `outdated`)**

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli_shim.rs src-tauri/tests/cli_open.rs src/components/GeneralSettings.tsx
git commit -m "feat(cli): shim v2 forwards --worktree, --name and --prompt-file"
```

### Task 4: Frontend applies the new payload

**Files:**
- Create: `src/cliOpen.ts` (moved `CliOpenPayload` and `applyCliOpenPayload` out of `App.tsx` so they can be tested)
- Create: `src/cliOpen.test.ts`
- Modify: `src/App.tsx` (imports from `./cliOpen`)
- Modify: `src/store.ts` (`addSession` opts gain `worktreeSlug?: string | null; prompt?: string | null`)

**Interfaces:**
- Consumes: `OpenPayload` JSON from Task 1; `add_session`'s `worktreeSlug` from Task 2.
- Produces: `export type CliOpenPayload = { path: string; agent?: string | null; worktree?: string | null; name?: string | null; prompt?: string | null }`; `export async function applyCliOpenPayload(payload: CliOpenPayload): Promise<void>`. `addSession` puts `prompt` into `pendingPrompts[session.id]` in the SAME `set()` that adds the session, so the Terminal's first `takePendingPrompt` always finds it.

- [ ] **Step 1: Write the failing test `src/cliOpen.test.ts`**

```ts
it("opens a named worktree session with its prompt pending exactly once", async () => {
  // mock invoke("add_session") to echo a session { id: "s1", name, useWorktree, worktreePath: ... }
  await applyCliOpenPayload({ path: "/repo", agent: "claude", worktree: "fix-a", name: "Fix: a", prompt: "brief" })
  expect(invokeMock).toHaveBeenCalledWith("add_session", expect.objectContaining({ name: "Fix: a", useWorktree: true, worktreeSlug: "fix-a" }))
  expect(useStore.getState().takePendingPrompt("s1")).toBe("brief")
  expect(useStore.getState().takePendingPrompt("s1")).toBeUndefined()
})

it("treats a v1 payload exactly as before", async () => {
  await applyCliOpenPayload({ path: "/repo", agent: "claude" })
  expect(invokeMock).toHaveBeenCalledWith("add_session", expect.objectContaining({ useWorktree: false, worktreeSlug: null }))
})

it("drained pending opens keep prompt and slug", async () => {
  // invoke("take_pending_opens") returns one full payload; the boot drain path applies it; same assertions as the first test
})
```

Follow the existing vitest mocking style for `@tauri-apps/api/core` used elsewhere in `src/*.test.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- cliOpen`
Expected: FAIL (module not found).

- [ ] **Step 3: Move the function, extend it to pass `name`, `useWorktree: !!worktree`, `worktreeSlug`, `prompt`; extend `addSession`**

- [ ] **Step 4: Run all checks**

Run: `pnpm exec tsc --noEmit && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
Expected: all PASS.

- [ ] **Step 5: Manual check in the dev build**

Run `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, install the shim from Settings, then in a git repo: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev conduit . --agent claude --worktree fix-try-000001 --name "Fix: try" --prompt-file /path/to/brief.md`. Expected: a session tab "Fix: try" opens, Claude starts in `.claude/worktrees/fix-try-000001`, and the brief is its first message. Remove that worktree afterwards with `git worktree remove`.

- [ ] **Step 6: Commit, and add a CHANGELOG line**

```bash
git add src/cliOpen.ts src/cliOpen.test.ts src/App.tsx src/store.ts CHANGELOG.md
git commit -m "feat(cli): conduit command opens named worktree sessions with a first prompt"
```
