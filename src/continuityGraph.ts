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

/** Card top sits this far above the node centre (`.ask-card.anchored` top + node offset). */
const ASK_CARD_TOP = 42;
/** The card's near edge sits this far from the node centre, on either side. */
const ASK_CARD_GAP = 50;

/** Which side of its avatar an anchored question card opens on: right unless another node's
 *  centre would sit under the right-hand card, then whichever side covers fewer (ties right). */
export function askCardSide(node: Pt, others: Pt[], cardW = 300, cardH = 220): "right" | "left" {
  const top = node.y - ASK_CARD_TOP;
  const inside = (x0: number) =>
    others.filter((o) => o.x >= x0 && o.x <= x0 + cardW && o.y >= top && o.y <= top + cardH).length;
  const right = inside(node.x + ASK_CARD_GAP);
  if (right === 0) return "right";
  const left = inside(node.x - ASK_CARD_GAP - cardW);
  return left < right ? "left" : "right";
}

/** Where an anchored card and its tail sit, in px, for an avatar of `size`. The node box's
 *  top edge is the avatar's top (it is translated up by size/2), so the card's top is
 *  `size/2 - ASK_CARD_TOP` and the 12px tail is centred ASK_CARD_TOP below the card's top —
 *  on the avatar centre whatever the node's size (visitors are 56px, members 72px). */
export function askCardGeometry(size: number): { top: number; tail: number } {
  return { top: size / 2 - ASK_CARD_TOP, tail: ASK_CARD_TOP - 6 };
}
