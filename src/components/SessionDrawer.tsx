import { useEffect } from "react";
import type { GraphNode } from "../continuityGraph";
import { useStore, findSession } from "../store";
import { SessionAvatar } from "../avatars";
import { SessionChat } from "./SessionChat";
import { blocksGlobalShortcut } from "../keyboardGuards";

/** Avatar click. A Claude session reads as its conversation (read-only — the composer
 *  lives in the session's own pane); other agents get a stub; a visitor gets what
 *  continuity knows. "Open session" jumps to the real tab. */
export function SessionDrawer({ node, onClose }: { projectId: string; node: GraphNode | null; onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const selectSession = useStore((s) => s.selectSession);
  const setCenterMode = useStore((s) => s.setCenterMode);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Esc inside a terminal interrupts the agent; inside a field it belongs to the field.
      if (e.key !== "Escape" || blocksGlobalShortcut(e.target)) return;
      onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  if (!node) return null;
  const found = node.conduitSessionId ? findSession(projects, node.conduitSessionId) : null;
  const isClaude = found?.session.agent === "claude";
  return (
    <aside className="session-drawer" aria-label={`${found?.session.name ?? node.label} details`}>
      <header className="session-drawer-hd">
        <SessionAvatar nodeKey={node.key} size={40} tone={node.visitor ? "visitor" : "idle"} />
        <div>
          <div className="session-drawer-name">{found?.session.name ?? node.label}</div>
          <div className="session-drawer-meta">
            {node.visitor ? `visitor · ${found?.project.name ?? "outside Conduit"}` : node.status}
          </div>
        </div>
        {found && (
          <button
            type="button"
            className="header-btn"
            onClick={() => {
              selectSession(found.project.id, found.session.id);
              // The Continuity overlay covers the terminals; "open" means the terminal.
              setCenterMode(found.project.id, "terminals");
              onClose();
            }}
          >
            Open session ↗
          </button>
        )}
        <button type="button" className="session-drawer-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="session-drawer-body">
        {found && isClaude ? (
          <SessionChat key={found.session.id} sessionId={found.session.id} onClose={onClose} readOnly />
        ) : found ? (
          <p className="session-drawer-note">
            This agent has no conversation view. Open the session to see its terminal.
          </p>
        ) : (
          <dl className="session-drawer-facts">
            <dt>Focus</dt>
            <dd>{node.focus ?? "—"}</dd>
            <dt>Last seen</dt>
            <dd>{node.lastSeenAt ?? "—"}</dd>
            <dt>Continuity id</dt>
            <dd>
              <code>{node.continuityId ?? "—"}</code>
            </dd>
          </dl>
        )}
      </div>
    </aside>
  );
}
