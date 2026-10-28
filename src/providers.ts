/**
 * Endpoint-provider rules, shared by the Model tab, Settings, and the store.
 *
 * This is a standalone module for the same reason `usageRows.ts` and `startup.ts` are:
 * **`store.ts` cannot be imported under the node-env vitest** — it touches `localStorage`
 * and the Tauri bridge at module scope and throws on import. Anything here that decides
 * something (rather than merely holding state) therefore lives outside the store, and the
 * store re-exports it so call sites keep one import path.
 *
 * The Rust side owns the same two facts (`store::LOCAL_PRESETS`, `ProviderSettings::is_local`
 * / `is_ready`). These must not fork: `is_local` is what decides whether a private-mode
 * local-only session may use an endpoint at all, and a UI that disagrees with the spawn
 * about that would show a session as routed while the backend silently dropped it.
 */

/** Non-secret endpoint settings for ONE agent. Mirrors the Rust `ProviderSettings`. */
/**
 * One pooled endpoint as the backend reports it. Never carries a key — only `hasKey`,
 * which is all a form needs to choose between "Add key" and "Replace key".
 */
export interface EndpointView {
  /** The whole endpoint, not a projection — a row is activated by sending this back, so a
   *  dropped field would be silently reset the moment the row was clicked. */
  settings: ProviderSettings;
  /** The endpoint a NEW session of this agent spawns on. */
  active: boolean;
  hasKey: boolean;
  /**
   * What this agent's own `/model --provider <slug>` accepts for this endpoint, or null
   * when the agent cannot be moved to it without a restart.
   *
   * Null is a real answer, not a missing one: OpenCode's `/models` takes no argument, and
   * every other agent reads its endpoint once at process start. The UI must render the
   * difference — an enabled chip that silently does nothing is worse than a disabled one
   * that says why.
   */
  providerSlug: string | null;
}

export interface ProviderSettings {
  enabled: boolean;
  /** "ollama" | "lmstudio" | "vllm" | "llamacpp" | "openwebui" | "openrouter" | "custom"
   *  ("" = unset). */
  preset: string;
  /** Full OpenAI-compatible base URL (e.g. http://127.0.0.1:11434/v1). */
  baseUrl: string;
  /** Model id exactly as the endpoint reports it. */
  model: string;
  contextLimit?: number | null;
  outputLimit?: number | null;
  /** Allowlist the injected provider so the agent can't fall back to other providers.
   *  The wire name stayed `pinLocal` when the meaning widened to "use only this
   *  endpoint" — renaming it would reset the setting for everyone who had it on. */
  pinLocal: boolean;
}

/**
 * Presets that are genuinely LOCAL inference, i.e. no request leaves the machine.
 * Mirrors Rust's `LOCAL_PRESETS`.
 *
 * `openrouter` and `custom` are deliberately absent. OpenRouter is a cloud aggregator by
 * definition, and a custom URL may point anywhere — treating "the user typed a URL" as
 * local is exactly how a siloed session would get quietly routed off the machine.
 */
export const LOCAL_PRESETS = ["ollama", "lmstudio", "vllm", "llamacpp", "openwebui"];

export const isLocalPreset = (preset: string): boolean => LOCAL_PRESETS.includes(preset);

/**
 * Enough to route with: switched on, and BOTH halves of the route present.
 *
 * An `enabled` block with no model is not a half-configured route to guess at — the agent
 * spawns untouched instead, which is what the Rust `is_ready` gate does too.
 */
export const providerReady = (p: ProviderSettings | undefined | null): boolean =>
  !!p && p.enabled && !!p.baseUrl.trim() && !!p.model.trim();

export const EMPTY_PROVIDER: ProviderSettings = {
  enabled: false,
  preset: "",
  baseUrl: "",
  model: "",
  contextLimit: null,
  outputLimit: null,
  pinLocal: false,
};

/**
 * Whether this endpoint may drive a session marked local-only under private mode.
 *
 * Note what this does NOT consult: `pinLocal`. That flag only says "don't fall back
 * elsewhere", which is equally satisfied by pinning a cloud aggregator — so reading it as
 * a containment guarantee is the exact mistake this function exists to prevent.
 */
export const allowedForLocalOnly = (p: ProviderSettings): boolean =>
  !providerReady(p) || isLocalPreset(p.preset);
