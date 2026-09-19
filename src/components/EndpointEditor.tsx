import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useStore,
  allowedForLocalOnly,
  isLocalPreset,
  providerReady,
  EMPTY_PROVIDER,
  type ProviderSettings,
  type LocalModel,
  type LocalProviderStatus,
} from "../store";
import { agentMeta, type AgentId } from "../agents";

/**
 * One agent's endpoint, edited in one place.
 *
 * This is PER AGENT, not per session: every session on that agent shares it. Both callers
 * say so in their own words, because "I changed the model" and "I changed the model for
 * every session I will ever start on this agent" are very different actions.
 *
 * It exists as its own component so the session-scoped Model tab and the global Settings
 * page cannot drift. A second hand-written copy of this form is exactly how the label and
 * the value it writes end up disagreeing.
 */

export interface PresetDef {
  preset: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  /** Where the key comes from, shown under the key field so it is findable. */
  keyHint?: string;
}

/**
 * The endpoint presets, SPLIT BY WHERE THE INFERENCE HAPPENS.
 *
 * The split is the point, not decoration. A flat row of chips gave no way to tell that
 * picking OpenRouter sends every prompt off the machine while picking Ollama does not —
 * and that distinction decides whether a private-mode local-only session may use the
 * endpoint at all (`allowedForLocalOnly`). The groups here mirror `LOCAL_PRESETS` in
 * `providers.ts`, which is the same list the Rust side enforces with.
 */
export const LOCAL_PRESET_DEFS: PresetDef[] = [
  { preset: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false },
  { preset: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false },
  { preset: "vllm", label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1", needsKey: false },
  { preset: "llamacpp", label: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", needsKey: false },
  {
    preset: "openwebui",
    label: "OpenWebUI",
    baseUrl: "http://127.0.0.1:3000/api",
    needsKey: true,
    keyHint: "OpenWebUI → Settings → Account → API keys",
  },
];

export const REMOTE_PRESET_DEFS: PresetDef[] = [
  {
    preset: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    keyHint: "openrouter.ai → Keys. Starts with sk-or-",
  },
  {
    preset: "custom",
    label: "Custom",
    baseUrl: "",
    needsKey: true,
    keyHint: "Whatever your endpoint expects. Leave blank if it needs none.",
  },
];

export const PRESETS: PresetDef[] = [...LOCAL_PRESET_DEFS, ...REMOTE_PRESET_DEFS];
export const presetMeta = (preset: string) => PRESETS.find((p) => p.preset === preset);

/** Tool-calling first (an agent is crippled without it), then the biggest window. */
const rank = (ms: LocalModel[]): LocalModel[] =>
  [...ms].sort((a, b) => {
    const at = a.tools === true ? 1 : 0;
    const bt = b.tools === true ? 1 : 0;
    if (at !== bt) return bt - at;
    return (b.context ?? 0) - (a.context ?? 0);
  });

const fmtCtx = (n?: number | null) => (n ? `${Math.round(n / 1024)}k ctx` : "");

export function EndpointEditor({
  agent,
  /** Set when the editor is shown for a session marked local-only, so the panel can warn
   *  that a non-local endpoint will be dropped under private mode. */
  sessionLocalOnly = false,
  onChanged,
}: {
  agent: AgentId;
  sessionLocalOnly?: boolean;
  onChanged?: () => void;
}) {
  const agentProviders = useStore((s) => s.agentProviders);
  const providerKeys = useStore((s) => s.providerKeys);
  const loadProviderSettings = useStore((s) => s.loadProviderSettings);
  const setProviderSettings = useStore((s) => s.setProviderSettings);
  const setProviderKey = useStore((s) => s.setProviderKey);
  const detectLocalProviders = useStore((s) => s.detectLocalProviders);
  const listLocalModels = useStore((s) => s.listLocalModels);

  const meta = agentMeta(agent);
  const endpoint: ProviderSettings = agentProviders[agent] ?? EMPTY_PROVIDER;
  const keyHeld = providerKeys.includes(agent);

  const [statuses, setStatuses] = useState<LocalProviderStatus[] | null>(null);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [note, setNote] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadProviderSettings();
  }, [loadProviderSettings]);

  // A model list fetched for one agent's endpoint means nothing for another's.
  useEffect(() => {
    setModels([]);
    setNote(null);
    setKeyDraft("");
    setFilter("");
  }, [agent]);

  const save = (patch: Partial<ProviderSettings>) => {
    void setProviderSettings(agent, { ...endpoint, ...patch });
    onChanged?.();
  };

  /**
   * Ask the endpoint what it serves.
   *
   * Reads the CURRENT settings out of the store rather than closing over `endpoint`, so a
   * call made straight after saving a key or a preset sees the value that was just written
   * instead of the render's stale copy — the backend resolves the key by matching this
   * agent's SAVED base URL, so asking with the old one returns no key and looks like an
   * auth failure.
   */
  const loadModels = useCallback(
    async (quiet = false) => {
      const cur = useStore.getState().agentProviders[agent] ?? EMPTY_PROVIDER;
      const base = cur.baseUrl.trim();
      if (!base) {
        if (!quiet) setNote({ kind: "warn", text: "Set a base URL first." });
        return;
      }
      setBusy(true);
      try {
        const res = await listLocalModels(base, cur.preset, agent);
        if (typeof res === "string") {
          setModels([]);
          setNote({ kind: "warn", text: res });
        } else {
          setModels(rank(res));
          setNote({
            kind: "ok",
            text: `${res.length} model${res.length === 1 ? "" : "s"} available.`,
          });
        }
      } finally {
        setBusy(false);
      }
    },
    [agent, listLocalModels],
  );

  const def = presetMeta(endpoint.preset);
  const local = isLocalPreset(endpoint.preset);
  const needsKey = def?.needsKey ?? false;

  /**
   * Discovery is automatic once the endpoint CAN answer.
   *
   * The user's ask was "discovery based, after I enter a working API key" — so the trigger
   * is (endpoint, key-held), not a button. Keyed on a string rather than the object so it
   * fires when one of those three actually changes and not on every render; `quiet` keeps a
   * background attempt from planting a scary warning the user never asked for.
   */
  const trigger = `${endpoint.preset}|${endpoint.baseUrl.trim()}|${keyHeld}`;
  const lastTrigger = useRef("");
  useEffect(() => {
    if (!endpoint.enabled) return;
    if (!endpoint.baseUrl.trim()) return;
    // An endpoint that needs credentials cannot be asked until it has them.
    if (needsKey && !keyHeld) return;
    if (lastTrigger.current === trigger) return;
    lastTrigger.current = trigger;
    void loadModels(true);
  }, [trigger, endpoint.enabled, endpoint.baseUrl, needsKey, keyHeld, loadModels]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) || m.detail.toLowerCase().includes(q),
        )
      : models;
    // 447 models is a scroll, not a list. Cap the render and say so.
    return { rows: list.slice(0, 60), total: list.length };
  }, [models, filter]);

  const saveKey = async () => {
    if (!keyDraft.trim()) return;
    await setProviderKey(agent, keyDraft);
    setKeyDraft("");
    onChanged?.();
    // The key is what unblocks discovery, so fetch immediately rather than waiting for
    // the effect — and loudly, because the user just asked for this.
    await loadModels(false);
  };

  const chipRow = (defs: PresetDef[]) => (
    <div className="mp-chips">
      {defs.map((p) => {
        const live = statuses?.find((s) => s.preset === p.preset)?.running;
        const detail = statuses?.find((s) => s.preset === p.preset)?.detail;
        return (
          <button
            key={p.preset}
            className={`mp-chip${endpoint.preset === p.preset ? " active" : ""}`}
            title={detail || p.baseUrl || undefined}
            onClick={() => {
              // Changing the endpoint invalidates the model: an id served by Ollama is not
              // an id OpenRouter serves. Clearing it is what stops a stale model silently
              // pinning a route the new endpoint cannot honour.
              save({ preset: p.preset, baseUrl: p.baseUrl || endpoint.baseUrl, model: "" });
              setModels([]);
              setFilter("");
              setNote(null);
            }}
          >
            {live ? <span className="mp-dot" /> : null}
            {p.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="mp-section">
      <label className="mp-row mp-toggle">
        <input
          type="checkbox"
          checked={endpoint.enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        <span>Route {meta.label} at a chosen endpoint</span>
      </label>

      {!endpoint.enabled ? (
        <p className="mp-note">
          Off — {meta.label} sessions spawn on their own configuration, untouched.
        </p>
      ) : (
        <>
          <div className="ep-group">
            <div className="ep-group-head">
              On this machine
              <span className="ep-group-sub">nothing leaves your computer</span>
            </div>
            {chipRow(LOCAL_PRESET_DEFS)}
          </div>

          <div className="ep-group">
            <div className="ep-group-head">
              Cloud
              <span className="ep-group-sub">prompts are sent to a provider</span>
            </div>
            {chipRow(REMOTE_PRESET_DEFS)}
          </div>

          {endpoint.preset ? (
            <div className={`ep-scope ${local ? "local" : "cloud"}`}>
              {local
                ? `${def?.label ?? endpoint.preset} runs on this machine.`
                : `${def?.label ?? endpoint.preset} is a remote service — prompts and code from these sessions are sent to it.`}
            </div>
          ) : null}

          <label className="mp-row">
            <span className="mp-label">Base URL</span>
            <input
              className="mp-input"
              value={endpoint.baseUrl}
              placeholder="https://…/v1"
              onChange={(e) => save({ baseUrl: e.target.value })}
            />
          </label>

          {needsKey ? (
            <>
              <label className="mp-row">
                <span className="mp-label">API key</span>
                <input
                  className="mp-input"
                  type="password"
                  value={keyDraft}
                  placeholder={keyHeld ? "•••••••• stored for this run" : "paste your key"}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveKey();
                  }}
                />
                <button
                  className="mp-btn"
                  onClick={() => void saveKey()}
                  disabled={!keyDraft.trim() || busy}
                >
                  {busy ? "Checking…" : "Save & load"}
                </button>
              </label>
              <p className="mp-note ep-keyhint">
                {keyHeld ? "Key stored. " : ""}
                {def?.keyHint}
                {" · Held in memory for this run only — never written to disk."}
              </p>
            </>
          ) : null}

          <label className="mp-row">
            <span className="mp-label">Model</span>
            <input
              className="mp-input"
              value={endpoint.model}
              placeholder={
                endpoint.preset === "openrouter" ? "anthropic/claude-sonnet-5" : "model id"
              }
              onChange={(e) => save({ model: e.target.value })}
            />
          </label>

          {/* Discovery. A picker, not a datalist: OpenRouter serves 400+ models and the
              choice turns on context window, price and tool support, none of which a bare
              datalist shows. */}
          {models.length > 0 ? (
            <div className="ep-picker">
              <input
                className="mp-input ep-filter"
                value={filter}
                placeholder={`Filter ${models.length} models…`}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="ep-list">
                {shown.rows.map((m) => (
                  <button
                    key={m.id}
                    className={`ep-item${endpoint.model === m.id ? " active" : ""}`}
                    onClick={() => save({ model: m.id, contextLimit: m.context ?? null })}
                    title={m.detail}
                  >
                    <span className="ep-item-id">{m.id}</span>
                    <span className="ep-item-meta">
                      {m.tools === true ? <span className="ep-badge tools">tools</span> : null}
                      {m.tools === false ? <span className="ep-badge no">no tools</span> : null}
                      {fmtCtx(m.context)}
                      {m.detail ? ` · ${m.detail}` : ""}
                    </span>
                  </button>
                ))}
              </div>
              {shown.total > shown.rows.length ? (
                <p className="mp-note">
                  Showing {shown.rows.length} of {shown.total} — type to narrow.
                </p>
              ) : null}
            </div>
          ) : null}

          <label className="mp-row mp-toggle">
            <input
              type="checkbox"
              checked={endpoint.pinLocal}
              onChange={(e) => save({ pinLocal: e.target.checked })}
            />
            <span>
              Use only this endpoint
              <span className="mp-scope">
                {local
                  ? " — blocks any cloud fallback"
                  : " — blocks other providers, but this one is still remote"}
              </span>
            </span>
          </label>

          <div className="mp-actions">
            <button
              className="mp-btn"
              onClick={async () => {
                setBusy(true);
                try {
                  setStatuses(await detectLocalProviders());
                } finally {
                  setBusy(false);
                }
                await loadModels(false);
              }}
              disabled={busy}
            >
              {busy ? "Scanning…" : "Re-scan"}
            </button>
            {needsKey && !keyHeld ? (
              <span className="mp-note">Enter a key above to list models.</span>
            ) : null}
          </div>

          {!providerReady(endpoint) ? (
            <p className="mp-warn">
              Incomplete — a base URL and a model are both needed before this endpoint is used.
            </p>
          ) : null}

          {/* The silo rule is the one place this editor must be blunt: "use only this
              endpoint" is satisfied by a cloud aggregator, which defeats a local-only
              session entirely — so the backend drops the routing rather than honour it. */}
          {sessionLocalOnly && !allowedForLocalOnly(endpoint) ? (
            <p className="mp-warn">
              This session is marked local-only, but {def?.label ?? "this endpoint"} is not local
              inference. Under private mode its routing is dropped and the session runs on{" "}
              {meta.label}'s own configuration.
            </p>
          ) : null}

          {note ? (
            <p className={note.kind === "warn" ? "mp-warn" : "mp-note"}>{note.text}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
