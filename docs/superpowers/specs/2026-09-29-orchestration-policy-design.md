# Orchestration policy and multi-vendor handoffs

Date: 2026-09-29  
Status: design for P1-P7; no implementation in this document

## Goal and boundary

Conduit supplies routing, fleet, metering, and lifecycle mechanisms. The user chooses the policy. A fresh install and an existing `state.json` must behave as they do today until a user enables each new behavior. This design covers P1-P7 of the 2026-09-28 orchestration handoff. Its example values are an owner's proposed policy, not product defaults: worker target 100k tokens, hard cap 150k; planner under 60k; one writer per repo, four readers, one critic; two failed rounds; Claude writes by preference, with a worktree-only fallback and Claude review before merge. None of these values should be hardcoded into Conduit's built-in behavior.

The brief is a typed contract: goal, definition of done including checks, destination (local build or upstream PR), audience, scope and length, accepted risks, budget, and FAST/NORMAL/DEEP mode. The same object feeds front chat, proposal card, worker prompt, ledger, and review. A missing required field produces a draft to complete, not a silently guessed value. Human approval remains at the existing proposal boundary.

## Current evidence and proposed behavior

| Seam | Verified in this checkout | Proposed |
| --- | --- | --- |
| Routing | `routing.rs` overlays built-in, global, and project `AgentRoutes`; `src/routing.ts` selects a currently usable target; `RoutingPanel.tsx` edits chains. Unknown quota remains routable. | Policy uses the same sparse precedence. Routing continues to own target preference and live selection; no second router. |
| Persistence | `store.rs` holds `Session`, `Project`, and global state; malformed `state.json` can trigger the startup orphan sweep. `PersistedEnum` is the compatibility seam. | Every added persisted field has `#[serde(default)]`; new persisted enums use `PersistedEnum`. Import is parsed and validated before an atomic replacement. |
| Context | `context_window.rs` reads Claude transcript usage; `lib.rs::session_context` and `store.ts::sessionContext` expose it. The agy usage row reports context. `usage_tally.rs` parses Codex rollout token counts. | A per-agent context reader returns measured tokens, optional verified window, source, and freshness. Unknown is visibly unknown, never zero. Codex and agy session-level context readings require fixture and live verification before a hard cap uses them. |
| Fleet | `fleet.rs::MAX_WORKERS` is 8; `fleet_mcp.rs` has project-scoped authorization and fleet tools. `lib.rs` grants fleet MCP to conductors only for Claude. | Policy caps and claims gate new work at the server side; non-Claude conductor access follows capability spikes. |
| Session lifecycle | `PtyManager::retire` preserves scrollback; `kill` removes it. `stop_session`/`start_session` and `Session.stopped` already support hibernation. | Budget rollover and quota pause use checkpoint, retire, and a fresh conversation; never destroy a session to enforce a budget. |
| Front chat | `root_chat.rs` launches Claude; `root_mcp.rs::dispatch_work` and `proposals.rs` feed approval cards. | Agent adapters emit the same structured brief; an MCP tool is optional. Existing proposal validation and approval-time routing remain authoritative. |

The external P0 ledger reports local Codex model, usage-meter, hooks, and Windows lint branches, with hooks still missing trusted-event proof. These changes are not assumed merged into `origin/main`. P1 implementation must rebase its evidence on the actual upstream base, and context meters must not confuse quota percentages with context consumption.

## Policy shape and compatibility

Use a versioned JSON policy document with sparse `global` and `projects[projectId]` overlays. Omission means inherit; an explicit `null` clears an optional setting only where the schema says so. Ordered route chains replace whole chains, as `routing.rs` already does. An effective-policy view returns defaults, global, project, effective, and source per field so Settings can show what Reset will do. Reject unknown enum values and invalid ranges on import or UI write, but deserialize older persisted enum values leniently through `PersistedEnum` to protect state startup. Export excludes account secrets, transcripts, and machine-specific worktree paths. Preserve unknown future JSON keys only if round-trip behavior is specified and tested; otherwise reject an unsupported schema version without touching state.

The first version groups optional switches and limits: `context` (display, warning target, hard cap, checkpoint interval), `fleet` (total, writers per repository, readers, critics, retry rounds, worktree requirement), `quotaPause`, `roles` (front chat and conductor choice), `review` (provider separation and write permission by route), and `portability`. Defaults for every switch are off. A missing policy yields the exact current launch, routing, cap, and review behavior. P1 may display meters when enabled without enforcing any limit. Display thresholds cannot silently become spawn guards. Policy writes must be project-scoped and must not alter unrelated project overrides.

Settings gains **Orchestration** beside the existing routing and usage panels. It shows global or selected-project scope, inherited values, Reset, effective preview, validation errors, and import/export. Avoid duplicating route chains in this panel: link to `RoutingPanel.tsx`, and compose its effective routes with policy at the decision seam. Import previews a diff before save. A policy with an unsupported capability shows a disabled control and reason, rather than pretending enforcement exists.

## Phase behavior

### P1: model and observability

Add the policy model, commands, Settings panel, and per-session context readings. Claude reuses `context_window.rs`. Codex rollout readings and agy status-line readings need source-specific parsers and attribution to the exact session and model; a quota `token_count` total is not automatically current context. Normalize to `{used, window?, model?, source, observedAt}` and return no reading on missing, stale, ambiguous, or malformed data. Show a ring on tabs and global board cards only when a measured fraction has a known denominator; show **Unknown** otherwise. Do not unmount or reparent the keep-alive terminal to add a ring. P1 contains no enforcement.

### P2: budgeted rollover

Warn once per threshold crossing, then at a hard cap wait for the next confirmed idle state. Require a recent on-disk checkpoint, request a final ledger if the source can answer, retire through `PtyManager::retire`, and create a new conversation whose prompt points to the ledger. Claude Stop hook can report completion; other agents need verified idle detection before automation. If idle, ledger, or new-spawn confirmation is unavailable, retain the existing session and surface an actionable state. A checkpoint contains brief, completed checks, decisions with reasons, files touched, open questions, exact next action, and budget spent. A periodic checkpoint lets a rate-limited session hand off without another model turn. Ledger paths are project-contained and collision-safe.

### P3: fan-out, claims, and quota pause

Replace fixed worker limit use with effective configurable caps only after policy is enabled; the off path retains `MAX_WORKERS = 8`. Count live or reserved workers atomically on the fleet server so simultaneous spawns cannot pass a cap. Track repo identity, checkout, role, file claims, lease expiry, and owner session. One writer claim per repository is the optional owner policy, with read and critic limits separately. Claude PreToolUse can enforce file claims for supported edits; other agents without equivalent verified hooks must be restricted by worktree isolation or marked advisory. PostToolUse file paths detect two sessions editing the same file in one checkout and warn both. A retry count belongs to the task, not the session; reset only on a new task. Below an enabled quota threshold, request checkpoint and hibernate with `retire`; unknown quota must not trigger pause.

### P4: any capable orchestrator

Spike each agent against the real fleet MCP server before enabling its conductor role. Required proof: it can load the config, receive injected instructions, call list, scoped peek, spawn, receive results, and respect role authorization across a restart. `ProviderAdapter::project_mcp_config_rel_path`, generated instruction files, and the current Claude `--append-system-prompt-file` path are candidate seams, not proof that another CLI supports equivalent flags. Replace the Claude equality check in `lib.rs` with a capability only for agents that pass. Keep the `fleet_mcp.rs` project and caller-role checks independent of prompt obedience.

### P5: vendor-neutral front chat

Spike headless request and structured-output behavior per CLI (`codex exec --json`, `agy -p --output-format json` are candidates requiring version-specific validation). Parse a bounded, versioned brief block and submit through the `proposals.rs` approval-card path. The card stores task kind and its own project; `pendingDecisionRouting.ts` resolves quota at approval time. Strictly validate agent and kind identifiers. Text outside the structured block is conversational, not a dispatch instruction. `dispatch_work` remains an optional enhancement for an adapter with proven MCP support.

### P6: review and permissions

Add Critique as a routable task kind, while preserving existing Review behavior for old policies. For enabled review policy, resolve an author-independent provider and state why no eligible provider exists. A read-only route must use a verified CLI or sandbox mode (`codex -s read-only`, `agy --mode plan` are probes), and Conduit must not label a prompt-only restriction as enforced. Writer permission is explicit per route and checked before spawn; fallback writers use isolated worktrees and a required review gate. Completion evidence records reviewer, provider, checks, and approval status; no automatic merge follows from a favorable review.

### P7: context portability

Per-project Context files view reports whether `AGENTS.md`, `CLAUDE.md`, and any verified vendor file exists, which CLI reads each, approximate token size, and a warning when the target loads no project rules. One-click creation or Claude import runs only after an explicit click; Conduit never rewrites a user's rules during spawn. Keep durable cross-vendor state in `docs/context.md` and `docs/handoff/<date>-<slug>.md`. Conduit-owned policy, budget, and brief ride via verified CLI injection or an isolated worktree instruction block, separate from project rules. Continue in another agent requests a ledger from the source when possible; on quota failure it may summarize a readable transcript through a different pool, with provenance and an edit/approval step before spawn. Claude private memory and Hermes `MEMORY.md` are not transferable state. Transcript readers need per-vendor fixtures and must respect project access rules.

## Safety and acceptance

- All cross-project reads, sends, claims, and resumes use the existing project authorization boundary; policy never widens a session's clearance.
- Unknown meter, missing hook, unavailable CLI flag, stale quota, or failed ledger extraction cannot become a false green ring or a destructive session stop.
- Defaults and old `state.json` fixtures preserve present behavior. Import failure leaves the persisted state byte-for-byte intact. Policy UI shows both effective value and provenance.
- macOS and Windows launch paths are checked separately. A command that reads a large transcript or starts a process is async. UI behavior is verified in an isolated dev app, in addition to static and unit gates.

## Open decisions for implementation spikes

Confirm exact Codex and agy session-context semantics, denominators, and update timing; hook and idle signals for each adapter; read-only flags and effective sandbox behavior; conductor MCP config and instructions per CLI; headless JSON schema and failure mode; transcript access and cross-provider ledger fidelity. No later phase may turn a proposed capability on by default merely because a parser or flag exists.
