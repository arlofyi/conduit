# Hermes Agent, OpenRouter, and one provider surface for every agent

Status: design, 2026-09-19. Supersedes nothing; extends
`2026-06-30-opencode-integration-tier-2-design.md` (OpenCode local models) and
`2026-08-23-agent-routing-preferences-design.md` (routing).

## What this adds

1. A seventh adapter: **Hermes Agent** (`hermes`, Nous Research), with OpenRouter and
   local-model routing, Conduit's lifecycle status, deterministic resume, and accounts.
2. **OpenRouter** as a first-class endpoint for OpenCode as well as Hermes — the same
   mechanism that already routes OpenCode at a local GPU, pointed at a cloud aggregator.
3. One **provider surface**: `ProviderSettings` per agent, replacing the single
   `OpenCodeSettings` slot, plus a per-session override.
4. A session-aware **Model tab** in the right column's bottom panel, next to Terminal /
   Git / Decisions / Messages, that shows and edits whatever the *selected session's*
   agent actually supports.

## Why Hermes is not "another Tier-3 agent"

Every adapter added after Claude arrived weaker than Claude: agy has no hooks, OpenCode has
a JS plugin but no MCP matrix, Command Code fires four of Claude's events. Hermes is the
first one that arrives with a *superset*. Verified against the installed
`hermes` on this machine (`hermes --help`, `hermes chat --help`, and its own source under
`%LOCALAPPDATA%\hermes\hermes-agent`), not from docs:

| Conduit needs | Hermes has | Evidence |
| --- | --- | --- |
| Pin our own session id | `chat -c <name> --create-if-missing` | `chat --help`: "if no session matches the name, create a new session with that title and proceed" |
| Lifecycle status | shell hooks, Claude-Code-shaped JSON on stdin | `agent/shell_hooks.py`, `hermes_cli/plugins.py::VALID_HOOKS` |
| Per-session config without touching user files | `HERMES_MANAGED_DIR` overlay | `hermes_cli/managed_scope.py` |
| Accounts | `HERMES_HOME` | `hermes_constants.py` |
| Model / effort per invocation | `--model`, `--provider`, `--reasoning` | `hermes --help` |
| MCP | `hermes mcp add/remove/list` | `hermes mcp --help` |
| Worktrees | `--worktree` (its own) | `hermes --help` |

So Hermes lands at **Tier 1** on arrival. The one thing it does *not* get is
`supports_worktree`: like Command Code it manages its own worktrees (`-w`), and two
managers over one directory is a decision this repo has deliberately not made.

## The four seams, and why each is the one it is

### 1. Resume is pinned by TITLE, not captured

agy and Command Code both required id *capture* — spawn, let the agent choose an id, scrape
it back (agy from a filesystem baseline, Command Code from a `SessionStart` body). Both are
fragile for the same reason: the mapping is discovered after the fact.

Hermes needs neither. `hermes chat -c <conduit-session-id> --create-if-missing` means
"resume the session titled `<id>`, creating it if absent" — idempotent, deterministic, and
identical on the first spawn and every later one. **`Session.agent_conversation_id` is
therefore NOT used by the Hermes adapter**, and must not be wired to it later "for
consistency": the whole point is that there is nothing to capture.

`--in <dir>` scopes the lookup to the session's own working directory, so two projects may
hold sessions with colliding titles without cross-resuming.

### 2. Status comes from SHELL hooks, via a managed overlay

Hermes has four hook systems. Only one runs in the CLI *and* is declarative: **shell
hooks**, a `hooks:` block in the profile `config.yaml` naming scripts that receive
`{hook_event_name, tool_name, tool_input, session_id, cwd, profile}` on stdin. That is the
same payload shape Conduit's `/hook` listener already parses for Claude and Command Code,
so `hooks::command()` and the generic entry builder carry over unchanged.

The problem is *where* the block goes. Claude's lands in `<project>/.claude/settings.local.json`
— a per-project file. Hermes has no project-scoped config; `hooks:` is only read from the
profile's `config.yaml`, which is machine-wide. Writing there is exactly the failure
`hook_target_is_user_level` was added to prevent (see "Where the session status rules live"
in CLAUDE.md, and upstream's `c07ca90`): Conduit's hooks would fire for every `hermes` on
the box, including ones Conduit never started.

`HERMES_MANAGED_DIR` is the answer, and it is a documented Hermes seam rather than a trick:

- It names a directory whose `config.yaml` is **deep-merged per leaf on top of** the user's,
  with sibling keys left user-controlled (`managed_scope.apply_managed_overlay`).
- It is read from the **process environment**, so it is per-spawn — Conduit points one
  session at one generated directory and no other `hermes` on the machine sees it.
- It is **fail-open**: an unparseable managed file is logged and ignored, never fatal.
- `${VAR}` references in it expand against the **process** env only, which is what lets the
  endpoint key ride in one env var instead of being written into a file — the same
  discipline as OpenCode's `{env:CONDUIT_OC_APIKEY}`.

So: `<dataDir>/hermes/<session_id>/config.yaml`, containing Conduit's `hooks:` block,
`hooks_auto_accept: true`, and — only when the user has enabled Conduit provider routing for
Hermes — a `model:` block. Nothing is ever written to `%LOCALAPPDATA%\hermes\config.yaml`.

**`hooks_auto_accept` is scoped by that same directory, and that is the point.** Hermes
prompts for consent on first use of each `(event, command)` pair, which a Conduit session
cannot answer — there is no TTY at spawn. The blunt instrument is `--accept-hooks` /
`HERMES_ACCEPT_HOOKS=1`, which auto-approves **every** hook in the merged config, including
any the user wrote themselves. Setting `hooks_auto_accept: true` inside the managed overlay
has the same effect on Conduit's own hooks while keeping the decision in a file Conduit
owns and the user can read. It is still a widening — documented here rather than hidden.

### 3. Providers are layered the way Hermes layers them

Hermes resolves settings CLI > `config.yaml` > `.env` > defaults, and each of the three
things Conduit wants to set belongs at a different layer:

| What | Where Conduit puts it | Why not elsewhere |
| --- | --- | --- |
| provider + model + reasoning | CLI flags (`--provider`, `-m`, `--reasoning`) | Per-invocation, so a mid-session `/model` still works. Pinning them in the managed overlay would make them user-immutable. |
| base URL | managed overlay `model.base_url`, or the provider's own `*_BASE_URL` env var | A local endpoint has no CLI flag. |
| API key | one process env var, named by the provider registry | Never on a command line, never on disk. |

The provider registry is Hermes's own (`hermes_cli/providers.py::HERMES_OVERLAYS`), which
gives each provider its `base_url_env_var` and key env vars. Conduit mirrors only the
handful it offers rather than duplicating all ~40 — `openrouter`
(`OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL`), `lmstudio` (`LM_API_KEY` / `LM_BASE_URL`),
and `custom` (the alias target for `ollama` / `vllm` / `llamacpp`, whose base URL has no env
var and therefore goes in the overlay).

**A model block is written ONLY when the user enabled routing for Hermes.** Off, a Hermes
session spawns with hooks and nothing else, exactly as its own config dictates. This is the
same `enabled` gate OpenCode already has, for the same reason.

### 4. Accounts redirect `HERMES_HOME`, not `HOME`

Claude, agy and Command Code all share `claude_profile_env`'s HOME redirect because none of
them has a config-dir override. Hermes has one. `account_env` therefore sets `HERMES_HOME`
directly and leaves `HOME`/`USERPROFILE` alone — a narrower blast radius than the three
existing adapters, and the reason `ProviderAdapter::account_env` was made a seam.

Consequence worth knowing: a Hermes-tagged account's `config_dir` is `.claude`-rooted (see
`default_profile_dir`), exactly the mismatch Command Code hit. `agent::hermes_home_dir` is
the ONE place that decides which home such an account resolves to (its own `.hermes`, else
the ambient one), and both the spawn env and any future meter must derive from it — they
disagreed once for Command Code and it silently emptied the usage bar.

## OpenRouter for OpenCode

No new mechanism. `build_opencode_config` already emits an `@ai-sdk/openai-compatible`
provider with a `baseURL` and an `{env:...}` key; OpenRouter is an OpenAI-compatible
endpoint at `https://openrouter.ai/api/v1`. What changes:

- `openrouter` joins the preset list, with `needs_key: true` and no local probe.
- `preset_label` names it.
- **`pin_local` is renamed in meaning, not in wire format.** It emits
  `enabled_providers: ["conduit"]`, which under a local preset means "cannot reach the
  cloud" and under OpenRouter means "cannot reach anything except OpenRouter". The flag is
  therefore surfaced as *"Use only this endpoint"*. The persisted key stays `pinLocal` so
  existing `state.json` files keep working — renaming it would silently reset the setting
  for every user who had it on.
- The trust-boundary path must not change: `local_only` sessions under private mode pin the
  provider, and that is only a containment guarantee when the endpoint IS local.
  **`ProviderSettings::is_local()` is what `local_only` now checks**, so a siloed session
  cannot be quietly routed through a cloud aggregator by flipping the preset.

### The key does reach disk for OpenRouter, and that is a deliberate change

`OpenCodeSettings` keeps its key in memory only (`Store::opencode_key`), never on disk.
That is correct for a local endpoint, whose key is usually empty or a placeholder. It is
wrong for OpenRouter: re-entering a real API key on every app launch is the kind of friction
that makes people put it in a shell profile instead, which is worse.

So keys are persisted **per endpoint** in the OS credential store, not in `state.json`:
`keyring`-style via the platform command already used for Claude's OAuth token
(`security find-generic-password` on macOS, `cmdkey`/DPAPI on Windows). A key is read on
explicit user action and at spawn, held in memory, and never logged. If the credential store
is unavailable the setting degrades to the current in-memory behaviour rather than falling
back to disk.

## Per-agent settings, and the per-session override

`OpenCodeSettings` becomes `ProviderSettings` (identical serde shape — `enabled`, `preset`,
`baseUrl`, `model`, `contextLimit`, `outputLimit`, `pinLocal`), stored as
`agent_providers: HashMap<AgentId, ProviderSettings>`.

`PersistState.opencode` is **kept** and mirrors `agent_providers[OpenCode]`, the same way
`default_account` mirrors `default_accounts[Claude]`. On load, an `agent_providers` with no
OpenCode entry adopts the legacy `opencode` block. This is not tidiness: a downgrade to an
older Conduit must still find OpenCode's endpoint where it left it, and the orphan sweep
makes an unreadable `state.json` cost every running session (see "Where session
persistence's safety net lives").

A session may override the agent default with `Session.provider: Option<String>` — the
preset id alone, resolved against the agent's `ProviderSettings` for everything else.
`None` means "the agent's default", and every session written before this feature is
`None`; that absence is what keeps old state files forward-compatible, and it is pinned by a
round-trip test the same way `WsTab.projectId`'s is.

## The Model tab

Bottom panel, right column, after Terminal and Git. It is **session-scoped**: it reads
`activeSessionId` — the same value the To-dos and Agents tabs read — so selecting a
different tab in the centre re-renders it for that session's agent.

- It renders only controls the selected session's agent **actually** supports, from
  `AGENTS` metadata plus the Rust adapter flags it mirrors: no model box for an agent whose
  `supportsModelFlags` is false, no effort control outside Claude and Hermes, no endpoint
  row for an agent with no `ProviderSettings` support.
- A change that only a **spawn** can apply (provider, base URL, account) is marked as such
  and offers restart; a change the running agent picks up is applied live. Conflating the
  two is how the OpenCode panel's "saved" toast once implied a running session had moved
  endpoints when it had not.
- It never writes a provider's API key into the panel's own state — the key box is
  write-only, mirroring `opencodeKeySet`.
- No session selected renders a placeholder, not the global defaults: this tab answers
  "what is THIS session running", and showing defaults there would make the answer a guess.

Settings → Agents keeps the global, per-agent editor (the tab edits one session; Settings
edits the default every new session inherits).

## What is deliberately NOT in this change

- **No Hermes usage meter.** `usageRows.ts` is the one place quota arithmetic lives and
  Hermes exposes its own (`hermes insights`), but reading it is a separate mechanism from
  the four already there. Hermes therefore carries `remaining: null` — and per the routing
  design, unknown quota is not exhausted quota, so it stays routable.
- **No Hermes fleet worker tier promotion beyond what the seam gives.** Hermes has
  `hermes mcp add`, so `mcp_add_command`/`mcp_remove_command` are wired and the MCP matrix
  reports `supportsMcp: true`. Whether it can serve `fleet_result` needs the same verified
  spike OpenCode got (`inject_fleet_mcp`'s doc comment records what that spike looked like);
  until then its capability card claims no `structuredResult`.
- **No change to Claude, Codex, Gemini or agy spawn paths.** The Model tab reads them; it
  does not gain new powers over them.

---

## Addendum: the endpoint pool (0.41.0)

The first cut of this design gave each agent ONE endpoint, and recorded the consequence as a
known gap: Hermes' `/model --provider` only reaches providers already present in its config,
so a session that launched against a local model could never be moved to OpenRouter without
a restart. That makes the provider half of live switching unreachable, and a restart is
precisely what live switching exists to avoid — it throws away the context that motivated
the change.

**The fix is a pool, not a bigger `ProviderSettings`.** `PersistState.agent_endpoints` maps
an agent to a LIST of endpoints; `agent_providers` keeps its exact previous meaning as the
ACTIVE one, so nothing about spawn behaviour or back-compat changes. The pool is what gets
written into the agent's own config, and that is the entire mechanism.

### What was verified rather than assumed

Every claim below was measured against the installed Hermes CLI and its source, not read
from documentation — the same discipline that caught the `on_session_end` naming trap and
the credential-resolution failure earlier in this design.

- `providers:` is a first-class config key (`config_providers.py`), deep-merged per leaf
  like every other key, so Conduit's entries sit beside the user's own.
- `custom_provider_slug` derives a stable identity from the entry's KEY, not its display
  name, giving `custom:conduit-<preset>`. That is what `/model --provider <slug>` accepts.
- Each entry names its own `key_env`, read at runtime with `get_secret_str`. Two pooled
  entries with two private variables each resolved their own key:

  ```text
  custom:conduit-openrouter -> https://openrouter.ai/api/v1   key: sk-test-…
  custom:conduit-ollama     -> http://127.0.0.1:11434/v1      key: local-xy…
  ```

This is why a Conduit-private variable is correct here and does **not** contradict
`key_env_var`'s warning. That warning is about `model.api_key: "${VAR}"` — overlay expansion
the credential resolver never consults. A `providers:` entry naming its variable is a
different, working mechanism. The distinction is subtle enough that a test pins the format:
a drift makes `/model --provider` silently reach nothing, and the switch is *accepted*, so
the failure is invisible.

### The decisions worth keeping

- **Keys are per (agent, base URL).** A pool holds a keyed cloud endpoint beside a keyless
  local one; one key per agent hands one endpoint's credential to another. The single
  exception, `promote_unbound_key`, moves a key typed before any URL existed onto the first
  endpoint the agent gets — not a general "follow the active endpoint" rule, which would
  carry a cloud key onto a local server on a preset change.
- **The silo filters the pool.** Writing a cloud endpoint into a local-only session's config
  would leave its agent one slash command from routing siloed work off the machine, making
  the launch-time `is_local()` check decoration.
- **A switch persists `Session.provider`.** Otherwise the next start reads the agent's active
  endpoint and silently moves the session back — with a model pinned that endpoint may not
  serve. A pinned slug that no longer names anything degrades to the active endpoint, never
  to none.
- **`pooled_provider_slugs` returning all-`None` is an answer.** OpenCode's `/models` takes
  no argument and every other agent reads its endpoint once at start; an invented slug would
  put an enabled button in front of the user that does nothing.
