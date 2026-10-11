/** Continuity graph: snapshot types (mirror continuity_graph.rs), live message → pulse
 *  mapping, and per-project pin storage. Store-free for vitest. */
import type { Pt } from "./graphLayout";

export type GraphNode = {
  key: string; conduitSessionId?: string; continuityId?: string; label: string; status: string;
  focus?: string; lastSeenAt?: string; visitor: boolean; visitorProjectId?: string;
};
export type GraphEdge = { a: string; b: string; count: number; lastAt: string };
export type GraphSnapshot = { available: boolean; nodes: GraphNode[]; edges: GraphEdge[]; unanswered: Record<string, number> };
export type WatchedMessage = { id: string; from: string; to: string; kind: string; createdAt: string };
export type Pulse = { id: string; a: string; b: string; reverse: boolean };

export const EMPTY_SNAPSHOT: GraphSnapshot = { available: false, nodes: [], edges: [], unanswered: {} };

/** A pulse per message whose BOTH endpoints are on screen. Endpoints arrive as continuity
 *  ids; nodes are keyed by Conduit session id where one exists. The edge is drawn a→b with
 *  a < b, so a message travelling b→a runs reversed. Anything unmappable is dropped — a
 *  pulse never invents a node or an edge. */
export function pulsesFor(messages: WatchedMessage[], snap: GraphSnapshot): Pulse[] {
  const keyOf = new Map<string, string>();
  for (const n of snap.nodes) {
    if (n.continuityId) keyOf.set(n.continuityId, n.key);
  }
  const out: Pulse[] = [];
  for (const m of messages) {
    const from = keyOf.get(m.from);
    const to = keyOf.get(m.to);
    if (!from || !to || from === to) continue;
    const [a, b] = from < to ? [from, to] : [to, from];
    out.push({ id: m.id, a, b, reverse: from !== a });
  }
  return out;
}

const PINS_KEY = "conduit.continuityPins";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const isPt = (v: unknown): v is Pt =>
  !!v && typeof (v as Pt).x === "number" && typeof (v as Pt).y === "number" &&
  Number.isFinite((v as Pt).x) && Number.isFinite((v as Pt).y);

function readAll(ls: Storage): Record<string, Record<string, Pt>> {
  try {
    const raw = JSON.parse(ls.getItem(PINS_KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function readPins(projectId: string, ls: Storage = localStorage): Record<string, Pt> {
  const all = readAll(ls)[projectId];
  if (!all || typeof all !== "object") return {};
  const out: Record<string, Pt> = {};
  for (const [k, v] of Object.entries(all)) if (isPt(v)) out[k] = { x: v.x, y: v.y };
  return out;
}

export function writePins(projectId: string, pins: Record<string, Pt>, ls: Storage = localStorage): void {
  try {
    const all = readAll(ls);
    all[projectId] = pins;
    ls.setItem(PINS_KEY, JSON.stringify(all));
  } catch {
    /* quota — non-fatal */
  }
}
