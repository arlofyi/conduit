import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, liveState, providerReady, EMPTY_PROVIDER, type LocalModel } from "../store";
import { agentMeta, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";
import { Dropdown } from "./Dropdown";
import { presetMeta } from "./EndpointEditor";

/**
 * The Model tab — what THIS session is running on, and the few things that change per
 * session.
 *
 * **It deliberately does NOT configure the endpoint.** Base URL, API key and provider are
 * set-and-forget: you do them once and never again, and having them here made a panel you
 * open constantly mostly full of things you never touch — while also implying they were
 * per-session when they are per-agent. They live in Settings → Model endpoints now, and
 * this tab links there.
 *
 * What stays is what genuinely varies per session (model, reasoning, account) plus the one
 * read-only thing that was missing: WHICH model is running and what it costs. On OpenRouter
 * that is the difference between a $0.075/M model and a $15/M one, chosen from 447 with
 * near-identical names.
 *
 * With no session selected it renders a placeholder, NOT the global defaults. This tab
 * answers "what is this session running"; showing defaults would make the answer a guess.
 */

const fmtCtx = (n?: number | null) => (n ? `${Math.round(n / 1024)}k context` : "");

export function ModelPanel({ sessionId }: { sessionId: string | null }) {
  const projects = useStore((s) => s.projects);
  const accounts = useStore((s) => s.accounts);
  const agentProviders = useStore((s) => s.agentProviders);
  const endpointModels = useStore((s) => s.endpointModels);
  const loadProviderSettings = useStore((s) => s.loadProviderSettings);
  const setSessionModel = useStore((s) => s.setSessionModel);
  const setSessionEffort = useStore((s) => s.setSessionEffort);
  const setSessionAccount = useStore((s) => s.setSessionAccount);
  const setSettingsTab = useStore((s) => s.setSettingsTab);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const stopSession = useStore((s) => s.stopSession);
  const startSession = useStore((s) => s.startSession);
  const live = useStore((s) => s.live);

  const found = useMemo(() => {
    for (const p of projects) {
      const s = p.sessions.find((x) => x.id === sessionId);
      if (s) return { session: s, project: p };
    }
    return null;
  }, [projects, sessionId]);

  const session = found?.session ?? null;

  const [modelDraft, setModelDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);

  useEffect(() => {
    void loadProviderSettings();
  }, [loadProviderSettings]);

  useEffect(() => {
    setModelDraft(session?.model ?? "");
    setNeedsRestart(false);
    setDone(null);
  }, [sessionId, session?.model]);

  // Agents read their model, endpoint and credentials ONCE, at process start, so "apply
  // without restarting" can only mean Conduit restarts the session for you. Gated on the
  // session being idle: restarting an agent mid-turn throws away the work in flight, which
  // is a far worse surprise than a button.
  const status = liveState(live, sessionId ?? "").status;
  const busyAgent = status === "running" || status === "needsInput";
  const restartRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!needsRestart || busyAgent || busy) return;
    const t = setTimeout(() => void restartRef.current(), 400);
    return () => clearTimeout(t);
  }, [needsRestart, busyAgent, busy]);

  if (!sessionId || !session) {
    return (
      <p className="placeholder" style={{ padding: 12 }}>
        No session selected.
      </p>
    );
  }

  const agent: AgentId = session.agent;
  const meta = agentMeta(agent);
  const eligibleAccounts = accounts.filter((a) => a.agents.includes(agent));
  const endpoint = agentProviders[agent] ?? EMPTY_PROVIDER;
  const routed = providerReady(endpoint);

  // Which model is ACTUALLY in play. A session-pinned model wins over the agent endpoint's,
  // which is the same precedence the spawn uses — so this row cannot claim one thing while
  // the agent runs another.
  const effectiveModel = session.model?.trim() || (routed ? endpoint.model : "");
  const known: LocalModel | undefined = (endpointModels[agent] ?? []).find(
    (m) => m.id === effectiveModel,
  );

  const restart = async () => {
    const pid = found!.project.id;
    setBusy(true);
    try {
      await stopSession(pid, session.id);
      await startSession(pid, session.id);
      setNeedsRestart(false);
      setDone("Applied.");
    } finally {
      setBusy(false);
    }
  };
  restartRef.current = restart;

  const openEndpoints = () => {
    setSettingsTab("endpoints");
    setShowSettings(true);
  };

  return (
    <div className="model-panel">
      <div className="mp-head">
        <AgentGlyph id={agent} size={16} />
        <div className="mp-head-text">
          <div className="mp-title">{session.name}</div>
          <div className="mp-sub">{meta.label}</div>
        </div>
      </div>

      {/* ---- What is running, read-only ---------------------------------------- */}
      <div className="mp-running">
        <div className="mp-running-id">{effectiveModel || `${meta.label}'s default`}</div>
        <div className="mp-running-meta">
          {known?.tools === true ? <span className="ep-badge tools">tools</span> : null}
          {/* An agent without tool calling can barely function, so this is a warning, not a
              detail — it is the single most useful thing to know about a cheap model. */}
          {known?.tools === false ? <span className="ep-badge no">no tools</span> : null}
          {fmtCtx(known?.context)}
          {known?.detail ? (fmtCtx(known?.context) ? ` · ${known.detail}` : known.detail) : ""}
        </div>
        <div className="mp-running-where">
          {routed ? (
            <>
              via {presetMeta(endpoint.preset)?.label ?? endpoint.preset}
              {" · "}
              <button className="mp-link" onClick={openEndpoints}>
                change endpoint
              </button>
            </>
          ) : meta.supportsEndpoint ? (
            <button className="mp-link" onClick={openEndpoints}>
              Set up an endpoint…
            </button>
          ) : (
            `on ${meta.label}'s own configuration`
          )}
        </div>
      </div>

      {/* ---- Per-session ------------------------------------------------------- */}
      <div className="mp-section">
        <div className="mp-section-head">
          This session
          <span className="mp-scope">applied automatically</span>
        </div>

        {meta.supportsModelFlags ? (
          <label className="mp-row">
            <span className="mp-label">Model</span>
            <input
              className="mp-input"
              value={modelDraft}
              placeholder={routed ? endpoint.model || "endpoint default" : `${meta.label}'s default`}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={() => {
                const v = modelDraft.trim();
                if (v === (session.model ?? "")) return;
                void setSessionModel(session.id, v || null);
                setNeedsRestart(true);
              }}
              list={`mp-models-${agent}`}
            />
            <datalist id={`mp-models-${agent}`}>
              {(meta.models ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
              {(endpointModels[agent] ?? []).slice(0, 200).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.detail}
                </option>
              ))}
            </datalist>
          </label>
        ) : (
          <p className="mp-note">
            {meta.label} takes no per-invocation model flag, so its model comes from
            {meta.supportsEndpoint ? " its endpoint" : " the agent itself"}.
          </p>
        )}

        {meta.effortLevels?.length ? (
          <label className="mp-row">
            <span className="mp-label">Reasoning</span>
            <Dropdown
              className="dd-fill"
              value={session.effort ?? ""}
              onChange={(v) => {
                void setSessionEffort(session.id, v || null);
                setNeedsRestart(true);
              }}
              options={[
                { value: "", label: "Agent default" },
                ...meta.effortLevels.map((l) => ({ value: l, label: l })),
              ]}
            />
          </label>
        ) : null}

        {eligibleAccounts.length > 0 ? (
          <label className="mp-row">
            <span className="mp-label">Account</span>
            <Dropdown
              className="dd-fill"
              value={session.accountId ?? ""}
              onChange={(v) => {
                void setSessionAccount(session.id, v || null);
                setNeedsRestart(true);
              }}
              options={[
                { value: "", label: "Default account" },
                ...eligibleAccounts.map((a) => ({ value: a.id, label: a.label })),
              ]}
            />
          </label>
        ) : null}
      </div>

      {done ? <p className="mp-note">{done}</p> : null}

      {needsRestart ? (
        <div className="mp-restart">
          <span>
            {busy
              ? "Applying…"
              : busyAgent
                ? "Mid-turn — applies as soon as it finishes, or restart now."
                : "Applying…"}
          </span>
          <button className="mp-btn" onClick={() => void restart()} disabled={busy}>
            {busy ? "Applying…" : "Restart now"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
