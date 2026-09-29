# Orchestration policy implementation plan

Date: 2026-09-29  
Companion: `docs/superpowers/specs/2026-09-29-orchestration-policy-design.md`  
Status: proposed sequence; P1 code has not started

## Branch and review sequence

Treat P1-P7 as separate, focused upstream PRs. Refresh `origin/main` before each branch, use an isolated worktree, and never base a PR on the local build branch. Port an accepted PR to the local build line separately. Do not push or merge without authorization. P0 lint, hooks, model, and quota branches in the external ledger were local as of 2026-09-29; inspect upstream before depending on them. If a phase needs an unmerged P0 seam, use an explicitly labeled temporary stacked branch for development, then restack onto updated `origin/main` before its PR. Show the exact base and dependency in each PR. P1 policy and display can start on clean upstream; gate any Codex meter integration on the actual P0.2 landing.

Sequence: P1 -> P2 -> P3. Run read-only P4/P5 spikes alongside P2/P3; they do not block those phases. Land P4 and P5 only after their adapter proofs. P6 follows the routing and permission seams of P3; P7 follows ledger and adapter work in P2/P5. This is an ordering of dependencies, not one combined PR. Preserve a spec and focused plan per implementation PR if its scope changes.

For every PR: tests for pure Rust/TypeScript logic; `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, and `cargo test --manifest-path src-tauri/Cargo.toml`. Run the UI in `ConduitTauri-dev` and inspect actual tab/board/settings behavior; check both macOS and Windows CI for platform code. Explain measured versus proposed CLI behavior. Keep changelog bullets under `## Unreleased`, with no version bump; use scoped Conventional Commits, no attribution.

## P1: policy data, Settings, context display

1. Capture baseline fixtures for old `state.json`, existing `routing.rs` overlays, missing context, and current `MAX_WORKERS` behavior. Confirm where global/project route state is persisted in `store.rs` and how Settings selects a project.
2. Add `orchestration_policy.rs` with versioned sparse structs and one merge function (defaults -> global -> project), mirroring `routing.rs`. Add `#[serde(default)]` to every persisted field; implement `PersistedEnum` for every new persisted enum. Keep all switches off, all limits inactive, and old startup behavior unchanged. Test omitted fields, field-level inheritance, explicit reset, invalid values, and old/new round trips. Do not put untrusted imported JSON directly into `state.json`.
3. Add read/write/export/import-preview commands and a `PolicyView` containing default, global, project, effective, and provenance. Validate the entire import before any write; define atomic save and rollback on failure. Test that a bad import cannot cause startup parse failure or erase existing sessions.
4. Add Settings -> Orchestration in `src/components/Settings.tsx`, a dedicated panel, and a command-palette entry. Mirror the scope and reset language in `RoutingPanel.tsx`; link to routes instead of duplicating route editing. Make disabled enforcement and unsupported adapter capabilities explicit. Test pure form conversion/validation; launch the isolated app for interaction checks.
5. Extend `context_window.rs`'s read model or add a provider dispatcher around it. Keep quota in `usageRows.ts` distinct from context. Reuse `lib.rs::session_context`/`store.ts::sessionContext` where compatible. Verify Codex rollout and agy status attribution with fixtures and live CLI evidence; return unknown on ambiguity. Render measured context on tab and board card without changing terminal mounting. Test parser edge cases, stale/missing files, and observed window. If a provider cannot be verified, ship its Unknown state and record the gap.
6. Review P1 diff specifically for zero enforcement when off and for `state.json` backward compatibility. Run full gates and isolated UI check before claiming P1 complete.

## P2: warnings, checkpoints, handoff, rollover

1. Add a pure budget decision function over policy, fresh context reading, session role, and idle evidence. Test below target, target crossing, hard-cap pending, unknown, stale, and off cases. Keep the warning and cap separate.
2. Define a bounded, project-contained ledger schema and collision-safe path under `docs/handoff/`; implement periodic checkpoint storage without blocking the UI. Worker briefs in `fleet.rs` name budget and ledger format. Confirm Claude Stop-hook events and per-adapter idle signals before using them.
3. Implement the state machine: checkpoint -> final ledger or last valid checkpoint -> idle confirmation -> `PtyManager::retire` -> fresh session with ledger pointer. Reuse `stop_session` semantics and never call `kill` for rollover. Test failure between every transition, duplicate events, restart recovery, and scrollback preservation.
4. Show waiting/ready/error state and allow manual completion when a hook or idle signal is unavailable. Run a real isolated app rollover on at least one supported adapter; defer automatic rollover for unsupported adapters.

## P3: capacity, claims, retries, quota pause

1. Add optional effective fleet caps and keep fixed `MAX_WORKERS` on the off path. Gate `fleet_spawn` server-side with atomic reservations and release on failure/retire. Test concurrent spawn, project versus repo identity, and all role caps.
2. Add file-claim registry with canonical repo/checkout identity, lease, and owner; default policy can require isolated worktree writers. Wire a verified Claude PreToolUse denial and PostToolUse clash warning. For other agents, use verified native enforcement or restrict to isolated worktrees; label advisory cases. Test cross-project access denial and stale claims.
3. Persist per-task failed-round count and stop redispatch after the configured limit. At enabled low quota, checkpoint and hibernate through retire. Treat missing quota as unknown, not low. Test restart and rate-limit races.

## P4 spike and implementation: conductor adapters

1. Make a capability matrix for `ProviderAdapter` config injection and instruction injection. Probe each installed CLI against a real fleet server: scoped list/peek, spawn, result, role denial, restart, and Windows/macOS launch form. Save command/version/evidence in the eventual phase spec.
2. Only for proven adapters, replace the Claude-only `lib.rs` gate with an explicit capability and add generated config/persona paths. Keep `fleet_mcp.rs` authorization as the final guard. Test a worker cannot gain orchestration tools and a conductor cannot cross project scope.

## P5 spike and implementation: front chat adapters

1. Probe `codex exec --json`, `agy -p --output-format json`, and other candidates on installed versions for bounded output, failures, cancellation, and cost. Do not rely on unverified flags.
2. Define a versioned brief parser with all required contract fields. Route parsed proposals through `proposals.rs`, strict IDs, project-owned approval cards, and approval-time `pendingDecisionRouting.ts`. Keep root MCP dispatch optional; test malformed/truncated blocks and a card for a different selected project.
3. Verify an end-to-end conversation, approval, spawn, and restart in the isolated app for each enabled adapter.

## P6: critique and write authority

1. Add Critique to `routing.rs::TaskKind`, its UI, `root_mcp.rs` schema, and any exhaustive matches, with migration that leaves old Review routes intact. Add provider-different resolution in `src/routing.ts` and explain no eligible route.
2. Probe read-only flags and actual filesystem denial for each proposed adapter. Add per-route write authority only for proven enforcement paths; fallback writing requires worktree isolation. Store reviewer/provider and check results on completion, and block any policy-gated merge until required review exists.
3. Test same-provider exclusion, unknown provider, unavailable read-only mode, and worktree-only fallback. Never infer that a favorable review authorizes an automatic merge.

## P7: portable project context

1. Read project instruction-file presence and approximate token sizes without modifying files. Verify each adapter's actual rule-file loading and show Unknown where unproved. Add a Context files view and explicit-click create/import actions; test no writes on mere inspection or spawn.
2. Add project state and ledger views with provenance. Reuse `transcript.rs` for Claude and verified Codex rollout readers; add other readers only after fixture validation. Keep source project permissions on every transcript and summary request.
3. Implement Continue in another agent: source ledger if available; otherwise an explicitly marked transcript-derived draft from a different quota pool, user review, then new session with ledger pointer. Test absent source, quota failure, partial transcript, and private-memory exclusion.

## Release checks across the series

At every phase, assert that missing policy reproduces current behavior, that unknown measurements are visible but do not trigger enforcement, and that a failed operation leaves the original session recoverable. Record any adapter capability as **verified on a named CLI/version** or **proposed**. Keep owner-specific defaults in an exportable profile, outside Conduit's built-in defaults.
