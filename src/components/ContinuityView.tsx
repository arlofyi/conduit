import { useMemo, useState } from "react";
import { useStore, findSession } from "../store";
import { resolveProjectColor } from "../layout";
import type { AvatarTone } from "../avatars";
import { useContinuityGraph } from "../hooks/useContinuityGraph";
import { ContinuityGraph, type NodeView } from "./ContinuityGraph";
import { SessionDrawer } from "./SessionDrawer";

/** The per-project Continuity overlay. Renders over still-mounted terminals, like the
 *  task board. Read-only toward continuity; the only action is answering a question. */
export function ContinuityView({ projectId }: { projectId: string }) {
  const { snap, pulses } = useContinuityGraph(projectId, true);
  // Raw maps only: a selector that builds a fresh array/object loops under Zustand v5.
  const projects = useStore((s) => s.projects);
  const live = useStore((s) => s.live);
  const asks = useStore((s) => s.asks);
  const autoColors = useStore((s) => s.autoProjectColors);
  const [open, setOpen] = useState<string | null>(null);

  const views = useMemo(() => {
    const out: Record<string, NodeView> = {};
    const askBySession = new Map<string, (typeof asks)[string]>();
    // Oldest first per session, matching the dock's order.
    for (const a of Object.values(asks).sort((x, y) => x.createdMs - y.createdMs)) {
      if (!askBySession.has(a.session)) askBySession.set(a.session, a);
    }
    for (const n of snap.nodes) {
      const sid = n.conduitSessionId;
      const found = sid ? findSession(projects, sid) : null;
      const session = found?.session;
      const ask = sid ? askBySession.get(sid) : undefined;
      const status = sid ? live[sid]?.status : undefined;
      const visitorProject = n.visitorProjectId ? projects.find((p) => p.id === n.visitorProjectId) : undefined;
      const tone: AvatarTone = n.visitor
        ? "visitor"
        : ask || status === "needsInput"
          ? "needs"
          : session?.stopped
            ? "stopped"
            : status === "running"
              ? "running"
              : "idle";
      const meta = ask
        ? "waiting on you"
        : n.visitor
          ? `visitor · ${visitorProject?.name ?? found?.project.name ?? "other checkout"}`
          : session?.stopped
            ? "stopped"
            : status === "running"
              ? "running"
              : n.status === "none"
                ? "not checked in"
                : n.status;
      out[n.key] = {
        key: n.key,
        name: session?.name ?? n.label,
        meta,
        tone,
        chip: visitorProject ? resolveProjectColor(visitorProject.id, visitorProject.color, autoColors) : null,
        badge: snap.unanswered[n.key] ?? 0,
        ask,
      };
    }
    return out;
  }, [snap, projects, live, asks, autoColors]);

  return (
    <div className="continuity-view">
      <div className="continuity-tabs">
        <span className="continuity-tab on">Graph</span>
        {!snap.available && (
          <span className="continuity-unavail">Continuity isn't running for this project — showing sessions only.</span>
        )}
      </div>
      <ContinuityGraph projectId={projectId} snap={snap} views={views} pulses={pulses} onOpen={setOpen} />
      {snap.nodes.length === 0 && <div className="continuity-empty">No sessions in this project yet.</div>}
      {open && (
        <SessionDrawer
          projectId={projectId}
          node={snap.nodes.find((n) => n.key === open) ?? null}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
