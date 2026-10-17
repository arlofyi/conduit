import { useEffect, useMemo, useState } from "react";
import { useStore, type ProfileSection } from "../store";
import { agentMeta, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";

/**
 * The Agent tab — what this session's agent KNOWS and what it can reach.
 *
 * The Model tab answers "what is it running on". This answers the other half: its memory,
 * the skills it has loaded, the MCP servers it can call. For an agent with persistent
 * memory that is the more interesting question, and it had no surface anywhere.
 *
 * **Adaptive, and empty sections are omitted rather than drawn empty.** Agents expose very
 * different things — Hermes keeps memory files and a skill tree, Claude has MCP servers and
 * subagents, OpenCode has neither — so a fixed set of headings would be mostly blank for
 * most agents, and a blank "Memory" heading reads as "this agent forgot everything" rather
 * than "this agent has no such concept". Sections therefore come from whoever can actually
 * fill them: the Rust side reads Hermes' files, and Claude's MCP registry is added here
 * because it lives in the frontend (localStorage), not on the Rust side.
 */

function Section({
  section,
  onOpen,
  onManage,
}: {
  section: ProfileSection;
  onOpen: (s: ProfileSection, i: number) => void;
  /** Present only for a section Conduit already has an editor for. Sections without one
   *  say nothing rather than offering a button that goes nowhere. */
  onManage?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="ap-section">
      <button className="ap-section-head" onClick={() => setOpen((o) => !o)}>
        <span className="ap-caret">{open ? "▾" : "▸"}</span>
        {section.title}
        <span className="ap-count">{section.items.length}</span>
      </button>
      {onManage ? (
        <button
          className="mp-link ap-manage"
          onClick={(e) => {
            e.stopPropagation();
            onManage();
          }}
        >
          Manage…
        </button>
      ) : null}
      {open ? (
        <div className="ap-items">
          {section.items.map((it, i) => {
            // Only a row with a body is interactive; a bare row must not look clickable.
            const readable = !!it.body;
            const body = (
              <>
                <span className="ap-item-name">{it.name}</span>
                <span className="ap-item-detail">{it.detail}</span>
              </>
            );
            return (
              <div
                key={`${it.name}-${i}`}
                className={`ap-row${it.enabled === false ? " off" : ""}`}
              >
                {readable ? (
                  <button className="ap-item readable" onClick={() => onOpen(section, i)}>
                    {body}
                  </button>
                ) : (
                  <div className="ap-item">{body}</div>
                )}
                {/* State, not a control. Conduit cannot change this — see `ProfileItem.enabled`
                    in agent_profile.rs for the measurement. Showing it is still worth it: a
                    skill the agent is ignoring is exactly the thing you go looking for when it
                    will not do something you expect. */}
                {it.enabled === false ? <span className="ap-locked">off</span> : null}
              </div>
            );
          })}
          {/* Said once per section, not once per row, and only where something is actually
              switched off -- otherwise it is a standing note about a state that never occurs. */}
          {section.items.some((it) => it.enabled === false) ? (
            <div className="ap-apply-note">
              Dimmed skills are switched off in Hermes' own config (<code>hermes skills config</code>).
            </div>
          ) : null}
          {section.source ? <div className="ap-source" title={section.source}>{section.source}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function AgentPanel({ sessionId }: { sessionId: string | null }) {
  const projects = useStore((s) => s.projects);
  const profiles = useStore((s) => s.agentProfiles);
  const loadProfile = useStore((s) => s.loadAgentProfile);
  const mcpServers = useStore((s) => s.mcpServers);
  const mcpEnabled = useStore((s) => s.mcpEnabled);
  const writeMemory = useStore((s) => s.writeAgentMemory);
  const writeSkill = useStore((s) => s.writeAgentSkill);
  const setSettingsTab = useStore((s) => s.setSettingsTab);
  const setShowSettings = useStore((s) => s.setShowSettings);
  // What the open reader is editing: a memory document (by file name) or a skill (by key).
  // Kept on the reader itself rather than inferred from the title, because a skill's DISPLAY
  // name comes from its frontmatter and is not what the writer addresses it by.
  const [reading, setReading] = useState<
    { title: string; body: string; kind: "memory" | "skill"; key: string } | null
  >(null);

  const [draft, setDraft] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const session = useMemo(() => {
    for (const p of projects) {
      const s = p.sessions.find((x) => x.id === sessionId);
      if (s) return s;
    }
    return null;
  }, [projects, sessionId]);

  // Re-read when the session changes AND while the tab is open: memory is written by the
  // agent as it works, so a panel that only read once would go stale mid-session. The read
  // is local files, so this is cheap; it is deliberately slower than the status polls.
  useEffect(() => {
    if (!sessionId) return;
    void loadProfile(sessionId);
    const t = setInterval(() => void loadProfile(sessionId), 10_000);
    return () => clearInterval(t);
  }, [sessionId, loadProfile]);

  if (!sessionId || !session) {
    return (
      <p className="placeholder" style={{ padding: 12 }}>
        No session selected.
      </p>
    );
  }

  const agent: AgentId = session.agent;
  const meta = agentMeta(agent);
  const profile = profiles[sessionId];

  // Claude's MCP surface is frontend state (the registry is localStorage, and the session's
  // allowlist is on the session), so it is composed here rather than read in Rust. An
  // absent allowlist means "inherit everything the agent would load anyway", which is NOT
  // the same as an empty one — see the hibernate/allowlist design.
  const claudeMcp: ProfileSection | null = useMemo(() => {
    if (!meta.supportsMcp) return null;
    const allow = session.mcpServers;
    const eligible = mcpServers.filter((srv) => (mcpEnabled[srv.name] ?? []).includes(agent));
    const chosen = allow == null ? eligible : eligible.filter((srv) => allow.includes(srv.name));
    if (chosen.length === 0) return null;
    return {
      id: "mcp-registry",
      title: "MCP servers",
      items: chosen.map((srv) => ({
        name: srv.name,
        detail: srv.transport === "http" ? (srv.url ?? "http") : (srv.command ?? "stdio"),
        body: null,
      })),
      source: allow == null ? "Conduit registry · inherited" : "Conduit registry · this session's allowlist",
    };
  }, [meta.supportsMcp, session.mcpServers, mcpServers, mcpEnabled, agent]);

  const sections: ProfileSection[] = [
    ...(profile?.sections ?? []),
    // Only when Rust did not already supply one, so an agent that reports its own MCP
    // servers is not listed twice under two different sources.
    ...(claudeMcp && !(profile?.sections ?? []).some((s) => s.id === "mcp") ? [claudeMcp] : []),
  ];

  return (
    <div className="agent-panel">
      <div className="mp-head">
        <AgentGlyph id={agent} size={16} />
        <div className="mp-head-text">
          <div className="mp-title">{session.name}</div>
          <div className="mp-sub">{meta.label}</div>
        </div>
      </div>

      {sections.length === 0 ? (
        <p className="mp-note">
          {profile?.unsupported
            ? `${meta.label} exposes no memory, skills or MCP servers that Conduit can read.`
            : `Nothing to show yet — ${meta.label} has not recorded any memory, skills or MCP servers.`}
        </p>
      ) : (
        sections.map((s) => (
          <Section
            key={s.id}
            section={s}
            // MCP is the one section with a real editor already: the MCP matrix adds and
            // removes servers through each agent's own CLI. Pointing at it beats a second
            // editor that could disagree with the first.
            onManage={
              s.id === "mcp" || s.id === "mcp-registry"
                ? () => {
                    setSettingsTab("mcp");
                    setShowSettings(true);
                  }
                : undefined
            }
            onOpen={(sec, i) => {
              const it = sec.items[i];
              const body = it.body ?? "";
              setReading({
                title: it.name,
                body,
                kind: sec.id === "skills" ? "skill" : "memory",
                // A memory document is addressed by its file name, a skill by its directory
                // name; `key` carries the latter and is absent for the former.
                key: it.key ?? it.name,
              });
              setDraft(body);
              setSaveErr(null);
            }}
          />
        ))
      )}

      {reading ? (
        <div className="ap-reader" onClick={() => setReading(null)}>
          <div className="ap-reader-box" onClick={(e) => e.stopPropagation()}>
            <div className="ap-reader-head">
              {reading.title}
              <span className="ap-reader-actions">
                {/* A truncated preview must never be written back — saving it would delete
                    everything past the cap. The panel refuses rather than risking it. */}
                {reading.body.endsWith("… truncated") ? (
                  <span className="mp-warn">Too long to edit here — open the file.</span>
                ) : (
                  <button
                    className="mp-btn"
                    disabled={saving || draft === reading.body}
                    onClick={async () => {
                      setSaving(true);
                      const err =
                        reading.kind === "skill"
                          ? await writeSkill(sessionId, reading.key, draft)
                          : await writeMemory(sessionId, reading.key, draft);
                      setSaving(false);
                      if (err) setSaveErr(err);
                      else setReading({ ...reading, body: draft });
                    }}
                  >
                    {saving ? "Saving…" : draft === reading.body ? "Saved" : "Save"}
                  </button>
                )}
                <button className="mp-btn" onClick={() => setReading(null)}>
                  Close
                </button>
              </span>
            </div>
            {saveErr ? <p className="mp-warn" style={{ padding: "0 12px" }}>{saveErr}</p> : null}
            {reading.body.endsWith("… truncated") ? (
              <pre className="ap-reader-body">{reading.body}</pre>
            ) : (
              <textarea
                className="ap-reader-body ap-reader-edit"
                value={draft}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
