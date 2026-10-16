# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repo. For human-facing
setup and architecture, see [README.md](./README.md) and
[CONTRIBUTING.md](./CONTRIBUTING.md) — this file captures the agent-specific workflow
and the gotchas that bite.

## What this is

Conduit — a Tauri v2 desktop app that runs multiple real `claude` CLI sessions side by
side. **Frontend:** React 19 + TypeScript in `src/` (state in `src/store.ts`, Zustand,
no Redux). **Backend:** Rust in `src-tauri/src/` (Tauri commands registered in
`lib.rs`). The README's "How it works" table is the file map — read it first.

## Commands

```bash
pnpm install
pnpm tauri dev                                       # run the app (dev)
pnpm exec tsc --noEmit                               # typecheck the frontend
pnpm build                                           # tsc + vite production build
cargo test   --manifest-path src-tauri/Cargo.toml    # Rust unit tests
cargo fmt    --manifest-path src-tauri/Cargo.toml    # format Rust
cargo clippy --manifest-path src-tauri/Cargo.toml    # lint Rust
```

Run the same pre-PR checks listed in CONTRIBUTING.md before claiming work is done.

### Running the dev app SAFELY (important)

A Conduit build reads/writes `~/Library/Application Support/ConduitTauri/state.json`. If
the **installed** Conduit.app is also running, a plain `pnpm tauri dev` shares that file
and **clobbers its project/session state**. Always isolate the dev build with the data-dir
override (read in `src-tauri/src/store.rs`):

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

This writes to `…/ConduitTauri-dev/state.json`, so dev and the installed app coexist.

## Testing reality

- **Rust** has `#[cfg(test)]` unit tests. Add tests for any new pure logic (parsers,
  helpers) and run `cargo test`. Prefer testing pure functions over wiring.
- **The frontend has a vitest suite** (`pnpm test`, `vitest.config.ts`, node env).
  Convention is **colocated**: `src/foo.ts` is tested by `src/foo.test.ts`. Add tests for
  new pure logic here the same way you would in Rust.
- **`.github/workflows/ci.yml` runs all of it** on every PR and push to `main` —
  typecheck + `pnpm test` + `pnpm build` on one job, `cargo fmt --check` + `cargo clippy
  -D warnings` + `cargo test` on another. Clippy is strict; fix the lint rather than
  weakening the gate.
- **The Rust job is a matrix: macOS AND Windows.** The two compile different programs
  (`tmux`/`session_budget` are cfg-gated; spawn, PTY, path and process-kill each have a
  Windows arm), so a green macOS leg proves nothing about Windows. It was macOS-only for
  76 commits and the Windows build was broken that whole time. If you add a
  `#[cfg(windows)]` block, the Windows leg is the only thing that will ever compile or
  lint it.
- **Component tests are deliberately absent.** Testing `Terminal.tsx` needs a mounted
  xterm, a PTY, and the Tauri bridge, and a shallow render would assert nothing worth
  maintaining. Verify UI changes with `pnpm exec tsc --noEmit` / `pnpm build` **and by
  launching the app** — never claim a UI change "works" from a typecheck alone.
- **There IS a GUI end-to-end harness, and it is not a PR gate.** `pnpm build:e2e &&
  pnpm test:e2e` builds the app with `--features wdio` and drives the real window with
  WebdriverIO (`wdio.conf.ts`, `e2e/`); `.github/workflows/e2e.yml` runs it on
  `workflow_dispatch` and pushes to `main`, not on pull requests, because it costs a
  full app build per run. It does not replace launching the app by hand for UI work —
  it covers three specific CLI-launcher assertions plus the conversation-continuity and
  Continuity-view specs. Every spec runs with `CONTINUITY_DB_PATH` pointed at a hermetic
  fixture DB, but that covers **Conduit's own READS only**: the vendored continuity
  plugin's `hooks.json`/`.mcp.json` set `CONTINUITY_DB_PATH` from `${user_config.dbPath}`
  (falling back to `~/.continuity`), so a `claude` a spec spawns inside a GIT repo writes
  the developer's REAL continuity DB. The Continuity-view spec is safe only because its
  project is a fresh non-git `mkdtemp` dir — keep any new spec that spawns an agent out of
  a git checkout, or it will. The fixture needs the `sqlite3` CLI; without it `onPrepare`
  warns and the Continuity-view spec skips itself. See "Where the `conduit` CLI lives" and
  "Where the Continuity view lives".
- **`src/store.seam.test.ts` guards the session-directory seam** — it fails if anything
  outside the sanctioned consumers references `workingDirOf`. If you add a consumer that
  genuinely needs intent rather than reality, add it to that test's allowlist with a
  reason.

## Bumping the version

The version lives in **three** files and they must stay in lockstep:

| File | Field |
| --- | --- |
| `package.json` | `"version"` |
| `src-tauri/Cargo.toml` | `version` (the `[package]` one on line 3 — not a dependency) |
| `src-tauri/tauri.conf.json` | `"version"` |

After editing `Cargo.toml`, run `cargo build --manifest-path src-tauri/Cargo.toml` once so
`Cargo.lock` updates too. Quick sanity check that all three agree:

```bash
grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml
```

### When to bump (SemVer, pre-1.0)

**A version marks an INSTALLABLE ARTIFACT, never a commit.** The trigger is building an
installer someone will actually run — not finishing a feature, not passing the gate, not
landing a branch. Work that is merged but never built is not a release and must not consume
a number.

This is the rule most easily broken while working fast. On 2026-09-19 six versions
(`0.37.1` → `0.41.0`) were cut in one day, one per feature batch, and at least two of them
were never installed by anyone — numbers spent on artifacts that never existed. The fix is
mechanical and lives below: **features accumulate under `## Unreleased`, and the number is
stamped at build time.**

Conduit is `0.MINOR.PATCH` until its first stable public release. Size is decided by the
*largest* change in the release:

- **MINOR** (`0.X.0`) — the release contains any user-facing **new capability**. Reset PATCH
  to `0`. One MINOR covers every change in that release, however many features it carries.
- **PATCH** (`0.x.Y`) — bug fixes, polish, perf, refactors, docs: **no** new user-facing
  capability anywhere in the release.
- **MAJOR** stays `0` until the first stable public release, which is `1.0.0`; after that,
  breaking changes bump MAJOR.

**Never number a feature as a PATCH to keep the minor number small.** Pre-1.0 the
MINOR-vs-PATCH split is the only signal the scheme carries, and a feature filed as a patch
is invisible to anyone scanning for what is new. There is no such thing as too many minors;
a high minor number costs nothing, a dishonest one costs the reader. (The `0.x.y` =
"x breaking / y everything else" convention some pre-1.0 *libraries* use does not apply
here: it exists to warn downstream code about API breakage, and Conduit has no API
consumers — only users asking "what can I do now that I couldn't before".)

A `-N` build suffix (e.g. `0.5.0-3`) is only for iterating installers of the *same* target
during testing — a real feature release gets a clean `0.x.0`.

### Keeping the changelog

`CHANGELOG.md` is the source of truth for what shipped when. It is written in TWO steps, and
separating them is what stops a version being spent on an artifact nobody installs.

**1. Every change lands under `## Unreleased`, immediately.** A feature is not done until its
bullets are there. No version number is chosen, and the three version files are NOT touched.

**2. At installer build time, stamp it.** Rename `## Unreleased` to `## X.Y.Z — YYYY-MM-DD`,
bump the three version files to match, run `cargo build` so `Cargo.lock` follows, and build.
That single commit is the release. Then add a fresh empty `## Unreleased` above it.

A version bump with no matching changelog entry — or a stamped entry whose version disagrees
with the three files — is incomplete work.

- **Bullets stay granular; the RELEASE does not.** Each user-facing feature gets its own
  bullet, and unrelated features are never merged into one vague line. But many bullets
  belong under one version — that is what a release *is*. (This used to read "one entry per
  increment", which was about keeping bullets distinct and was misread as "one version per
  feature". That misreading is what produced six versions in a day.)
- **Header format:** `## X.Y.Z — YYYY-MM-DD`, newest first. **No contributor names**, no
  author attribution — describe the change, not who made it.
- **Bullets:** `- **Added|Changed|Fixed — short title.** user-facing description.` Write for
  someone using the app, not reading the diff.
- **Reconstructing history:** when commits landed without changelog updates, derive each
  release's contents from the git range between version-bump commits (`git log
  <prev-bump>..<next-bump>`), **not** from commit dates — feature branches merge after their
  commit dates, so a commit can belong to a later release than its date suggests.

## Conventions

- **Commits:** Conventional Commits (`feat`, `fix`, `docs`, `spike`, `chore`), scoped —
  e.g. `feat(usage): …`. **Never add a `Co-Authored-By: Claude` (or any AI
  attribution) trailer** — it makes GitHub display "claude committed" on every
  commit. The full history was scrubbed of these on 2026-07-10; don't reintroduce
  them.
- **Branches:** one `feat/<topic>` branch per change; integrate to `main` with a merge
  commit: `git merge --no-ff feat/<topic> -m "Merge feat/<topic> into main"`.
- **Never push or merge to `main` without explicit human approval.**
- **Design workflow:** non-trivial features get a spec then a plan under
  `docs/superpowers/specs/` and `docs/superpowers/plans/` before implementation. Keep
  those docs as the record of *why*.

## Architecture gotchas (don't reintroduce)

- **Keep-alive terminals are load-bearing.** Never reparent or conditionally unmount an
  `xterm` / `TerminalView` — it kills the underlying `claude` PTY. Layout is expressed
  purely through CSS from group weights (see CONTRIBUTING.md).
- **Lean dependencies.** The Rust side intentionally has no outbound HTTP client; network
  calls shell out to `curl` (see `claude_status.rs` / `claude_usage.rs`). Don't pull in
  `reqwest`/`tokio` for a couple of GETs without a real reason. The one exception is the
  official `tauri-plugin-updater`, which brings its own HTTP+TLS stack (streaming download
  + minisign verify + self-replace) — that's not a violation of the curl rule, which
  targets hand-rolling a client for a couple of GETs.
- **`claude` spawns must scrub `npm_config_prefix`.** Launching Conduit via a package
  manager leaks `npm_config_prefix` into the env; nvm then refuses to initialize in the
  login shell and `claude` falls off `PATH`. Both spawn sites — `pty.rs` and the
  `claude -p` titler in `lib.rs` — call `env_remove("npm_config_prefix")`. Keep that when
  editing spawn code.
- **A command that spawns a process or reads more than a small file must be
  `#[tauri::command(async)]`.** A plain sync Tauri command runs on the main (UI) thread on
  every platform, and that thread also carries `pty_write` and every terminal-output
  `Channel` delivery — so a polled `git` call there makes typed text appear late, and a
  slow repo (seconds, e.g. cloud-synced) makes the whole app stall. `(async)` on a sync fn
  runs it on the thread pool with no signature change. `pty_write` / `pty_resize` stay sync
  on purpose: they are cheap, and their ORDER is the keystroke order. `pty_spawn` is
  off-thread under two locks — `SPAWN_GATE` (lib.rs) keeps spawns one-at-a-time because
  their setup read-modify-writes files sessions share, and `PtyManager`'s `lifecycle` keeps
  a spawn and a teardown of the same session from interleaving — and `Terminal.tsx` holds
  keystrokes until its spawn resolves.
- **Terminal output is coalesced, not sent per read** (`pty::next_output_batch`,
  `OUTPUT_FRAME`). Each send is one script evaluation on the UI thread, and TUI agents repaint
  in many small writes. The first chunk after a quiet spell is never held, so keystroke echo
  stays immediate; only a stream is merged into ≤ one frame per `OUTPUT_FRAME`.
- **Secrets.** The plan-usage path reads Claude Code's OAuth token from the macOS Keychain
  (`security find-generic-password`) only on explicit user action, holds it in memory, and
  never writes it to disk. Don't log the token or persist it.

## Where the Claude status/usage feature lives

Service status + subscription/local usage (distinct from per-session hook status):

- Rust: `src-tauri/src/claude_status.rs` (status.claude.com), `src-tauri/src/claude_usage.rs`
  (local consumption + best-effort plan limits via `/api/oauth/usage`; returns usage per
  account -- `Vec<ClaudeAccountUsage>`), `src-tauri/src/agy_usage.rs` (agy quota per account).
- UI: `src/components/Claude{StatusPill,Popover,StatusWarning}.tsx` for service status;
  the usage meter itself is the unified `src/components/UsagePanel.tsx` (all accounts, both
  agents, driven by `usagePrefs`; configured in `UsagePrefsPanel.tsx` under Settings ->
  Usage display). Polled by `src/hooks/useClaudeAmbient.ts`; state in `src/store.ts`
  (`claudeUsage` array + `agyUsageByAccount` map + `usagePrefs`).

## Where cross-project panes live

A layout is keyed by project, so for years "which project is this tab's session in" was
answered by "the layout it is in" and nothing stored it. `WsTab.projectId` is the whole
feature: set ONLY on a BORROWED tab -- a session lent from another project into this
layout's panes.

- **Absent means the host project**, and every tab written before this feature is absent.
  That is what makes existing `state.json` files and the Rust struct forward-compatible;
  two Rust tests pin it (an old tab must not deserialize as an orphan, a borrowed one must
  survive a round trip, a local one must not grow a `projectId` key). Read it through
  `tabProjectId` (`src/layout.ts`), never off the object, so the absent case is handled once.
- **`repairLayout` must validate a foreign tab against its OWN project.** It moved out of
  `store.ts` into `layout.ts` precisely so this is testable: a repair runs on EVERY layout
  write, so checking a borrowed tab against the host would prune it the instant it was
  created and the feature would look broken rather than absent. `store.ts` keeps a thin
  `validateLayout` wrapper that supplies `uid()`.
- **Removal repairs EVERY layout, not the owner's.** `revalidateAllLayouts` runs on
  `removeSession`/`removeProject` because a dead session may be sitting in someone else's
  panes. It skips persisting layouts that did not change.
- **The terminals were already all mounted.** `WorkspaceCenter`'s `allSessions` flat-maps
  every project's sessions into one permanent keep-alive stack and moves them with CSS
  alone, so this needed no remounting -- only dropping `placeSession`'s ownership gate in
  pane mode. Canvas mode never regains that gate either, now that the board is global (see
  "Where the orchestration board lives" below): membership is the node list, which spans
  every project by design, so a borrowed tab and a canvas node answer "whose is this"
  the same way.
- **Differentiation is all-or-nothing per layout.** `isMixedLayout` decides; when true
  EVERY tab is badged, not just the visitors, because badging only the foreign ones makes
  "no badge" mean "the host", which is the knowledge the badge exists to supply. When
  false, the strip renders exactly as it did before.
- **The sidebar-to-pane drag crosses component trees, so it travels as a MIME type.**
  `SESSION_DRAG_MIME` + `hasSessionDrag`/`readSessionDrag` (`layout.ts`). `dataTransfer.getData`
  is blocked during `dragover` and only `types` is readable, so advertising a custom type is
  the ONLY way a drop target can know a drag is droppable before it lands -- which is what
  the pane overlay needs in order to render at all. A module-level variable could not do it:
  the overlay is gated on React state in a different tree. `.group-chrome` sits above
  `.term-stack`, so the tab strip must accept the drop itself; the pane overlay never sees a
  pointer over a strip. `insertTabAt` dedupes by ref because a session is ONE mounted
  terminal placed by the first group holding it -- a duplicate ref leaves the second pane
  permanently blank.
- **Project colours resolve through ONE function: `resolveProjectColor` (layout.ts).**
  Precedence: a user-CHOSEN colour (`Project.color` in state.json, set via the project's
  right-click swatch row) > the derived `projectAccent` while the per-machine
  `autoProjectColors` pref (Settings → General, default on) is on > null, which every
  `--proj-accent` consumer renders through its neutral CSS fallback. The original rule
  survives in halves: a colour the user did NOT choose is still never stored (derived
  accents stay derived, now mapped onto the curated `PROJECT_PALETTE` instead of the raw
  HSL wheel), and only an explicit pick becomes state. Never call `projectAccent`
  directly from UI — go through the resolver or the sidebar/tab colours disagree.
- Design: `docs/superpowers/specs/2026-08-23-cross-project-panes-design.md`, which also
  records why this ships BORROWED TABS rather than the single global `workspaceLayout` the
  July spike proposed, and which of that spike's risks do and do not apply.

## Where the orchestration board lives

The canvas used to be per-project and auto-placed every live session in a grid, so
position carried no information. It is now one global board across every project, and
membership is curated by hand: it starts empty, and a session arrives only by being
dragged in from the sidebar.

- **`pruneCanvas` only prunes.** It drops a node whose session is gone; it never adds one
  for a session that exists. That asymmetry is the whole feature — a session existing is
  not a reason for it to be on screen, which is what makes a position on the board mean
  something instead of being wherever the last auto-layout put it.
- **`CanvasNode.projectId` is required** — the opposite of `WsTab.projectId`, which is
  absent for a tab in its own project's layout and present only when borrowed. A layout
  always has a host project for absence to mean; a global board has none, and a session id
  alone does not locate its project without scanning every one of them. Don't make this
  field optional to "match" the borrowed-tab convention — the two are answering different
  questions.
- **Z-order is derived, never stored.** `sectionsByZ` sorts sections back-to-front by area
  (largest first, so a nested section paints over its parent) and cards paint in plain
  document order after them. There is no z field to maintain and must never be one:
  reordering an array reorders the DOM nodes React renders from it, React reorders DOM to
  match list order, and a reorder is a reparent — which kills the PTY under it (the
  keep-alive rule at the top of this file). If a future "bring to front" needs stored order,
  it has to be a *separate* sort key read only for paint order, never the array itself.
- **The stack carries `translate()` only; the underlay keeps `scale()`.** `.canvas-underlay`
  is DOM and SVG, which a `transform: scale()` renders as vectors — cheap and always crisp.
  `.term-stack` holds real terminals, which under a CSS scale would resample a rasterized
  glyph atlas into blur. So canvas terminals are placed in **screen pixels**
  (`node.x * zoom + pan.x`, in `WorkspaceCenter.placeSession`) and rasterize natively via
  `fontForZoom` (`src/terminalZoom.ts`), which quantizes zoom to a ladder of integer font
  sizes — a fractional font size gives a fractional cell width whose rounding error
  accumulates visibly across a row. **A terminal must never be refit for a zoom change** —
  only a real change in the logical box or the base font may call `fit()`
  (`fitInputsChanged` in `Terminal.tsx` gates every fit path on this, including the
  font-zoom effect's own). Refitting on zoom is what used to rewrap a running agent's
  output every frame of a pinch gesture; the gate is what stops it. Below the legibility
  floor (`LIVE_ZOOM_MIN`) terminals drop to cards instead — DOM, crisp at any scale, no
  rasterizer needed — and return crisp on settle once the zoom rung is chosen.
- **`.canvas-underlay` and `.term-stack` are siblings, not ancestor/descendant** — the
  stack paints above at a higher z-index, and each *visible* terminal takes
  `pointer-events` back individually so its own content is interactive. This means a
  listener bound to the underlay never sees a pointer or drag that is currently over a
  placed card's terminal body — it bubbles straight past the underlay to whatever the next
  real ancestor's handler is. **This hazard bit the build five separate times**: the
  wheel handler (pan/zoom), the sidebar-to-board drop handler, marquee selection
  drag-tracking, and — worst, because there's no capture-phase workaround for CSS
  stacking — the attention rail and edge pips, which cannot paint above a terminal at all
  if mounted inside `.canvas-underlay`'s own stacking context, no matter what z-index they
  declare (`CanvasRail.tsx`'s own doc comment calls this out by count). The fix is always
  the same shape: bind at the common ancestor (capture phase, for input) or mount as a
  sibling *after* `.term-stack` in `WorkspaceCenter` (for paint). Don't add a new
  interactive or visible layer as a JSX prop on `.canvas-underlay` or a child of it —
  check whether it needs to win against a terminal first.
- **Section membership is geometric and captured once, at drag start** (`membersOf` in
  `onPointerDown`), never recomputed on `pointermove`. Recomputing mid-drag would mean a
  card could fall out of (or into) a moving section as it crosses the boundary, so
  "drag a section" would sometimes not drag everything the user saw inside it when they
  grabbed it. A resize is deliberately excluded from capture — it changes what the section
  contains rather than moving anything, so it has no members to move.
- **Canvas state lives in `localStorage`, not `state.json`, on purpose.** `state.json` is
  the Rust-owned store, and an unparseable value there is an empty `Store` — which the
  startup orphan sweep (see "Where session persistence's safety net lives") reads as
  every live tmux session being orphaned, and kills them all. A corrupt canvas blob must
  never be able to do that to a running fleet, so it stays in its own key
  (`conduit.canvas`), read defensively (`readCanvas` falls back to `emptyCanvas()` on a
  parse failure, and takes a one-time `.bak` snapshot of the unreadable value on the next
  write rather than silently overwriting it).
- Design: `docs/superpowers/specs/2026-09-08-canvas-orchestration-board-design.md`.

## Where the usage meter's semantics live

Every quota meter in the app answers the same question, and `src/usageRows.ts` is the ONE
place that decides how.

- **`UWindow.used` is the only quantity stored** -- the fraction CONSUMED, 0..1, whatever
  the agent reported. Claude and Command Code give `pctUsed`; agy gives `remainingFraction`
  and is flipped at its row builder. It used to be a `mode` + a `value` that meant remaining
  for some windows and used for others, the panel branched on the mode in three places, and
  one of them was backwards: the label read "62% left" over a bar filled to 38%.
- **`meterView(w, metric)` returns the label number and the bar fraction together**, which is
  what makes that class of bug unrepresentable. It also returns `severity`, which is ALWAYS
  consumption: the colour ramp, the low-alert and the sort key off danger, not off the
  direction the user happens to read. A meter showing "8% left" must be red.
- **`metric` defaults to `"used"`** (`UsagePrefs.metric`, Settings -> Usage display) because
  that is what the agents' own views show -- `claude /usage` prints
  `Current session ████░░░░░░ 18% · resets 3:50pm`. `"remaining"` is a supported preference,
  not a fallback.
- **`windowLabel(kind, pool?)` names the window, not the vendor.** Each CLI names its own
  windows differently; stacked in one panel those read as different KINDS of limit. Only agy
  keeps a pool prefix, because its pools are genuinely separate quotas.
- **The PANEL and the ROUTER ask different questions of the same rows.** `summaryRemaining`
  answers 1 for "nothing readable" so a router never treats an unmeasurable agent as spent;
  the panel drew that same 1 as a healthy green dot, so a rate-limited poll read as good
  news. `rowHealth` returns `remaining: null` for unknown, and the dot/sort/low-alert use it.
  Keep `URow.minRemaining` unfiltered (routing truth) and derive anything the panel SHOWS
  from `visibleWindows` -- the summary number reporting a window the user has filtered out
  is the other half of "the views disagree".
- **The collapsed summary must NAME its window** (`worstWindow`). A bare "79%" over meters
  reading 18, 3 and 79 reads as a contradiction rather than a worst-case.
- **`/api/oauth/usage` rate-limits, and Conduit was a big part of why.** It polled per
  account every 60 s while the real `claude` CLI competed for the same budget; a 429 made
  `parse_plan` return None and blanked the account. `ClaudeAuth.last_plan` now serves the
  last good read as `planSource: "stale"` (max 1 h old), and `useClaudeAmbient` splits the
  fast status tick (60 s) from the quota fetch (5 min, and not re-fired on every alt-tab).
  Both windows it reports are measured in hours -- 60 s was never resolution, only load.
- **`usageRows.ts` must stay importable without `store.ts`** -- that is why `accountKey`
  lives here and the store re-exports it. Importing the store under the node-env vitest
  touches `localStorage` at module scope and throws (same reason `startup.ts` exists), and
  `usageRows.test.ts` is what holds the label/bar agreement in place.
- Design: `docs/superpowers/specs/2026-08-23-usage-meter-semantics-design.md`.

## Where the agent glyph lives

`src/components/AgentGlyph.tsx` owns both the agent's identity and the session's liveness.

- **`AGENT_MARKS` holds each agent's real brand mark**, one path per agent in its SOURCE
  viewBox (they disagree -- 24 vs 144 -- and rescaling path data by hand is a silent
  transcription error nobody catches in review). An agent with no mark falls back to
  `AgentMeta.letter` rather than shipping a guessed logo, which is why that field still
  exists.
- **The tint is bent toward `--text-bright`** (`--glyph-ink`). The tints are fixed constants
  in `agents.ts` but Conduit ships a light theme, and `#e0b341` on cream is ~1.5:1. One
  `color-mix` brightens on dark and darkens on light, clearing the 3:1 WCAG 1.4.11 asks of a
  graphic.
- **`glyphStateFor(status, loaded, compacting)` is the only place status becomes a ring.**
  `loaded` is "a `live` entry exists", i.e. the session has emitted a hook -- there is no PTY
  registry in the store. A never-started session gets NO ring on purpose: if every row had
  one, an idle ring would be wallpaper.
- The running/needs-you pulse animates `opacity` + `transform` only (compositor-only, so a
  dozen live sessions cost nothing), runs at 2.4s/1.6s -- far under WCAG 2.3.1's 3Hz -- and
  is dropped under `prefers-reduced-motion`. The ring still distinguishes the states without
  it, and the meaning is in the tooltip so it never rests on hue alone.

## Where the Windows spawn command lives

`pty.rs` spawns Windows sessions as `cmd.exe /K <one argument>`, and that argument **must
never contain a double quote**. `portable_pty` builds the child command line with MSVCRT
`ArgvQuote` rules, which escape an embedded `"` as `\"`; cmd.exe has no such escape, so it
strips the outer quote pair and hands the child literal backslash-quotes, whose CRT then
splits the contents on spaces. A 16-word initial prompt reached the agent as 16 arguments --
`error: too many arguments. Expected 1 argument but got 16.` It hit EVERY adapter that puts
a prompt (or a spaced path) on the command line, not one of them.

- **The invocation travels in a generated script**, `data_dir()/spawn-<session_id>.cmd`
  (`write_spawn_script`), and the only token left on the command line is that file's path,
  caret-escaped (`cmd_caret_escape`). `^` is the one escape that survives `ArgvQuote`
  untouched, which is why the path is caret-escaped rather than quoted.
- **The body is one line prefixed with `@`, never `@echo off`** -- `/K` leaves the user in an
  interactive shell afterwards, and `echo off` would hide its prompt.
- Inside the script ordinary cmd quoting applies, so `win_quote` and every adapter's
  `build_invocation` are correct as written and needed no change.
- `hooks::write_codex_result_script` predates this and works around the same re-parse
  locally; it is still needed for its own reasons, but new code should not hand-roll another
  one -- put it in the spawn script.

## Where the terminal renderer choice lives

Panes draw through WebGL by default, canvas on request (Settings → Terminal). The tier ladder
is `src/terminalRenderer.ts` (`attachRenderer`: WebGL → canvas → xterm's DOM renderer), with
the concrete addons injected from `src/terminalRendererAddons.ts` — they are UMD bundles that
touch `self` on import, so a static import would break the Node-env vitest. Two rules:

- **The preference is intent; `handle.active` is reality.** WebGL costs one GPU context per
  pane and WebKit caps how many are live; a pane that loses its context drops to canvas *in
  place* and the stored preference is NOT rewritten. Same split as `workingDirOf` vs
  `effectiveDirOf`.
- **Switching must never recreate the xterm** — that would kill the PTY (keep-alive rule
  above). `Terminal.tsx` keeps the renderer in its own effect keyed on the pref, so a change
  disposes one addon and loads another on the live instance; the create effect stays `[]`.

## Where the terminal's mouse ownership lives

`src/terminalMouse.ts` (pure) + the `shellOnly` block in `Terminal.tsx`. tmux is launched
with `set -g mouse on`, which the WHEEL needs and the BUTTONS must not have.

- **`mouse on` is load-bearing and must not be turned off.** tmux is a screen painter, so
  xterm's own scrollback under it is repaint fragments; tmux's history is the only coherent
  copy, and tmux only reads mouse input while this is on.
- **The cost is that tmux also answers the buttons.** In a pane whose program wants no
  mouse -- a bare login shell -- tmux's root bindings fire: `MouseDrag1Pane` -> `copy-mode -M`
  (the yellow `[0/27]` badge plus a second cursor) and `MouseDown3Pane` -> its own
  `display-menu` (Horizontal Split / Vertical Split / Kill). Agent panes never see this:
  Claude Code turns tracking on itself, so every one of those bindings falls through to
  `send-keys -M` and the program gets the event -- which IS the native answer.
- **So the shell pane refuses to enter mouse REPORTING at all.** Two
  `term.parser.registerCsiHandler({prefix:"?"}, ...)` handlers swallow the tracking DECSETs
  (1000/1001/1002/1003 only -- the 1005/1006/1015 ENCODINGS are inert once nothing reports,
  and a combined `CSI ? 1002;2004 h` replays its surviving half). xterm then owns selection,
  word/line click and the right-click, exactly as it does for any non-mouse program.
- **The wheel is re-encoded by hand** (`attachCustomWheelEventHandler` -> `sgrWheelReport`),
  one report per whole line moved, carrying the sub-line remainder so a trackpad neither
  stalls nor bolts. It never scrolls xterm's own buffer. If the swallow ever stops taking
  (an xterm upgrade moving the parser registry) the handler checks `term.modes.mouseTrackingMode`
  and hands the wheel back rather than leaving the pane unscrollable.
- Trade, accepted deliberately: a mouse-aware TUI run INSIDE the companion shell (vim
  `set mouse=a`) does not get the mouse there. Selection is the commoner need in a scratch
  shell; agent panes are untouched.

## Where the `conduit` CLI lives

`conduit .` opens a project the way `code .` does; `--agent <id>` also starts one new
session. Three parts: `cli_open.rs` (the `/open` route), `cli_shim.rs` (the shim's text
plus install/remove/status), and one listener in `App.tsx`.

- **`/open` is the one route on the hook server that ACTS**, so it is authenticated
  where `/hook` is explicitly trusted-as-display-data. Three layers: a per-boot 256-bit
  token in `<dataDir>/cli-token` (0600, minted where the port is published), refusal of
  any request carrying `Origin` — checked FIRST, so the route is not a token oracle —
  and never answering a CORS preflight, which falls out of the loop's non-POST early
  return. Do not add a route beside it that skips these.
- **The handler takes a SINK, not an `AppHandle`.** That is the only reason
  `src-tauri/tests/cli_open.rs` can run the real shim as a process against the real
  handler over a real socket. Keep it that way.
- **The shim is generated, not bundled** — the resource bundler does not reliably keep
  the executable bit, and Windows needs different text. It resolves its data dir exactly
  as `store::data_dir` does, and **refuses to cold-launch when `CONDUIT_DATA_DIR_NAME`
  is set**: a dev build has no bundle, and launching the installed app there is the
  `state.json` clobber. Install and remove both refuse to touch a `conduit` that lacks
  `SHIM_MARKER`, so they can never destroy a user's own binary. The Windows installer
  does NOT edit `PATH` — `setx` truncates a `PATH` over 1024 characters — it reports the
  directory instead.
- **`Store::add_project` does not dedupe by path**, so `matchProjectByPath`
  (`src/cliOpen.ts`) is load-bearing rather than an optimization: without it every
  `conduit .` on an open project adds a duplicate. Pure and standalone because `store.ts`
  cannot be imported under the node-env vitest.
- **The `wdio` cargo feature must never reach a release build.** It registers a
  WebDriver server INSIDE the app. The gate is the feature, not `debug_assertions` (the
  vendor's advice), because the harness launches a bundled app and bundling is a release
  profile — under `debug_assertions` the plugin would be missing from the very binary
  under test. `build.rs` generates `capabilities/wdio.json` only under the feature, since
  a capability naming an absent plugin's permission fails codegen. Three tests in
  `cli_shim.rs` pin all of it, including that `release.yml` passes no `--features`.
- Design: `docs/superpowers/specs/2026-09-04-conduit-cli-launcher-design.md`.

## Where the IDE integration lives

Conduit announces itself to the `claude` CLI as an IDE (the VS Code/JetBrains protocol):
`src-tauri/src/ide_host.rs` (lock files, per-session WS/MCP servers, the tool surface),
spawn/teardown wiring in `pty.rs`/`lib.rs`, `src/ideBridge.ts` (pure context/queue
helpers), `DiffReviewOverlay.tsx`, and the context push in `CodeEditorPane.tsx`. The
protocol is UNDOCUMENTED and was pinned empirically against claude 2.1.267 — the spec's
"Empirical findings" section is the authority, not intuition or claudecode.nvim's docs.

- **One server per SESSION, and the port is the identity.** The wire carries no client
  identity, and under tmux Conduit is never the claude process's ancestor, so pid
  forensics are impossible. Each Claude session gets its own listener (ephemeral port),
  lock file, and auth token; a connection on that port IS that session. Don't "optimize"
  this into one shared server — that reintroduces the unanswerable "whose openDiff is
  this" question. Cost is a couple of threads and KBs per session.
- **`openDiff` accept is a TWO-item reply**: `[{text:"FILE_SAVED"},{text:<final
  contents>}]`. A single-item `FILE_SAVED` is *silently ignored* (the binary checks
  `e[1].text` is a string) and the terminal prompt just stays up — we watched it happen.
  **claude writes the file itself** from the returned contents; Conduit must never write
  it. Reject is single-item `DIFF_REJECTED`. The second item is how user edits made in
  the diff view reach the file.
- **The IDE env rides `build_script`'s export line, never `cmd.env`** (POSIX). The tmux
  server keeps its own environment for every session after the one that started it, so
  `cmd.env` reaches only the tmux client. Windows has no tmux and uses `cmd.env`
  natively. `CLAUDE_CODE_SSE_PORT` is the auto-connect trigger in 2.1.267
  (`ENABLE_IDE_INTEGRATION` is dead there; still set for older CLIs).
- **`close_tab` must prune the pending diff without a verdict.** When the user answers
  the TERMINAL prompt instead of the overlay, claude resolves its side and closes the
  tab; the parked entry would otherwise wait forever for a click nobody will make.
- **The token is never persisted or logged** (Secrets rule): fresh per start via
  `uuid` v4 (CSPRNG on every platform — an early draft read /dev/urandom, which
  silently degrades to guessable on Windows). Only `Session.ide_port` persists, so a
  warm re-attach re-binds the SAME port and a still-running claude's env stays valid;
  claude re-reads the token from the rewritten lock file.
- **Retire keeps the listener; only destroy stops it** (`tear_down` gates on
  `keeps_snapshot()`, same asymmetry as the scrollback snapshot). `kill_all` removes
  lock files on quit; the startup sweep removes Conduit-named locks whose port no longer
  answers — never other IDEs' locks.
- **The lock dir follows the account redirect** (`ide_host::lock_dir` mirrors
  `agent::claude_profile_env`): an account-pinned session's claude reads
  `<profile>/.claude/ide`, not the real `~/.claude/ide` — writing to the wrong one
  announces to a claude that can never see it.
- **External `/ide` discovery is best-effort by design**: for a lock whose port doesn't
  match `CLAUDE_CODE_SSE_PORT`, claude validates the lock pid against its ancestors or a
  hardcoded known-IDE `ps` grep that Conduit will never match. Conduit-spawned sessions
  bypass that via the env port match; don't chase external-discovery bugs.
- Design: `docs/superpowers/specs/2026-09-23-ide-integration-design.md`.

## Where root chat's orchestration lives

Root chat (HQ) reaches Conduit through a SECOND in-app MCP server, `root_mcp.rs`, on
`/mcp?rootchat=<chat-id>` (`start` binds the first free port in 8496..=8516, clear of the
hook server's 8423..=8443, the mobile bridge's 8455..=8475, and fleet's own 8475..=8495).
It is deliberately not part of `fleet_mcp.rs`: every fleet tool is project-scoped by
construction, root chat is global, and teaching one authorizer both shapes is what
produced the earlier cross-project leak. The two surfaces share no `authorize()` — only
the spawn path underneath.

- **Dispatch never spawns.** `dispatch_work` records a `proposals.rs` entry and returns;
  the human approves a card, and `approve_root_proposal` creates the session and emits
  `fleet-spawn` for the frontend to mount (Rust cannot mint a terminal Channel — the same
  wall `bridge.rs` hit). Dispatched sessions are ALWAYS `SessionRole::Worker`
  (`lib.rs`'s `DISPATCH_ROLE` constant) — a Conductor would hand root chat fleet's whole
  orchestration surface.
- **A lost claim race rolls back its session.** `Proposals::resolve` is the only
  check-and-set against a proposal (first responder wins), and `Store::add_session` has
  no way to join that atomically — so `approve_root_proposal_inner` creates the session
  *before* claiming, and if `resolve` reports the proposal was already answered (a phone
  and a desktop approving at once), it deletes the session it just created rather than
  leaving a live, untasked worker sitting in its own worktree that nothing ever spawned.
- **`dispatch_status` sweeps before reading.** `dispatch_status_inner` and
  `approve_root_proposal_inner` both call `Proposals::sweep` first — `get` alone never
  expires anything, only `register`/`pending` do — so a proposal past `EXPIRY_SECS` can
  neither be reported as pending nor approved late.
- **`proposals.rs` is not `broker.rs`.** The broker hands its caller a receiver to block
  on and forgets an answered entry (right for a 45 s approval hook). A proposal is
  non-blocking, lives 24 h, and must stay readable after the answer so `dispatch_status`
  can report it. The UI merges the two queues; the registries stay separate.
- **The agent is resolved at APPROVE time, in TypeScript.** `routing.rs` owns the
  preferences, `routing.ts`'s `pickTarget` owns which target has quota left — only the
  frontend holds the live usage snapshot already in the store. The proposal therefore
  stores the task KIND, never a resolved agent; `pendingDecisionRouting.ts` calls
  `pickTarget` and hands the resolved agent id to `approve_root_proposal`.
- **A card is routed by ITS OWN project.** `decisionRoute` takes the whole
  `decisionRoutes` map (project id → `RoutesView`, filled per card by
  `loadDecisionRouting`) and looks up `d.projectId`. It must NEVER read the shared
  `routes` slot: that slot is globals-only when loaded with `null` (so a project-level
  override silently never applied) and it is also written by `NewSessionDialog` and
  `RoutingPanel` (so a card for project Y was routed by whichever project was opened
  last). An unloaded project yields `routesPending`, not "no agent available" — the two
  are both disabled, but only one is a verdict.
- **Approving navigates to the work.** `approveDecision` applies
  `rootProposals.ts`'s `approvalFocus` — select the CARD's project, drop the chat layer,
  toast which project. Root chat is global, so the approved project is routinely not the
  selected one, and `Terminal.tsx`'s eager spawn is gated on
  `projectId === selectedProjectId`: without the jump "Start it" starts nothing, and since
  `pendingPrompts` is runtime-only, quitting before opening that project loses the brief
  and the session later spawns with no task. The session's own tab is opened by
  `mergeSpawnedSession` off `fleet-spawn`, not here — opening it here would race
  `repairLayout`, which prunes a tab whose session is not in the store yet.
- **A model-invented id must never render as a promise.** `dispatch_work` refuses a `kind`
  outside `routing::task_kinds()` and an `agent` outside `agent::all_adapters()`, and
  `decisionRoute` re-checks the agent against `AGENTS`. All three are needed: `pickTarget`
  treats an agent absent from the availability map as USABLE, so an unchecked id produced
  an ENABLED "as gpt5-turbo (chosen by the chat)" button, and `AgentId`'s deliberately
  lenient `Deserialize` then spawned Claude under it — hence `approve_root_proposal_inner`
  reads the id through `PersistedEnum::from_wire` (strict), never `from_value`.
- **The `pending-decision` payload has ONE builder**, `proposals::proposal_json`, used by
  both producers — `root_mcp`'s live emit and `lib.rs`'s `list_pending_decisions` catch-up
  fetch. Hand-built twice they drifted silently: a live card missing `kind` routes as
  "implementation" and one missing `agent` drops the chat's explicit choice, while the same
  card after a reload carries both. A test pins all nine fields *and* the key count.
- **`chat_fork` is capped per chat per minute** (`MAX_FORKS_PER_MINUTE_PER_CHAT`, via
  `fleet::rate_limited`). A fork is itself a root chat, so `known_chat` admits it and it
  gets the whole tool surface *including `chat_fork`*, and a seeded fork is auto-sent by
  `App.tsx` — one real `claude -p` child per fork. The charter's "fork sparingly" is advice,
  not a bound.
- **No root MCP server means no tools, not a half-state — and a server means ALLOWED
  tools.** `write_mcp_config` returns `None` when the port is 0, `build_command` omits
  `--mcp-config` entirely, and `--strict-mcp-config` leaves the chat with exactly its
  Phase 2 surface. When there IS a config, `build_command` must also widen
  `--allowedTools` by `root_mcp::TOOL_NAMESPACE` (`mcp__conduit-root`): under `-p` an MCP
  tool absent from the allow list is DENIED before the server is reached, and the result
  carries `permission_denials`. It appeared to work only on machines whose
  `~/.claude/settings.json` sets `"defaultMode": "auto"` — a per-user setting Conduit does
  not control, and a chat pinned to another account reads a different settings tree.
- Design: `docs/superpowers/specs/2026-09-08-root-chat-orchestrator-design.md`.

## Where the unified session directory lives

Every panel (Files/Changes/Git, tab-strip path, Open in VS Code) and the right-panel
companion shell bind to ONE confirmed per-session directory — the worktree once it
exists on disk, else the project root. **Never wire a new consumer to `workingDirOf`**
(intent only; used solely by the agent-terminal spawn) — use
`effectiveDirOf(project, session, sessionDirs)` from `src/store.ts`. The `sessionDirs`
map is filled by the one resolver `src/hooks/useSessionDirs.ts` (1 s confirm poll via
the Rust `dir_exists` command in `fsops.rs`, ~5 s deletion sweep; a pending worktree
keeps NO entry — that absence holds the shell's `dirReady` gate closed). Shell
kill+respawn on dir change lives in `Terminal.tsx` and is strictly `shellOnly` — agent
terminals are keep-alive and must never be respawned. Design:
`docs/superpowers/specs/2026-07-18-unified-session-directory-design.md`.

## Where the continuity panels live

Two READ-ONLY right-column tabs (Decisions, Messages) mirror continuity's running memory
for the active project. Conduit never writes that database — continuity owns every write.

- Rust: `continuity_read.rs` owns the path + read-only open (board presence/handoffs);
  `continuity_feed.rs` reuses both for the panels (decisions + messages).
  `feed_for_project` degrades to `available: false` on a missing DB, a drifted schema, or a
  continuity install that has never run — the tabs then do not render at all.
- Scoping is two allowlist arms, never a prefix or wildcard: `agent_label IN (this
  project's Conduit session ids)` — exact, because `pty.rs` sets `CONTINUITY_AGENT_ID` to
  the session id, and it rides `build_script`'s export line (`continuity_env`), because
  `cmd.env` alone dies at the tmux server and the rows were attributed through the checkout
  fallback — plus `cwd_hash IN (sha256(git toplevel)[..16])` for sessions started
  outside Conduit in the same checkout. Do NOT canonicalize the toplevel: continuity hashes
  git's raw output, and `/tmp` vs `/private/tmp` would break the match.
- **Continuity's coordination surface is global; only authorship is project-bound.**
  `message_send` fans out to EVERY live session and `decision_write` fans out as a message,
  so another repo's traffic legitimately lands in this project's inbox (scoped by recipient)
  while its decisions do not (scoped by author). That asymmetry is intended: `FeedMessage.foreign`
  is set in `read_messages` when the SENDER is outside the scope set, and the panel dims and
  badges those rows. The projection decides it — the UI never re-derives scope.
- UI: `ContinuityPanels.tsx` (rows + detail modal), tabs in `RightColumn.tsx`, state in
  `store.ts` (`continuityFeed`), polled at 4 s by `hooks/useContinuityFeed.ts` —
  deliberately separate from `useBoard`'s 1.5 s poll and its `board_enabled` gate.
- **The bundled plugin dir must lose its `\\?\` prefix before it reaches `--plugin-dir`.**
  Tauri's resource resolver canonicalizes, and on Windows that yields a verbatim path; it
  becomes `CLAUDE_PLUGIN_ROOT`, and the plugin's own `hooks.json`/`.mcp.json` join it as
  `${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs`. Node cannot resolve a main module under a verbatim
  root — `realpathSync` splits the root as `C:` and lstats it — so every hook and the MCP
  server died with `EISDIR … lstat 'C:'` before running a line, and only the `Stop` hook was
  visible. `continuity::strip_verbatim_prefix` is the fix; it is deliberately not
  `#[cfg(windows)]` so both CI legs test it. Dev builds never reproduce this: the
  `CARGO_MANIFEST_DIR` fallback is not canonicalized.
- Design: `docs/superpowers/specs/2026-08-14-continuity-panels-design.md`.

## Where the Continuity view lives

A per-project center overlay (`CenterMode` `"continuity"`, ⇧⌘K) drawing sessions as derived
animal avatars linked by the Continuity messages they exchange, plus Claude Code
`AskUserQuestion` prompts answered from a card. Conduit still never writes continuity.

- **Questions ride a BLOCKING hook, and every failure is `{}`.** `hooks.rs`'s `/ask` route +
  `asks.rs`. The protocol was pinned empirically (claude 2.1.293): `allow` + `updatedInput`
  with `answers` answers the question; an empty object makes the TUI menu appear. The three
  ceilings are ordered and a test pins it: `ASK_CEILING` 600 s < curl `-m 650` < hook
  `timeout: 660` — the default hook timeout is 60 s, so dropping the entry's `timeout` would
  silently kill every card after a minute.
- **The gate is closed unless a card can be seen** (`set_ask_gate`, `asks.ts askGateOpen`):
  view open or a Conduit window focused. The same `settings.local.json` is read by a `claude`
  the user runs by hand in that checkout; it posts `session=unknown` and is answered `{}` at once.
- **Hand-off is to the session's own terminal** (`askShouldHandOff`), and `ask_answer`
  returning `false` means "already answered there" — not an error.
- **The card's answer model is Claude's, not ours.** Answers are numbered (keys 1–N); a
  `(Recommended)` label suffix becomes a tag; multi-select is checkboxes with "Send K";
  "Something else…" is a free-text answer. The card opens on whichever side of the avatar is
  clear, and a sent answer shows a short "Sent to <name>" before it goes. Keys that belong to
  the graph stay with the graph while a card is open.
- **Identity must cross tmux.** `CONTINUITY_SESSION_ID`/`CONTINUITY_AGENT_ID` ride
  `build_script`'s export line (`continuity_env` in `pty.rs`), never `cmd.env` — the tmux
  server keeps its own environment. Without it every Conduit session appeared TWICE in the
  graph (once as itself, once as a checkout-hash stranger). Rows written before that fix carry
  the unsalted worktree `cwd_hash`; `continuity_graph.rs` folds them into the owning session
  by worktree path, unless two sessions share the path (then it cannot tell and leaves them).
- **`continuity_watch.rs` polls `PRAGMA data_version`**, which moves only on another
  connection's commit; only `messages` has a cursor because only a new message is a pulse.
- **Avatars are derived** (`avatarId.ts sessionAnimal`), never stored — same rule as
  `projectAccent`.
- Canvas and Board are opt-in (`canvasEnabled`/`boardEnabled`, default off);
  `centerViews.ts` owns the gating and the three-way exclusion — callers no longer close
  the canvas themselves.
- E2E: `e2e/continuity-view.e2e.ts` (+ `continuityFixture.ts`) drives the real window; the
  harness gives every spec its own `CONTINUITY_DB_PATH` so none READS the developer's real
  DB. It does not stop one WRITING it: the vendored plugin's hooks/MCP server take their DB
  path from `${user_config.dbPath}` (default `~/.continuity`), not from Conduit's env, so a
  spawned `claude` in a git repo records into the real DB. This spec is safe only because
  its project is a fresh non-git `mkdtemp` dir. No `sqlite3` CLI → the spec skips itself.
- **`continuity_watch.rs` re-opens a replaced DB.** An open connection pins the old inode
  and `data_version` keeps answering from it, so the watcher compares the path's
  (dev, ino) every ~10 s on unix and blindly re-opens every ~30 s on Windows. The cursor
  survives a re-open (no history storm, no lost pulse).
- **`continuity_graph`/`continuity_tables` are async commands on the blocking pool**, and
  `project_toplevels` is memoized 30 s per (project, dir list) — one `continuity-changed`
  fans out into several reads, each forking `git rev-parse` per worktree. The frontend
  refetches are debounced with a 3 s ceiling (`debounce.ts`) so a steady stream still refreshes.
- **An ask for the terminal already in front of the user never becomes a card**: `App.tsx`
  `admitAsk` hands it off before `addAsk`. Listeners are registered before the
  `ask_pending` catch-up, and the "moved to the terminal" toast is for timeouts only.
- **Tables read through `continuity_tables.rs`, scoped by the same `resolve_session_ids` as the
  map, and refetch on `continuity-changed`.** Task "open" means status is not `completed` or
  `released` AND the claim is not past `expires_at`; continuity has no `expired` status, so
  expiry is computed on read and shown as expired, never written back.
- Design: `docs/superpowers/specs/2026-10-12-continuity-view-design.md`.

## Where Command Code lives

A sixth agent (`npm i -g command-code`), fronting ~58 models from one subscription.

- **The binary is `cmd`, which is unusable on Windows.** Use `agent::COMMAND_CODE_BIN`,
  never a literal: it is `cmdc` on Windows and `cmd` elsewhere, matching Command Code's own
  `getBinaryCommand()`. A bare `cmd` on Windows resolves to System32's shell, and Conduit
  spawns sessions as `cmd.exe /K "cd /d <dir> && <agent>"` -- so it would open a nested
  command interpreter instead of the agent.
- **Hooks:** `hooks::command_code_profile()` -> `.commandcode/settings.local.json`. Command
  Code implements Claude's hook SCHEMA, so the generic installer carries over, but it fires
  only FOUR events (`PreToolUse`/`PostToolUse`/`Stop`/`SessionStart`). Do not add Claude's
  others -- they would be dead keys in a file Conduit does not own. Consequence: no `prompt`
  verb, so a session reads `running` from its first tool call, not the keystroke.
- **Resume:** there is no `--session-id` to pin Conduit's id, so Command Code's own
  `session_id` is captured from the `SessionStart` hook body into
  `Session.agent_conversation_id` and replayed as `--session <id>`. This looks like agy's
  problem and is NOT: the payload and the hook URL carry both halves of the mapping in one
  request, so no baseline or filesystem scan is involved. `source != "resume"` is what lets a
  stale id be replaced instead of pinned forever.
- **Usage:** `commandcode_usage.rs` reads `api.commandcode.ai/alpha/billing/credits` with
  the key from `~/.commandcode/auth.json`. **Not `/alpha/usage/summary`** — that answers
  200 with a billing-period COST report (`totalCost`/`totalTokens`, no caps), so reading the
  quota from it misses on every poll and empties the meter. The caps are nested under
  `windowLimits` (`fiveHour`/`weekly`, each `used`/`cap`/`resetAt`); the parser accepts a
  bare top-level pair too, so the next move of this `/alpha/` surface degrades rather than
  blanks. `/alpha/` is an internal surface and WILL move, so
  every field is optional and an unknown shape degrades to `source: "unavailable"`.
- **Accounts:** an account's `config_dir` is `.claude`-rooted (see `default_profile_dir`),
  so a Command Code-tagged account hands the adapter a path Command Code cannot use — it
  has no config-dir override variable. `agent::command_code_profile_dir` is the ONE place
  that decides which profile such an account resolves to (its own `.commandcode`, else the
  ambient one), and both `command_code_profile_env` (spawn) and `commandcode_usage::auth_dir`
  (the meter) derive from it. They disagreed once: the session ran ambient while the meter
  looked inside `.claude`, found no `auth.json`, and dropped the account from the usage bar.
  Consequence worth knowing: tagging an account for Command Code does NOT yet give it a
  separate login — it inherits the ambient one.
- **Orchestration:** Command Code is a Tier-1 fleet agent, and the thing that makes it one is
  `ProviderAdapter::project_mcp_config_rel_path` -> `.mcp.json`. It has no `--mcp-config`
  flag, but it loads MCP servers from its CWD, and a fleet worker's CWD is its own worktree
  -- so `fleet::write_project_mcp_config` drops the same session-scoped fleet MCP server a
  Claude worker gets as a FILE instead of a flag, and that is what buys `fleet_result` +
  the mailbox. Two constraints hold it together: it is written ONLY on the Conduit-driven
  worktree path (the shared project root would hand every session in the project the same
  session-scoped URL, and drop an untracked file into the user's checkout), and the worker
  must be TOLD it has the tools -- `hooks::write_worker_brief_context` appends the brief to
  `AGENTS.md`, because there is no `--append-system-prompt-file` here. The capability card's
  `structuredResult`/`mailbox` claim is pinned to that seam by a test; if the seam goes, the
  card must go back to Tier 2 rather than lie to the router.
- **Models:** `model_for_tier` covers Command Code, and its ids are copied from
  `routing::default_routes` -- one opinion per agent, and a test fails if the two drift.
  `cheap` is `deepseek/deepseek-v4-flash` (its own default), NOT a Claude model: routing a
  fleet's mechanical work through Claude-on-Command-Code spends a frontier budget on exactly
  the work the capability card says not to. `fleet_spawn` also takes an exact `model`, which
  wins over the tier -- three tiers cannot name a 58-model catalogue. It is applied via
  `store.set_session_model`, not `set_session_trust`, which carries no `model` field.
- **Config GUI:** `commandcode_config.rs` + `CommandCodePanel.tsx` patch
  `~/.commandcode/config.json` behind a Rust-side allowlist, preserving unknown keys, backing
  up once, merging `featureModels` key-by-key, and refusing a file that does not parse.
  It never writes `settings.json` (team-committed, and its `hooks` key belongs to the hook
  installer).
- Design: `docs/superpowers/specs/2026-08-23-command-code-agent-design.md`.

## Where Hermes Agent lives

A seventh adapter (Nous Research, `hermes`), and the first one that arrived with a SUPERSET
of what Conduit needs rather than a subset. Every flag below was verified against the
installed CLI (`hermes --help`, `hermes chat --help`) and its own source, not from docs.

- **Resume is PINNED, not captured.** `hermes chat -c <session-id> --create-if-missing`
  means "resume the session titled `<id>`, creating it if absent", so the first spawn and
  every later one are the SAME command. agy and Command Code both need their chosen id
  scraped back after the fact; Hermes needs nothing, so **`Session.agent_conversation_id`
  is deliberately unused by this adapter**. Do not wire it in later "for consistency" --
  having nothing to capture is the feature.
- **Its config arrives as a MANAGED-SCOPE OVERLAY, never by editing the user's files.**
  Hermes has no project-scoped config; `hooks:` is read only from the profile's
  `config.yaml`, which is machine-wide -- writing there is the exact failure
  `hook_target_is_user_level` prevents for Claude. `HERMES_MANAGED_DIR` names a directory
  whose `config.yaml` is deep-merged PER LEAF on top of the user's, is read from the
  PROCESS env (so it is per-spawn), and is fail-open. `hermes.rs` writes
  `<dataDir>/hermes/<session_id>/config.yaml`; `remove_managed_config` reaps it with the
  session.
- **`on_session_end` is NOT the end of the session.** It is fired by
  `agent/turn_finalizer.py` ("run_conversation() runs once per message") and is the analogue
  of Claude's `Stop` -> verb `stop`. The real session boundary is `on_session_finalize`
  (`cli_session_mixin.py`) -> verb `sessionend`. Hermes' own telemetry agrees
  (`finish_task` vs `close_session`). Swapping them leaves every session reading `running`
  until the 20-minute stale watchdog, and fires `sessionend` after every turn.
- **Hooks run with `shell=False`** (`shlex.split`), so the POSIX and cmd.exe hook command
  forms are both wrong here -- no `${VAR}`, no redirection, no `|| true`. It is bare argv,
  and the session id is BAKED IN rather than read from the env. Consequence: no equivalent
  of Claude's endpoint-file layer that re-reads the live port at hook time.
- **The API key MUST ride the provider's OWN env var**, never a Conduit-private one.
  `hermes::key_env_var` maps preset -> `OPENROUTER_API_KEY` / `LM_API_KEY` /
  `OPENAI_API_KEY`. The first cut wrote `api_key: "${CONDUIT_HERMES_APIKEY}"` into the
  overlay, trusting its documented `${VAR}` expansion. The overlay IS applied (provider and
  base URL resolve from it), but Hermes' credential resolver never reads `model.api_key`
  from process env, so `resolve_runtime_provider` returned `api_key: ''` and the interactive
  startup gate offered its "no inference provider is configured" wizard over a fully
  configured endpoint. Measured: `CONDUIT_HERMES_APIKEY` -> `READY: False`,
  `OPENROUTER_API_KEY` -> `READY: True`. Do NOT set `OPENAI_BASE_URL` alongside it --
  `hermes_cli/main.py` reclassifies a resolved `openrouter` as `custom` when it is present.
- **A key is handed over ONLY when an endpoint is configured.** Hermes INGESTS an env key
  into its credential pool (`auth.json`), so a key passed to a session with no endpoint
  would register a credential for a provider the user never picked. It stores a
  `secret_fingerprint` + `source: env:<VAR>`, never the secret itself.
- **`pre_approval_request` is what buys the `needsInput` badge** Command Code never got:
  its payload carries no `notification_type`, and `status_rules::notification_status` reads
  an absent type as the legacy `needsInput`. `post_approval_response` -> `pretool` clears it.
- **`hooks_auto_accept: true` lives in the overlay, not in a flag.** Hermes prompts for
  consent per `(event, command)` and a spawn has no TTY to answer. `--accept-hooks` /
  `HERMES_ACCEPT_HOOKS=1` would auto-approve every hook in the MERGED config, including the
  user's own; scoping it to the overlay keeps the widening in a file Conduit owns.
- **Effort is spelled `--reasoning`.** That is why `ProviderAdapter::effort_flag` exists --
  an unknown flag does not degrade, it makes argparse exit and the session fall through to
  its bare `|| hermes chat` with the effort silently lost.
- **Accounts redirect `HERMES_HOME` only**, not `HOME` -- Hermes documents a config-root
  override, so the blast radius is one variable instead of the whole home. `hermes_home_dir`
  is the ONE place a `.claude`-rooted account resolves to a Hermes home (the Command Code
  trap: spawn and meter disagreed once and silently emptied the usage bar).
- Tier 2 on arrival, and the card says so: `hermes mcp add` works, but nothing has verified
  a Hermes worker against Conduit's fleet MCP server the way OpenCode's spike did, so
  `structuredResult`/`mailbox` stay false rather than lying to the router.
- Design: `docs/superpowers/specs/2026-09-19-hermes-agent-and-provider-routing-design.md`.

## Where per-agent model endpoints live

One agent, one endpoint: `ProviderSettings` (`store.rs`), stored as
`agent_providers: HashMap<AgentId, ProviderSettings>`. This generalizes the single
`OpenCodeSettings` slot, and OpenRouter joins the local servers as just another preset --
the same `@ai-sdk/openai-compatible` provider serves `https://openrouter.ai/api/v1` exactly
as it serves Ollama.

- **`PersistState.opencode` is KEPT and mirrors `agent_providers[OpenCode]`**, the same
  contract `default_account` has with `default_accounts[Claude]`. On load an
  `agent_providers` with no OpenCode entry adopts the legacy block. This is not tidiness:
  an unreadable `state.json` costs every running session (see the orphan sweep), so a
  downgrade must still find OpenCode's endpoint where it left it.
- **`pin_local` kept its wire name and lost its guarantee.** It emits
  `enabled_providers: ["conduit"]` -- "use only this endpoint", which under a local preset
  also means "nothing leaves the machine" and under OpenRouter does not. So it is NO LONGER
  the trust-boundary test: `ProviderSettings::is_local()` is, and a private-mode
  `local_only` session with a non-local endpoint has its routing DROPPED rather than
  honoured (both the Hermes and OpenCode spawn branches in `lib.rs`). Renaming the key
  would have silently reset the setting for everyone who had it on.
- The same rules exist in TypeScript in `src/providers.ts` -- standalone because `store.ts`
  cannot be imported under the node-env vitest, re-exported from the store so call sites
  keep one import path. `providers.test.ts` pins them. They must not fork from Rust's.
- **An agent reads its endpoint ONCE, at process start**, so "apply without restarting"
  can only mean Conduit restarts the session for you. `ModelPanel` does that when the
  session is IDLE and waits when it is mid-turn -- restarting a running agent throws away
  the work in flight, which is a worse surprise than a button.
- **`key_for_endpoint` is scoped by AGENT first, then URL.** Two agents may legitimately sit
  behind the same base URL (OpenRouter on both OpenCode and Hermes) with different keys; a
  URL-only match returned whichever the hash map yielded, which surfaces as an
  unexplainable invalid-credentials error.
- **`parse_openai_models` speaks three dialects**: vLLM's `max_model_len`, OpenRouter's
  `context_length`, and neither. Reading only vLLM's left all 400+ OpenRouter models with no
  context, price or tool flag -- exactly what the picker ranks on. `tools` comes from
  `supported_parameters`; its ABSENCE stays `None` ("unknown"), never `Some(false)`, because
  `pickable` treats an explicit false as disqualifying.
- **UI: one editor, two scopes.** `EndpointEditor.tsx` is the per-AGENT form, used by both
  Settings -> Model endpoints (`EndpointsPanel.tsx`) and the per-SESSION Model tab
  (`ModelPanel.tsx`), so the two cannot drift. The Model tab is session-scoped by
  construction and renders only controls the selected agent actually supports; with no
  session selected it shows a placeholder, never the global defaults -- it answers "what is
  THIS session running", and defaults there would make the answer a guess.
- `key_for_endpoint` (`local_llm.rs`) now searches every configured agent endpoint instead
  of only OpenCode's. The anti-oracle property is unchanged (an unrecognized URL still gets
  no key); hard-coding OpenCode's slot would have sent no key at all once a second agent
  had an endpoint.

## Where the money meter lives

`openrouter_usage.rs` + `usageRows::openRouterRow`. Every other meter measures a
SUBSCRIPTION -- a rolling window with a cap, where the number is "what fraction have I
burned". OpenRouter is prepaid credit, and that difference is structural, not cosmetic.

- **`UWindow.money` exists because a fraction cannot express it.** `GET /api/v1/key` reports
  `usage` plus a `limit`/`limit_remaining` that are **null for an uncapped key -- the normal
  state on a funded account**. With no cap there is no denominator, so the row sets
  `used: 0`, the panel draws NO bar, and the label reads "$12.40 spent". Never invent a
  ceiling to get a percentage: the provider explicitly declined to give one.
- **`quota` is `limit != null`.** An uncapped key gates nothing, so `rowHealth` reports
  `remaining: null` (unknown) rather than a confident 100% -- the same rule agents with no
  usage API already follow. Treating it as full would route work at an account with no
  money in it; treating it as empty would stop routing at one that has.
- **Keyed per AGENT** (`openrouter:<agent>`), not per account: two agents may hold two
  different keys against the same provider, and one account key would collapse them.
- Polled on the SLOW (5 min) tick with the other network reads. Prepaid credit only moves
  when a turn completes; a per-minute poll would spend requests watching a static number.
- **`visibleWindows` reads `show[kind] !== false`, not a truthy test.** Prefs persist per
  machine, so a prefs object written before a window kind existed has `undefined` for it --
  a truthy test hides a newly added meter from exactly the people already using the app,
  who never learn there is a switch to turn on.

## Where live model switching lives

`ProviderAdapter::model_switch_command` + `lib.rs`'s `switch_session_model`.

- **A restart is the FALLBACK, not the mechanism.** Model, endpoint and credentials are read
  once at process start, so Conduit cannot push a change into a running agent -- but every
  mature TUI here already solves that for itself with a slash command, and driving the
  agent's OWN command preserves the conversation by construction. Restarting applies the
  same model and throws away the context that motivated the change, which is exactly wrong
  for a task-driven "drop to a cheap model".
- **Returning `None` is a real answer.** OpenCode's `/models` opens an interactive picker
  and takes no argument, so its adapter reports None and the caller restarts. Do NOT invent
  a command: an unrecognized slash command is pasted into the composer as literal text and
  sits there, which reads to the user as "nothing happened".
- Claude gets `/model <name>` ONLY -- no provider (it has none) and no effort (a launch
  flag). Appending either hands its slash parser flags it rejects. Hermes takes all three in
  one command (`/model <m> --provider <p> --reasoning <e>`), session-scoped by default;
  `--global` is deliberately never sent, because a task-driven switch must not rewrite the
  user's `config.yaml` default.
- The choice is PERSISTED before it is sent, so a later restart or a `session_budget` reap
  comes back on the model the user picked rather than the one the session launched with.
- **Every configured endpoint is written into the agent's config, not just the active one.**
  `/model --provider` can only reach providers ALREADY in the config, so one endpoint per
  agent left the provider half of a live switch unreachable. See "Where the endpoint pool
  lives" below.

## Where the endpoint pool lives

An agent has a LIST of endpoints (`PersistState.agent_endpoints`) and one of them is ACTIVE
(`agent_providers`, unchanged). The pool exists for one reason: an agent's own
`/model --provider` only reaches providers already present in its config, so a session that
launched against Ollama could never be moved to OpenRouter without a restart -- which throws
away the context live switching exists to preserve.

- **`#[serde(default)]` and seeded on load** (`seed_endpoint_pool`, pure/tested). A
  `state.json` written before the pool has an active endpoint and no pool; without the seed
  the list renders empty beside a session demonstrably talking to something, and the first
  write drops the endpoint in use. An agent that already HAS a pool is left alone -- newer
  state wins, the same rule `adopt_legacy_opencode` beside it follows.
- **`set_provider_settings` rewrites the pool entry that WAS active** rather than appending.
  Appending forks the endpoint: the pool keeps the old values and `endpoint_pool` adds the new
  ones beside them, so one endpoint appears twice and the stale copy is still offered as
  somewhere to switch to. Matching on the NEW url instead leaves a renamed endpoint as a ghost.
- **Keys are per (agent, BASE URL)**, not per agent (`key_slot`). A pool routinely holds a
  keyed cloud endpoint beside a keyless local one, and may hold two cloud endpoints with two
  keys; collapsing them onto the agent hands one endpoint's key to another, which surfaces as
  an unexplainable 401. The one exception is `promote_unbound_key`: a key typed BEFORE any URL
  exists lands in the agent's empty slot and is moved onto the first endpoint it gets. That is
  deliberately NOT a general "follow the active endpoint" rule -- that would carry a cloud key
  onto a local server the moment the user switched preset.
- **Hermes reaches them through a `providers:` MAP in the managed overlay**, one entry per
  pooled endpoint keyed `conduit-<preset>`, each naming its own `key_env`. Verified against the
  installed CLI, not docs: `providers:` merges per leaf, `get_compatible_custom_providers`
  normalizes the entries, and `custom_provider_slug` derives a stable `custom:<key>` slug from
  the entry KEY -- which is what `/model --provider` takes. A Conduit-private variable is
  CORRECT here and does NOT contradict `key_env_var`'s warning: that failure was
  `model.api_key: "${VAR}"`, a mechanism the credential resolver never consults, whereas a
  `providers:` entry NAMES its variable and is read with `get_secret_str`. A test pins the slug
  and env-var format, because a drift makes `/model --provider` silently reach nothing -- the
  switch is accepted and the endpoint does not change.
- **The silo filters the POOL, not just the launch endpoint.** A local-only session under
  private mode gets only local endpoints written into its config; otherwise the launch-time
  `is_local()` check is decoration, because the agent is one slash command away from routing
  siloed work through OpenRouter.
- **A live switch persists `Session.provider`.** `/model --provider` moves the running
  process, but the next start reads the AGENT's active endpoint -- so without the pin a
  restart silently moves the session back, with a model pinned that the original endpoint may
  not serve. `session_endpoint` resolves it, falling back to the active endpoint when the
  pinned slug names nothing (a deleted endpoint must degrade to "the normal one", never to
  "no endpoint at all").
- **`add_session` takes `provider`, resolved by `resolve_provider_slug`.** A caller types what
  it knows (`openrouter`); the stored pin must be the slug `pooled_provider_slugs` produces or
  `session_endpoint` never matches it. Both spellings resolve, and an unknown name passes
  through rather than being dropped. It rides the CREATE call for the same reason `model` does
  -- set afterwards, the terminal has already spawned.
- **`ProviderAdapter::pooled_provider_slugs` is the seam**, and all-`None` is a real answer:
  OpenCode's `/models` takes no argument, and every other agent reads its endpoint once at
  process start. An invented slug would render an enabled chip that silently does nothing.
- UI: the pool list in `EndpointsPanel.tsx` (clicking a row makes it active, which is also
  what points the editor below at it -- two ways to edit one endpoint is how the two end up
  disagreeing), and the endpoint chip row in `ModelPanel.tsx`, which carries the endpoint's
  OWN pinned model across: a model id served by Ollama is not one OpenRouter serves.

## Where spawn conditions live

`OpenRequest` gained `provider`/`model`/`effort` (`cli_open.rs`), carried by both shims, so
ONE agent can launch another under conditions it chose -- a Hermes session on a local model
starting a worker on OpenRouter.

- All three are `#[serde(default)]`: the shim is GENERATED and an older installed one sends
  only `path`+`agent`. Without that, every `conduit .` from a stale shim would 400. A test
  pins it.
- `parse_open` stays purely the security boundary (token, origin, body size) and does NOT
  validate them -- whether "gpt-9" is a real model is a question only the agent can answer.
  The FRONTEND re-checks the agent id against `AGENTS` before spawning, the same rule
  `decisionRoute` follows: `AgentId`'s lenient deserialize would otherwise spawn Claude
  under an invented name.
- The model rides in `addSession` rather than being set afterwards, so the session is
  created WITH it instead of being corrected after its terminal has already spawned.

## Where the agent profile panel lives

`agent_profile.rs` + `AgentPanel.tsx` -- the Agent tab. The Model tab answers "what is this
running on"; this answers "what does it know and what can it reach".

- **Adaptive, and an empty section is OMITTED rather than drawn empty.** Agents expose very
  different things, and a blank "Memory" heading reads as "this agent forgot everything"
  rather than "this agent has no such concept". Rust returns only sections it could fill.
- **Sections come from whoever holds the data.** Hermes' memory/skills/MCP are files, so
  Rust reads them; Claude's MCP registry is localStorage, so the frontend composes that
  section itself. The frontend skips its own MCP section when Rust already supplied one, so
  an agent is never listed twice under two sources.
- Hermes' three memory documents are listed SEPARATELY (`SOUL.md` = what you told it,
  `USER.md` = what it inferred about you, `MEMORY.md` = what it remembered). Merging them
  would hide the inferred one, which is the one worth checking.
- **MCP is read from `config.yaml`, not `hermes mcp list`** -- the CLI costs a Python
  process start (seconds) and this panel refreshes while open.
- `serde_yaml` parses what OTHERS wrote (skill frontmatter, Hermes' config); `hermes.rs`
  still hand-emits its overlay, because that file carries an explanatory header comment a
  serializer would drop and its values are three known scalars.
- **Memory documents and SKILL.md files are EDITABLE; everything else is read-only.** An
  unreadable file costs that section, never the panel. A truncated preview is never written
  back -- the UI refuses to save one, which is why the caps (`MEMORY_PREVIEW_BYTES`,
  `SKILL_PREVIEW_BYTES`) are generous enough that truncation is rare.
- **A skill is located by ENUMERATION, never by joining its key onto a path.**
  `hermes_skill_dirs` walks the tree and the frontend's key is compared against the directory
  names it found; a key matching nothing is refused. Same shape as `MEMORY_DOCS`, and for the
  same reason: "sanitize the path" is a guess about what the OS does with `..`, a symlink, an
  ADS or a UNC prefix, whereas a path Conduit produced has nothing to sanitize. The key is
  the DIRECTORY name because Hermes' own predicate (`prompt_builder.hides`) accepts either it
  or the frontmatter name, and only the directory name always exists -- a skill with
  unparseable frontmatter still lists.
- Editing a SKILL.md takes effect on its own: Hermes' snapshot manifest
  (`_build_skills_manifest`) is a file signature of every SKILL.md, so a write invalidates the
  cached prompt rather than being masked by it.
- **Skill enable/disable is SHOWN but not editable, and that is a measured limit rather than
  a gap in the UI.** `skills.disabled` is read by the agent side straight out of
  `HERMES_HOME/config.yaml` (`agent/skill_utils.py::_load_raw_config`, whose docstring says
  "no hermes_cli.config import"), so the managed-scope overlay -- a `hermes_cli.config`
  feature -- never reaches it. Measured: an overlay carrying `skills.disabled: [findmy]`
  leaves `get_disabled_skill_names()` empty, while `hermes_cli`'s own
  `get_disabled_skills(cfg)` sees it. `get_config_path()` is strictly
  `HERMES_HOME/config.yaml` with no override, so the only ways to change what the AGENT sees
  are writing the user's own config (machine-wide) or redirecting `HERMES_HOME` (moves
  memory, skills, sessions and auth too). Both are the user's call, not a side effect of
  opening a panel -- so the panel dims a disabled skill and says where it was turned off.
  `ESSENTIAL_SKILLS` is kept for whatever surface eventually does offer the switch:
  `save_disabled_skills` drops those SILENTLY, so a control offered for one would flip, save,
  and come back on with no error anywhere.

## Where agent routing lives

Task-shaped preferences: a task kind (planning / implementation / review / research /
bulk) maps to an ORDERED chain of targets (agent + optional model). The order IS the
fallback, so one list covers preference, a missing CLI, and a spent quota.

**The work is split across two languages and must not become a fork.** Rust
(`routing.rs`) owns WHAT the preferences are -- built-in defaults, overlaid by global,
overlaid by project, all sparse so an override of one kind keeps inheriting the rest.
TypeScript (`src/routing.ts`, `pickTarget`) owns WHICH target is usable right now, because
that needs the live usage snapshot already in the store. Neither re-implements the other.

- **Defaults derive from `agent::capability_card`**, so an opinion about an agent lives in
  one place. A default chain must reach a SECOND AGENT, not just a second model -- one
  agent's windows all close together, so a Claude-only chain is not a fallback. A test
  enforces it.
- **Unknown quota is not exhausted quota.** Agents with no usage API carry
  `remaining: null` and stay routable; treating null as 0 would silently make "no meter"
  mean "never route here".
- `usageRows.ts` holds the shared "how full is this account" arithmetic so the usage bar
  and the router cannot disagree. `--model`/`--effort` are gated by
  `ProviderAdapter::supports_model_flags`, not by naming Claude.
- Design: `docs/superpowers/specs/2026-08-23-agent-routing-preferences-design.md`.

## Where the rich session view lives

An opt-in pane (`SessionChat.tsx`, Settings -> General) that renders a session's
conversation instead of its terminal output, fed by `transcript::session_transcript` over
the JSONL Claude already writes. No model generates it and none summarizes it -- it is a
renderer over a file, and costs nothing.

**It covers the terminal; it never replaces it.** The pane is an absolutely positioned
sibling inside `.term-host`, so the xterm stays mounted and attached (the keep-alive rule
above). Two consequences worth keeping: a session revealed with the pane open must not pull
terminal focus, or the caret lands behind the pane -- and that check reads a REF, since
adding it to the reveal effect's deps would re-run a fit and its spawn branch on every
toggle. Claude-only, enforced in `session_transcript` rather than assumed in the view.

## Where session hibernate + the per-session MCP allowlist live

Stopping a session's processes without deleting it, and letting a session declare which MCP
servers it loads. Both are driven by two `#[serde(default)]` fields on `Session`
(`store.rs`): `stopped` and `mcp_servers`.

- **Hibernate.** `stop_session` / `start_session` / `stop_idle_sessions` in `lib.rs` (bulk
  selection is the pure, tested `idle_stop_targets`). They call **`PtyManager::retire`, never
  `kill`** — the two share one `tear_down` and differ only in `Teardown::keeps_snapshot()`.
  `kill` is DESTROY and deletes the scrollback snapshot; a retired session must keep it, so it
  comes back like one `session_budget` reaped or one that lost its tmux server to a reboot.
  **Do not "simplify" a retire into a kill.** The frontend must not tear down either: the
  `stopped` effect in `Terminal.tsx` only manages the pane, because a stray `pty_kill` there
  would destroy the snapshot the command just preserved.
  The keep-alive rule is otherwise unchanged: tab switches, layout changes and directory
  changes must still never touch an agent terminal. The effect fires on *transitions* only
  (`prevStoppedRef`); the pane is cleared at the NEXT spawn (`resetOnSpawnRef`), not at the
  stop, because a resume is a cold spawn whose first frame is the snapshot replay — clearing
  late is what stops the same screen printing twice. Opening a stopped session resumes it
  (`selectSession` / `openToSide` clear the flag); the eager restore-on-open effect skips it,
  which is why `stopped` is persisted rather than component state.
- **MCP allowlist (Claude only).** `agent::session_mcp_config_json` builds a per-session
  `--mcp-config` file (merging the fleet block when the session has one); `pty_spawn` writes
  it and sets `strict_mcp`, which appends `--strict-mcp-config` in `build_script` /
  `build_script_win`. The **store** owns which names apply; the frontend only sends the
  registry definitions to resolve them against (the registry lives in localStorage). `None`
  and `Some(<every server>)` are NOT equivalent — strict mode also suppresses a repo's own
  `.mcp.json` — so "every box checked" must serialize to `None`. UI: `NewSessionDialog`.
  **`--strict-mcp-config` also suppresses PLUGIN-provided MCP servers** (measured against
  Claude Code v2.1.222; `--mcp-config` alone does not, so the Conductor path is unaffected).
  Continuity arrives that way, and the failure is silent — its skills and prompt still load,
  so the session believes it has tools it cannot call. `agent::plugin_mcp_servers` therefore
  folds the plugin's own `.mcp.json` into the generated config. If another plugin ever ships
  MCP tools, it needs the same treatment.

Design: `docs/superpowers/specs/2026-08-13-session-hibernate-and-mcp-allowlist-design.md`.

## Where multi-account assignment lives

Accounts are per-agent profile pointers (`Account { agents, configDir }`, `store.rs`), assigned
per session (`Session.account_id`) or per project (`Project.default_accounts`), resolved at
spawn by `session_account_config_dir` (session -> project default -> global default -> env).
The account->env redirect is the `ProviderAdapter::account_env` seam (`agent.rs`) -- Claude +
agy override it; a future agent implements only that method. UI: `AccountList.tsx` (registry,
agent tags, per-agent + per-project defaults), the new-session dialog picker, and the
right-click "Account" submenu in `Sidebar.tsx`. Design:
`docs/superpowers/specs/2026-07-12-multi-account-orchestration-design.md`.

## Where the launch selection lives

Which project a cold start lands on. `store.load()` used to take `projects[0]`, so the
TOPMOST project opened (and, under `restoreSessionsOnOpen`, every one of its sessions
spawned) no matter what the user was last in — and a sidebar drag-reorder silently changed
which project launched.

- The decision is `initialProjectSelection` in `src/startup.ts`, kept pure because
  `store.ts` cannot be imported under the node-env vitest (it touches `localStorage` and
  the Tauri bridge at module scope). `src/startup.test.ts` covers it.
- **A stale or absent memory resolves to `null`, never to `projects[0]`.** Falling back to
  the first project is the exact bug; a fallback would reproduce it once on every machine's
  first launch after the change and then hide it. `null` is also free — no selected project
  means `Terminal.tsx`'s eager-spawn effect (`projectId !== selectedProjectId`) starts
  nothing, and `WorkspaceCenter` already renders an empty state for it.
- **The memory is written by a `useStore.subscribe` at the bottom of `store.ts`, not by
  each action.** Seven code paths move `selectedProjectId` (select project/session, open to
  side, add project, add session, reopen closed tab, remove project); a memory six of them
  forget to update is worse than none.
- User-facing switch: `openBehavior` (`"last"` default | `"none"`), Settings → General.

## Where session restore + safe shutdown lives

VSCode-style "reopen where I left off" + a running-agent quit guard (Claude + agy; others
deferred). Opening a project eagerly spawns all its sessions (`Terminal.tsx`'s
`spawnPty`/eager effect, gated by `restoreSessionsOnOpen`; Settings -> General). Resume:
Claude via `claude --resume <conversation>` (see "Where conversation continuity lives" -- it
is NOT always the session id), agy via `agy --conversation=<uuid>` threaded as
`resume_token` through `spawn` -> `build_invocation`. agy won't let us pin our own id, so the
`agyusage` hook captures the id agy chose from `~/.gemini/antigravity-cli/conversations/<uuid>.db`,
disambiguated by a spawn-time baseline (`agy_usage::AgyResumeState`) so two sessions sharing an
agy home don't cross-capture (`Session.agent_conversation_id`). Shutdown: `lib.rs`
`live_running_agent` (fleet `running_sessions` cross-checked against a live PTY) gates
`CloseRequested`/`menu.rs` quit; `App.tsx` shows the confirm. agy activity reaches the guard via
its status-line `agent_state` (`agy_usage::agent_state_is_active` -> `FleetState::set_running`),
since agy fires no Claude-style lifecycle hooks. Design:
`docs/superpowers/specs/2026-07-12-session-restore-and-safe-shutdown-design.md`.

## Where the session status rules live

The per-session status (`idle`/`running`/`needsInput`/`done`) is derived TWICE from the same
hook stream — `fleet.rs`'s `apply_event` (what `fleet_list` and the Conductor read) and the
`switch` in `App.tsx` (what the sidebar dot renders). The time-aware rules that govern both
live in **one module per side and must not fork**: `src-tauri/src/status_rules.rs` and
`src/statusRules.ts`. They own three things — the 20-minute stale-`running` watchdog (swept by
`FleetState::sweep_stale_working`, broadcast as the `session-stale` event so the frontend map
agrees), the 3-second done-holdoff against out-of-order tool hooks, and the classification of
`notification` by `notification_type` (`idle_prompt` only ever retires a stuck turn; unknown
types are a no-op). Design:
`docs/superpowers/specs/2026-08-10-nodeterm-lessons-round-2-design.md`.

## Where the transcript readers live

Four separate consumers read Claude's transcript store, and all of them resolve it per
session (`pty::session_projects_dir`: `<account cfg>/projects`, else `pty::claude_projects_dir`)
because a session on a non-default account writes elsewhere. The per-session readers look up
`store.claude_conversation_id(session)`, **never `Session.id`** — after a `/clear` the session's
own id names a conversation it has left (see "Where conversation continuity lives"):
`transcript.rs` (mobile chat items), `context_window.rs` (the per-tab context meter — scans
BACKWARDS with a substring pre-filter and reads only the trailing 1 MB; the window is resolved
by model FAMILY because Claude Code runs opus/sonnet at 1M while the id stays bare), `subagents.rs` (the right panel's
Agents tab), and `transcript_index.rs` (palette search over past conversations). All are
read-only and degrade to "show less" rather than erroring.

## Where conversation continuity lives

A Claude session's FIRST conversation is pinned to `Session.id` (`--session-id`), but it does
not stay there: `/clear`, a plan accepted with "clear context", an in-TUI `/resume`, and a
failed `--resume` that falls through to the bare `|| claude` all continue under a NEW id.
Conduit used to resume the pinned id forever, so every restart reopened the conversation from
before the last clear and the work since looked lost.

- **Capture:** the `sessionstart` hook body carries Claude's `session_id`;
  `hooks::claude_conversation_update` (pure, tested) decides Keep / Reset / Adopt and the
  result lands in `Session.agent_conversation_id` — the same field agy and Command Code use —
  and is saved at once. It is deliberately NOT keyed on `source`: every source that changes
  the id must be followed, and the ones that don't report the id already held. Refused when
  another session owns the id (`claude_conversation_claimed_elsewhere`, which counts PINNED
  ids too). `startup` with a new id while the previous transcript exists means the resume
  failed; the `conversation-restarted` event makes `App.tsx` say so.
- **Resume:** `ClaudeAdapter::build_invocation` resumes `resume_token` when its transcript
  exists, else falls back to the old pinned-id logic unchanged.
- **Readers:** everything that opens a session's transcript goes through
  `store.claude_conversation_id`; `search_transcripts` maps a hit back with
  `session_for_conversation`.
- **Repair for sessions that drifted before the capture existed:** `conversation_repair.rs`.
  The link is exact: Claude's `<cfg>/history.jsonl` records `/clear` WITH the id it was typed
  in, and the conversation it starts opens with a `SessionStart:clear` record within
  milliseconds. Pre-fix restarts resumed the pinned conversation and users cleared it again, so
  the clear history FORKS — the newest branch is offered first, older branches (often the
  "lost" work) as alternatives. `ConversationRepairNotice.tsx` offers them once per launch;
  switching is explicit (`adopt_claude_conversation` validates, then stop + start restarts the
  agent). Root chats (`root_chat.rs`) still resume their pinned id.
- **state.json hardening:** `save` fsyncs the temp file before the rename and keeps a rolling
  `state.json.bak` (refreshed at most every 5 min, never from an unparseable file); `load_state`
  falls back to it when state.json exists but will not parse — an empty store is what makes
  the orphan sweep kill every live session.
- E2E: `e2e/conversation-continuity.e2e.ts` (hermetic: the session runs under a temp account).

## Where session persistence's safety net lives

`tmux.rs` wraps spawns; two modules keep that honest. `scrollback.rs` persists 256 KB of each
terminal's recent output (cut on a UTF-8 boundary) and replays it into the FIRST frame of a
COLD spawn only — warmth is decided by `tmux::has_session` BEFORE the wrap, since
`new-session -A` erases the difference afterwards. `session_budget.rs` retires abandoned
sessions under memory pressure. Its safety contract is load-bearing: a reap kills the tmux
session and **nothing else** — never the snapshot, never the session record — so a reaped
session is indistinguishable from one that lost its tmux server to a reboot. `pty::kill` (a
destroy) is the only place a snapshot is deleted; `pty::retire` is the same teardown with the
snapshot kept, and is what user-initiated hibernation uses (see "Where session hibernate …"
above). Automatic reaping and a deliberate stop end in the same state on purpose — one
restore path, not two.

Two things about the budget are easy to get wrong and are now pinned by tests:

- **It counts SESSIONS, not tmux sessions.** Conduit creates two tmux sessions per Conduit
  session (the agent and its `__term` companion shell), so counting tmux sessions made
  `max_detached: 24` really mean twelve. Worse, a companion shell is a login shell that goes
  quiet the moment you stop typing, so it dominates the least-recently-active sort — a batch
  could spend itself killing four ~1 MB shells while the ~300 MB agents beside them survived.
  `group_sessions` collapses the halves: a group is attached if EITHER half is, its activity
  is the LATER of the two, and a reap takes both names.
- **The macOS pressure reading asks the kernel, not `vm_stat` arithmetic.**
  `free + inactive + speculative` is a Linux-shaped stand-in and it reported 7.4 GB
  "available" on a 24 GB Mac at 20.7 GB used with 7.8 GB of swap, because on a
  compressed-memory system "inactive" is not "free". `kern.memorystatus_vm_pressure_level`
  (`MemInfo.kernel_warned`) is the same verdict Activity Monitor's graph shows. The
  watermark still applies; the kernel's warning is an additional trigger, and an
  unrecognized level is NOT read as pressure — same principle as an unreadable figure.

**The orphan sweep is why `state.json` must never fail to parse.** A `Store` that fails to
load is an EMPTY store, every live tmux session is then an orphan, and the startup sweep kills
every running agent — so a single unreadable value costs the sidebar AND every session.
serde aborts the whole document on one bad value and `#[serde(default)]` does not help (it
covers an ABSENT field, not an unknown VALUE). `store::PersistedEnum` +
`deserialize_lenient` make the persisted string enums (`AgentId`, `SessionRole`, `Clearance`)
degrade to their default instead; a downgrade past a newly added agent is all it takes to
produce the bad value. The lenient read lives on the TYPE, not on a field's
`deserialize_with`, because `AgentId` is also a map key (`default_accounts`). New persisted
string enums must implement it, and a round-trip test pins the hand-written `from_wire`
against the derived `Serialize`.

A reap is logged unconditionally (`[reap] retired …`). It is rare, and after the fact a
reaped session is indistinguishable from one that lost its tmux server — so without a line
in the log there is no way to tell "the budget acted" from "the budget never ran", which is
exactly the question a host hoarding agents raises. `grace_sec` and `interval_sec` join
`disabled` / `min_available_mb` / `max_detached` as env overrides
(`CONDUIT_SESSION_REAP_*`), because this policy is only observable by watching it act and a
six-hour grace makes that untestable against a real socket without waiting six hours.

One tmux rule outranks the rest: **`wrap_command` must `cd /` before `exec`ing tmux.** The
client that happens to start the server donates its cwd for the server's whole life, and
Conduit spawns from session directories — so the donor is routinely a worktree. Once that
worktree is deleted the server holds a dead inode and every pane it later forks inherits it
*in preference to `-c`* (tmux 3.7b), which is why new terminals greeted users with
`shell-init: error retrieving current directory: getcwd`. An already-poisoned server keeps
the bad cwd until it is killed — the fix only prevents new ones.

## Where the fleet/Conductor orchestration lives

A per-project **Conductor** (a Claude session flagged `role: Conductor`) observes and
commands the fleet through five MCP tools (`fleet_list`/`fleet_peek`/`fleet_spawn`/
`fleet_send`/`fleet_stop`) served by an in-app HTTP MCP server. As shipped (v0.3.0):

- Rust: `src-tauri/src/fleet.rs` (status mirror, `CONDUCTOR_PERSONA`, worker cap, human
  confirm handshake), `src-tauri/src/fleet_mcp.rs` (the MCP server + tool dispatch),
  `Session.role`/`SessionRole` in `store.rs`.
- The Conductor is currently **Claude-only, spawns only Claude workers**, and hands back
  nothing structured — only a lossy terminal scrape via `fleet_peek`. See
  `docs/superpowers/specs/2026-06-30-conductor-design.md` for how it actually works today.

**A follow-on redesign is planned but NOT implemented** (as of this writing): heterogeneous
(5-adapter, tiered) workers, a project-scoped result/mailbox blackboard, and a per-agent
usage bar. Read `docs/superpowers/specs/2026-07-04-orchestration-v2-design.md` and its
`2026-07-05-orchestration-v2-scope-expansion-design.md` companion (+ matching plan docs)
before touching `fleet.rs`/`fleet_mcp.rs`/`agent.rs`'s adapter dispatch — there's a
confirmed, not-yet-fixed cross-project security leak in `fleet_peek`/`fleet_send`
documented there (SPEC-0), and a caller-role guardrail gap in `dispatch_tool` that any
change granting a worker MCP access must close (design doc §2.0). Short index:
`claude_docs/feature-6-orchestration-v2.md` (gitignored, not committed).
