import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graphLayout";

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
      for (let j = i + 1; j < n.length; j++) expect(dist(pos[n[i]], pos[n[j]])).toBeGreaterThan(80);
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
});
