import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, liveState } from "../store";
import { agentMeta, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";
import { Dropdown } from "./Dropdown";
import { EndpointEditor } from "./EndpointEditor";

/**
 * The Model tab — what THIS session is actually running on, and the controls to change it.
 *
 * Session-scoped by construction: everything it renders derives from `sessionId`, so
 * selecting a different tab in the centre re-renders it for that session's agent. It
 * renders only the controls the selected agent ACTUALLY supports (`AGENTS` metadata, which
 * mirrors the Rust adapter flags) rather than greying out rows for capabilities that do not
 * exist — a disabled "Reasoning" control on an agent with no effort flag is a promise the
 * spawn cannot keep.
 *
 * With no session selected it renders a placeholder, NOT the global defaults. This tab
 * answers "what is this session running"; showing defaults would make the answer a guess.
 *
 * Two scopes are visible and the panel never blurs them: model / reasoning / account are
 * PER SESSION, the endpoint is PER AGENT. Each block is captioned with which it is.
 */
export function ModelPanel({ sessionId }: { sessionId: string | null }) {
  const projects = useStore((s) => s.projects);
  const accounts = useStore((s) => s.accounts);
  const setSessionModel = useStore((s) => s.setSessionModel);
  const setSessionEffort = useStore((s) => s.setSessionEffort);
  const setSessionAccount = useStore((s) => s.setSessionAccount);
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
  /** A change only a SPAWN can apply. Tracked apart from anything a running agent would
   *  pick up, because conflating the two is how a "saved" confirmation ends up implying a
   *  running session already moved when it has not. */
  const [needsRestart, setNeedsRestart] = useState(false);

  // The model box is a draft so typing does not round-trip on every keystroke; re-seed it
  // when the SESSION (or its stored model) changes, not on every render.
  useEffect(() => {
    setModelDraft(session?.model ?? "");
    setNeedsRestart(false);
    setDone(null);
  }, [sessionId, session?.model]);

  // Agents read their model, endpoint and credentials ONCE, at process start: Hermes and
  // OpenCode both resolve them before the first prompt, so there is no live channel to push
  // a change down. "Apply without restarting" therefore has to mean Conduit does the
  // restart FOR you, not that the running process changes its mind.
  //
  // It is gated on the session being idle. Restarting an agent mid-turn throws away the
  // work in flight, which is a far worse surprise than a button — so a busy session keeps
  // the explicit button and applies the moment it goes quiet.
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

  return (
    <div className="model-panel">
      <div className="mp-head">
        <AgentGlyph id={agent} size={16} />
        <div className="mp-head-text">
          <div className="mp-title">{session.name}</div>
          <div className="mp-sub">{meta.label}</div>
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
              placeholder={`${meta.label}'s default`}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={() => {
                const v = modelDraft.trim();
                if (v === (session.model ?? "")) return;
                void setSessionModel(session.id, v || null);
                setNeedsRestart(true);
              }}
              list={meta.models?.length ? `mp-models-${agent}` : undefined}
            />
            {meta.models?.length ? (
              <datalist id={`mp-models-${agent}`}>
                {meta.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            ) : null}
          </label>
        ) : (
          <p className="mp-note">
            {meta.label} takes no per-invocation model flag, so its model is chosen inside the
            agent{meta.supportsEndpoint ? " or by the endpoint below" : ""}.
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

      {/* ---- Per-agent endpoint ------------------------------------------------ */}
      {meta.supportsEndpoint ? (
        <>
          <div className="mp-section-head" style={{ paddingTop: 4 }}>
            Endpoint
            <span className="mp-scope">every {meta.label} session</span>
          </div>
          <EndpointEditor
            agent={agent}
            sessionLocalOnly={!!session.localOnly}
            onChanged={() => setNeedsRestart(true)}
          />
        </>
      ) : null}

      {done ? <p className="mp-note">{done}</p> : null}

      {needsRestart ? (
        <div className="mp-restart">
          <span>
            {busy
              ? "Applying…"
              : busyAgent
                ? "This agent is mid-turn — these settings apply as soon as it finishes, or restart now to apply immediately."
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
