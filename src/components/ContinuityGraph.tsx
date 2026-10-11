import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SessionAvatar, type AvatarTone } from "../avatars";
import { layoutGraph, type Pt } from "../graphLayout";
import { readPins, writePins, type GraphSnapshot, type Pulse } from "../continuityGraph";
import type { PendingAsk } from "../asks";
import { AskCard } from "./AskCard";

export type NodeView = {
  key: string;
  name: string;
  meta: string;
  tone: AvatarTone;
  chip: string | null;
  badge: number;
  ask?: PendingAsk;
};

/** An edge counts as quiet once its last message is older than this. */
const QUIET_AFTER_MS = 10 * 60_000;

/** One travelling dot. SMIL resolves `begin="0"` against the SVG document's timeline,
 *  which started when the view opened — so a pulse inserted later would already be
 *  "finished" and freeze at its end point. `begin="indefinite"` + `beginElement()` on
 *  mount starts it now. Removal is the hook's timer (useContinuityGraph), not endEvent. */
function PulseDot({ path, reverse }: { path: string; reverse: boolean }) {
  const ref = useRef<SVGAnimateMotionElement | null>(null);
  useLayoutEffect(() => {
    try {
      ref.current?.beginElement();
    } catch {
      /* an engine without SMIL just shows no pulse */
    }
  }, []);
  return (
    <circle r={5} className="cgraph-pulse">
      <animateMotion
        ref={ref}
        begin="indefinite"
        dur="1.4s"
        fill="freeze"
        path={path}
        keyPoints={reverse ? "1;0" : "0;1"}
        keyTimes="0;1"
        calcMode="linear"
      />
    </circle>
  );
}

/** DOM + SVG only — no terminals live here, so scale() is safe (crisp vectors) and none of
 *  the canvas's stacking hazards apply. World coords are centred on 0,0; the layer sits at
 *  the viewport centre (CSS left/top 50% — a translate() percentage would resolve against
 *  the zero-size layer itself) and is translated by pan, then scaled. */
export function ContinuityGraph({
  projectId,
  snap,
  views,
  pulses,
  onOpen,
}: {
  projectId: string;
  snap: GraphSnapshot;
  views: Record<string, NodeView>;
  pulses: Pulse[];
  onOpen: (key: string) => void;
}) {
  const [pins, setPins] = useState(() => readPins(projectId));
  useEffect(() => setPins(readPins(projectId)), [projectId]);
  const prev = useRef<Record<string, Pt>>({});
  const keyList = snap.nodes.map((n) => n.key).join("|");
  const edgeSig = JSON.stringify(snap.edges);
  const pinSig = JSON.stringify(pins);
  const pos = useMemo(() => {
    const keys = keyList ? keyList.split("|") : [];
    const p = layoutGraph(keys, snap.edges, pins, prev.current);
    prev.current = p;
    return p;
    // Signatures, not identities: a refetch hands back equal-but-new arrays every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyList, edgeSig, pinSig]);

  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{
    kind: "pan" | "node";
    key?: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);
  const reduced =
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const quietBefore = new Date(Date.now() - QUIET_AFTER_MS).toISOString();
  const pathOf = (a: string, b: string) => {
    const p = pos[a],
      q = pos[b];
    if (!p || !q) return "";
    const mx = (p.x + q.x) / 2,
      my = (p.y + q.y) / 2;
    const nx = -(q.y - p.y) * 0.15,
      ny = (q.x - p.x) * 0.15;
    return `M${p.x} ${p.y} Q${mx + nx} ${my + ny} ${q.x} ${q.y}`;
  };

  return (
    <div
      className="cgraph"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".cgraph-node, .ask-card")) return;
        drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.sx,
          dy = e.clientY - d.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        if (d.kind === "pan") setPan({ x: d.ox + dx, y: d.oy + dy });
        else if (d.key && d.moved) {
          const k = d.key;
          setPins((p) => ({ ...p, [k]: { x: d.ox + dx / zoom, y: d.oy + dy / zoom } }));
        }
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.kind === "node" && d.key) {
          if (d.moved) writePins(projectId, pins);
          else onOpen(d.key);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onWheel={(e) => setZoom((z) => Math.min(2, Math.max(0.4, z * (e.deltaY > 0 ? 0.92 : 1.08))))}
    >
      <div
        className="cgraph-layer"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        <svg className="cgraph-edges" overflow="visible">
          {snap.edges.map((e) => (
            <path
              key={`${e.a}|${e.b}`}
              d={pathOf(e.a, e.b)}
              className={`cgraph-edge ${e.lastAt < quietBefore ? "quiet" : ""}`}
              strokeWidth={Math.min(5, 1 + Math.log2(1 + e.count))}
            />
          ))}
          {!reduced &&
            pulses.map((p) => {
              const d = pathOf(p.a, p.b);
              return d ? <PulseDot key={p.id} path={d} reverse={p.reverse} /> : null;
            })}
        </svg>
        {snap.nodes.map((n) => {
          const v = views[n.key];
          const p = pos[n.key];
          if (!v || !p) return null;
          return (
            <div
              key={n.key}
              className={`cgraph-node ${n.visitor ? "visitor" : ""}`}
              style={{ left: p.x, top: p.y }}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest(".ask-card")) return;
                e.stopPropagation();
                const at = pins[n.key] ?? p;
                drag.current = { kind: "node", key: n.key, sx: e.clientX, sy: e.clientY, ox: at.x, oy: at.y, moved: false };
                (e.currentTarget.closest(".cgraph") as HTMLElement | null)?.setPointerCapture(e.pointerId);
              }}
            >
              <SessionAvatar
                nodeKey={n.key}
                size={n.visitor ? 56 : 72}
                tone={v.tone}
                chipColor={v.chip}
                badge={v.badge}
                title={v.name}
              />
              <div className="cgraph-name">{v.name}</div>
              <div className={`cgraph-meta ${v.tone === "needs" ? "needs" : ""}`}>{v.meta}</div>
              {v.ask && <AskCard key={v.ask.id} ask={v.ask} sessionName={v.name} className="anchored" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
