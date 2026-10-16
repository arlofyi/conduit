/** Deterministic force layout for the Continuity graph. Pure: same input, same output, so
 *  the graph does not jitter between snapshot refetches. Repulsion between every pair,
 *  springs along edges (stronger with volume), gentle pull to the centre; pinned nodes are
 *  fixed. `prev` seeds settled nodes where they were, so a newcomer barely moves them. */
export type Pt = { x: number; y: number };

const ITER = 220;
const REPULSE = 60000;
const SPRING = 0.02;
const REST = 240;
const CENTER = 0.006;
const MIN_GAP = 170;

function seed(key: string): Pt {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const angle = ((h % 3600) / 3600) * Math.PI * 2;
  const r = 140 + (h >>> 12) % 120;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

export function layoutGraph(
  nodes: string[],
  edges: { a: string; b: string; count: number }[],
  pins: Record<string, Pt>,
  prev: Record<string, Pt> = {},
): Record<string, Pt> {
  if (nodes.length === 0) return {};
  if (nodes.length === 1) return { [nodes[0]]: pins[nodes[0]] ?? prev[nodes[0]] ?? { x: 0, y: 0 } };
  const keys = [...nodes].sort();
  const pos: Record<string, Pt> = {};
  for (const k of keys) pos[k] = { ...(pins[k] ?? prev[k] ?? seed(k)) };
  const settled = new Set(keys.filter((k) => k in prev));
  const live = edges.filter((e) => e.a in pos && e.b in pos && e.a !== e.b);

  for (let it = 0; it < ITER; it++) {
    const cool = 1 - it / ITER;
    const force: Record<string, Pt> = {};
    for (const k of keys) force[k] = { x: -pos[k].x * CENTER, y: -pos[k].y * CENTER };
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const p = pos[keys[i]], q = pos[keys[j]];
        let dx = p.x - q.x, dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = 1; dy = 0; d2 = 1; }
        const f = REPULSE / d2;
        const d = Math.sqrt(d2);
        force[keys[i]].x += (dx / d) * f; force[keys[i]].y += (dy / d) * f;
        force[keys[j]].x -= (dx / d) * f; force[keys[j]].y -= (dy / d) * f;
      }
    }
    for (const e of live) {
      const p = pos[e.a], q = pos[e.b];
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const k = SPRING * (1 + Math.log2(1 + e.count)) * (d - REST);
      force[e.a].x += (dx / d) * k; force[e.a].y += (dy / d) * k;
      force[e.b].x -= (dx / d) * k; force[e.b].y -= (dy / d) * k;
    }
    for (const k of keys) {
      if (pins[k]) continue;
      const damp = settled.has(k) ? 0.15 : 1; // settled nodes drift, newcomers move
      const step = Math.min(30 * cool, Math.hypot(force[k].x, force[k].y)) * damp;
      const m = Math.hypot(force[k].x, force[k].y) || 1;
      pos[k].x += (force[k].x / m) * step;
      pos[k].y += (force[k].y / m) * step;
    }
  }
  // Final separation pass: guarantee MIN_GAP between unpinned neighbours.
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i], b = keys[j];
        const dx = pos[b].x - pos[a].x, dy = pos[b].y - pos[a].y;
        const d = Math.hypot(dx, dy) || 1;
        if (d >= MIN_GAP) continue;
        const push = (MIN_GAP - d) / 2 + 0.5;
        const ux = dx / d, uy = dy / d;
        if (!pins[a]) { pos[a].x -= ux * push; pos[a].y -= uy * push; }
        if (!pins[b]) { pos[b].x += ux * push; pos[b].y += uy * push; }
      }
    }
  }
  const out: Record<string, Pt> = {};
  for (const k of nodes) out[k] = pins[k] ? { ...pins[k] } : { x: Math.round(pos[k].x), y: Math.round(pos[k].y) };
  return out;
}

/** Shorten the segment p->q by `rp` at p and `rq` at q along the line between them, so an
 *  edge starts and ends at the avatar boundary rather than its centre. Null when the
 *  centres are not farther apart than the two radii (nothing left to draw). */
export function clipSegment(p: Pt, q: Pt, rp: number, rq: number): { a: Pt; b: Pt } | null {
  const dx = q.x - p.x, dy = q.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d <= rp + rq) return null;
  const ux = dx / d, uy = dy / d;
  return {
    a: { x: p.x + ux * rp, y: p.y + uy * rp },
    b: { x: q.x - ux * rq, y: q.y - uy * rq },
  };
}
