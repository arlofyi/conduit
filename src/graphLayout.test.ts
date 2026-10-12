import { describe, expect, it } from "vitest";
import { clipSegment, layoutGraph } from "./graphLayout";

const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);

describe("layoutGraph", () => {
  it("is deterministic", () => {
    const n = ["a", "b", "c", "d"];
    const e = [{ a: "a", b: "b", count: 3 }];
    expect(layoutGraph(n, e, {})).toEqual(layoutGraph(n, e, {}));
  });
  it("keeps every node apart", () => {
    const n = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const pos = layoutGraph(n, [], {});
    for (let i = 0; i < n.length; i++)
      for (let j = i + 1; j < n.length; j++) expect(dist(pos[n[i]], pos[n[j]])).toBeGreaterThan(160);
  });
  it("pulls connected nodes closer than unconnected ones", () => {
    const n = ["a", "b", "c"];
    const pos = layoutGraph(n, [{ a: "a", b: "b", count: 10 }], {});
    expect(dist(pos.a, pos.b)).toBeLessThan(dist(pos.a, pos.c));
  });
  it("never moves a pinned node", () => {
    const pos = layoutGraph(["a", "b"], [{ a: "a", b: "b", count: 1 }], { a: { x: 500, y: -200 } });
    expect(pos.a).toEqual({ x: 500, y: -200 });
  });
  it("a new node does not reshuffle settled ones much", () => {
    const first = layoutGraph(["a", "b", "c"], [], {});
    const second = layoutGraph(["a", "b", "c", "d"], [], {}, first);
    for (const k of ["a", "b", "c"]) expect(dist(first[k], second[k])).toBeLessThan(60);
  });
  it("handles zero and one node", () => {
    expect(layoutGraph([], [], {})).toEqual({});
    expect(layoutGraph(["solo"], [], {})).toEqual({ solo: { x: 0, y: 0 } });
  });
  it("clips a segment inward by exactly the radii", () => {
    const c = clipSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, 40, 32)!;
    expect(c.a).toEqual({ x: 40, y: 0 });
    expect(c.b).toEqual({ x: 68, y: 0 });
    const diag = clipSegment({ x: 0, y: 0 }, { x: 30, y: 40 }, 10, 10)!;
    expect(dist(diag.a, { x: 0, y: 0 })).toBeCloseTo(10);
    expect(dist(diag.b, { x: 30, y: 40 })).toBeCloseTo(10);
  });
  it("returns null when the centres are closer than the radii", () => {
    expect(clipSegment({ x: 0, y: 0 }, { x: 60, y: 0 }, 40, 32)).toBeNull();
    expect(clipSegment({ x: 0, y: 0 }, { x: 72, y: 0 }, 40, 32)).toBeNull();
  });
});
