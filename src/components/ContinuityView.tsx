import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore, findSession } from "../store";
import { resolveProjectColor } from "../layout";
import type { AvatarTone } from "../avatars";
import { useContinuityGraph } from "../hooks/useContinuityGraph";
import { ContinuityGraph, type NodeView } from "./ContinuityGraph";
import { SessionDrawer } from "./SessionDrawer";
import { ContinuityTables } from "./ContinuityTables";
import { useContinuityTables } from "../hooks/useContinuityTables";
import { tabCount, type ServiceTab, type TableTab } from "../continuityTables";
import { sessionsAwaitingAnswer } from "../asks";

const TABS: { id: TableTab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "decisions", label: "Decisions" },
  { id: "handoffs", label: "Handoffs" },
  { id: "tasks", label: "Tasks" },
  { id: "files", label: "Files" },
  { id: "activity", label: "Activity" },
];

/** The per-project Continuity overlay. Renders over still-mounted terminals, like the
 *  task board. Read-only toward continuity; the only action is answering a question. */
export function ContinuityView({ projectId }: { projectId: string }) {
  const { snap, pulses } = useContinuityGraph(projectId, true);
  // Raw maps only: a selector that builds a fresh array/object loops under Zustand v5.
  const projects = useStore((s) => s.projects);
  const live = useStore((s) => s.live);
  const asks = useStore((s) => s.asks);
  const answeredAsks = useStore((s) => s.answeredAsks);
  const autoColors = useStore((s) => s.autoProjectColors);
  const [open, setOpen] = useState<string | null>(null);
  const setRendered = useStore((s) => s.setContinuityRendered);
  const [tab, setTab] = useState<TableTab>("graph");
  const [focus, setFocus] = useState<{ key: string | null; seq: number }>({ key: null, seq: 0 });
  const { data, now } = useContinuityTables(projectId, tab);
  useEffect(() => setTab("graph"), [projectId]);
  const focusNode = useCallback((key: string) => {
    setTab("graph");
    setFocus((f) => ({ key, seq: f.seq + 1 }));
  }, []);

  // Publish which sessions this view draws, so the dock covers every ask it does not
  // (another project's session, or one absent from the snapshot — incl. EMPTY_SNAPSHOT
  // right after opening). Cleared on close so the dock falls back to showing everything.
  // Behind a table tab the graph's cards are hidden, so it draws nothing for the dock to skip.
  const renderedSig = tab !== "graph" ? "" : snap.nodes
    .map((n) => n.conduitSessionId)
    .filter((x): x is string => !!x)
    .sort()
    .join("|");
  useEffect(() => {
    setRendered(renderedSig ? [...new Set(renderedSig.split("|"))] : []);
  }, [renderedSig, setRendered]);
  useEffect(() => () => setRendered([]), [setRendered]);

  const views = useMemo(() => {
    const out: Record<string, NodeView> = {};
    const askBySession = new Map<string, (typeof asks)[string]>();
    // Oldest first per session, matching the dock's order.
    for (const a of Object.values(asks).sort((x, y) => x.createdMs - y.createdMs)) {
      if (!askBySession.has(a.session)) askBySession.set(a.session, a);
    }
    // A card holding its "Sent to …" confirmation no longer makes the avatar amber.
    const waiting = sessionsAwaitingAnswer(Object.values(asks), answeredAsks);
    for (const n of snap.nodes) {
      const sid = n.conduitSessionId;
      const found = sid ? findSession(projects, sid) : null;
      const session = found?.session;
      const ask = sid ? askBySession.get(sid) : undefined;
      const waitingOnYou = !!sid && waiting.has(sid);
      const status = sid ? live[sid]?.status : undefined;
      const visitorProject = n.visitorProjectId ? projects.find((p) => p.id === n.visitorProjectId) : undefined;
      const tone: AvatarTone = n.visitor
        ? "visitor"
        : waitingOnYou || status === "needsInput"
          ? "needs"
          : session?.stopped
            ? "stopped"
            : status === "running"
              ? "running"
              : "idle";
      // A Continuity-only row inside this project's checkout: not a Conduit session, not a
      // visitor. Its raw label is machine-made (`conduit-8e755e`), so name it plainly.
      const unmatched = !sid && !n.visitor;
      const focusLine = (n.focus ?? "").split("\n")[0].trim();
      const unmatchedMeta = focusLine
        ? focusLine.length > 40
          ? `${focusLine.slice(0, 39)}…`
          : focusLine
        : n.status;
      const meta = waitingOnYou
        ? "waiting on you"
        : unmatched
          ? unmatchedMeta
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
        name: unmatched ? "Terminal session" : (session?.name ?? n.label),
        meta,
        title: unmatched ? n.label : undefined,
        tone,
        chip: visitorProject ? resolveProjectColor(visitorProject.id, visitorProject.color, autoColors) : null,
        badge: snap.unanswered[n.key] ?? 0,
        ask,
      };
    }
    return out;
  }, [snap, projects, live, asks, answeredAsks, autoColors]);

  return (
    <div className="continuity-view">
      <div className="continuity-tabs">
        <div className="continuity-tablist" role="tablist" aria-label="Continuity">
          {TABS.map((t) => {
            const v = t.id === "graph" ? undefined : data[t.id];
            const n = v?.available ? tabCount(t.id as ServiceTab, v.rows, now) : null;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`continuity-tab-${t.id}`}
                aria-selected={tab === t.id}
                className={`continuity-tab ${tab === t.id ? "on" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {n ? <span className="continuity-tab-count">{n}</span> : null}
              </button>
            );
          })}
        </div>
        {!snap.available && tab === "graph" && (
          <span className="continuity-unavail">Continuity isn't running for this project — showing sessions only.</span>
        )}
      </div>
      {/* The graph stays mounted behind the tables so pins, pan and zoom survive a tab switch. */}
      <ContinuityGraph
        projectId={projectId}
        snap={snap}
        views={views}
        pulses={pulses}
        onOpen={setOpen}
        focusKey={focus.key}
        focusSeq={focus.seq}
        hidden={tab !== "graph"}
      />
      {tab === "graph" && snap.nodes.length === 0 && (
        <div className="continuity-empty">No sessions in this project yet.</div>
      )}
      {tab !== "graph" && (
        <ContinuityTables tab={tab} data={data} snap={snap} views={views} now={now} onFocusNode={focusNode} />
      )}
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
