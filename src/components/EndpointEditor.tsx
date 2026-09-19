import { useEffect, useState } from "react";
import {
  useStore,
  allowedForLocalOnly,
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
 * say so in their own words — the Model tab captions it "every <agent> session", Settings
 * shows it under the agent's own heading — because "I changed the model" and "I changed
 * the model for every session I will ever start on this agent" are very different actions.
 *
 * It exists as its own component so the session-scoped Model tab and the global Settings
 * page cannot drift. A second hand-written copy of this form is exactly how the label and
 * the value it writes end up disagreeing.
 */

/** Endpoint presets offered in the picker.
 *
 * The local ones are probed on demand; OpenRouter is NOT — it is a cloud aggregator that
 * is always reachable, so probing it on panel open would be a pointless outbound request
 * (and one the user did not ask for). `custom` is the escape hatch for anything else
 * OpenAI-compatible. `needsKey` only decides whether the key field is OFFERED. */
export const PRESETS: Array<{
  preset: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  hint?: string;
}> = [
  { preset: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false },
  { preset: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false },
  { preset: "vllm", label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1", needsKey: false },
  { preset: "llamacpp", label: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", needsKey: false },
  { preset: "openwebui", label: "OpenWebUI", baseUrl: "http://127.0.0.1:3000/api", needsKey: true },
  {
    preset: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    hint: "Cloud aggregator — hundreds of models behind one API key. Not local inference.",
  },
  { preset: "custom", label: "Custom", baseUrl: "", needsKey: false },
];

export const presetMeta = (preset: string) => PRESETS.find((p) => p.preset === preset);

export function EndpointEditor({
  agent,
  /** Set when the editor is shown for a session that is marked local-only, so the panel
   *  can warn that a non-local endpoint will be dropped under private mode. */
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadProviderSettings();
  }, [loadProviderSettings]);

  // Clear per-endpoint scratch state when the AGENT changes — a model list fetched for
  // one agent's endpoint means nothing for another's.
  useEffect(() => {
    setModels([]);
    setNote(null);
    setKeyDraft("");
  }, [agent]);

  const save = (patch: Partial<ProviderSettings>) => {
    void setProviderSettings(agent, { ...endpoint, ...patch });
    onChanged?.();
  };

  const scan = async () => {
    setBusy(true);
    setNote(null);
    try {
      setStatuses(await detectLocalProviders());
      const base = endpoint.baseUrl.trim();
      if (!base) {
        setNote({ kind: "warn", text: "Set a base URL first." });
        return;
      }
      const res = await listLocalModels(base, endpoint.preset);
      if (typeof res === "string") {
        setModels([]);
        setNote({ kind: "warn", text: res });
      } else {
        setModels(res);
        setNote({
          kind: "ok",
          text: `${res.length} model${res.length === 1 ? "" : "s"} available.`,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const pm = presetMeta(endpoint.preset);
  const status = statuses?.find((s) => s.preset === endpoint.preset);

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
          <div className="mp-chips">
            {PRESETS.map((p) => {
              const live = statuses?.find((s) => s.preset === p.preset)?.running;
              return (
                <button
                  key={p.preset}
                  className={`mp-chip${endpoint.preset === p.preset ? " active" : ""}`}
                  title={p.hint}
                  onClick={() => {
                    // Changing the endpoint invalidates the model: an id served by Ollama
                    // is not an id OpenRouter serves. Clearing it is what stops a stale
                    // model silently pinning a route the new endpoint cannot honour.
                    save({ preset: p.preset, baseUrl: p.baseUrl || endpoint.baseUrl, model: "" });
                    setModels([]);
                  }}
                >
                  {live ? <span className="mp-dot" /> : null}
                  {p.label}
                </button>
              );
            })}
          </div>

          <label className="mp-row">
            <span className="mp-label">Base URL</span>
            <input
              className="mp-input"
              value={endpoint.baseUrl}
              placeholder="https://…/v1"
              onChange={(e) => save({ baseUrl: e.target.value })}
            />
          </label>

          <label className="mp-row">
            <span className="mp-label">Model</span>
            <input
              className="mp-input"
              value={endpoint.model}
              placeholder={
                endpoint.preset === "openrouter" ? "anthropic/claude-sonnet-5" : "model id"
              }
              onChange={(e) => save({ model: e.target.value })}
              list={models.length ? `ep-models-${agent}` : undefined}
            />
            {models.length ? (
              <datalist id={`ep-models-${agent}`}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.detail || (m.context ? `${Math.round(m.context / 1024)}k ctx` : "")}
                  </option>
                ))}
              </datalist>
            ) : null}
          </label>

          {pm?.needsKey || endpoint.preset === "custom" ? (
            <label className="mp-row">
              <span className="mp-label">API key</span>
              <input
                className="mp-input"
                type="password"
                value={keyDraft}
                placeholder={keyHeld ? "•••••••• (held for this run)" : "not set"}
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={() => {
                  if (!keyDraft) return;
                  // Write-only: the field never shows a held key back, so a screenshot of
                  // this panel can never leak one.
                  void setProviderKey(agent, keyDraft);
                  setKeyDraft("");
                  onChanged?.();
                }}
              />
            </label>
          ) : null}

          <label className="mp-row mp-toggle">
            <input
              type="checkbox"
              checked={endpoint.pinLocal}
              onChange={(e) => save({ pinLocal: e.target.checked })}
            />
            <span>Use only this endpoint</span>
          </label>

          <div className="mp-actions">
            <button className="mp-btn" onClick={() => void scan()} disabled={busy}>
              {busy ? "Scanning…" : "Scan endpoints"}
            </button>
            {status?.detail ? <span className="mp-note">{status.detail}</span> : null}
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
              This session is marked local-only, but {pm?.label ?? "this endpoint"} is not local
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
