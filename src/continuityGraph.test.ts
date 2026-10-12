import { describe, expect, it } from "vitest";
import { askCardGeometry, askCardSide, awaitingNodes, pulsesFor, readPins, writePins, type GraphSnapshot } from "./continuityGraph";

const snap: GraphSnapshot = {
  available: true,
  nodes: [
    { key: "cs-1", conduitSessionId: "cs-1", continuityId: "c-1", label: "cs-1", status: "active", visitor: false },
    { key: "c-cli", continuityId: "c-cli", label: "root", status: "idle", visitor: false },
  ],
  edges: [], unanswered: {},
};

describe("pulsesFor", () => {
  it("maps continuity ids to node keys and orients the pulse", () => {
    const fwd = pulsesFor([{ id: "m1", from: "c-cli", to: "c-1", kind: "message", createdAt: "t" }], snap);
    expect(fwd).toEqual([{ id: "m1", a: "c-cli", b: "cs-1", reverse: false }]);
    const back = pulsesFor([{ id: "m1b", from: "c-1", to: "c-cli", kind: "message", createdAt: "t" }], snap);
    expect(back).toEqual([{ id: "m1b", a: "c-cli", b: "cs-1", reverse: true }]);
  });
  it("drops a message whose endpoint is not on screen", () => {
    expect(pulsesFor([{ id: "m2", from: "c-1", to: "ghost", kind: "message", createdAt: "t" }], snap)).toEqual([]);
  });
  it("drops self-messages", () => {
    expect(pulsesFor([{ id: "m3", from: "c-1", to: "c-1", kind: "message", createdAt: "t" }], snap)).toEqual([]);
  });
});

describe("pins", () => {
  it("round-trips per project and survives garbage", () => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    writePins("p1", { a: { x: 1, y: 2 } }, ls);
    writePins("p2", { b: { x: 3, y: 4 } }, ls);
    expect(readPins("p1", ls)).toEqual({ a: { x: 1, y: 2 } });
    store.set("conduit.continuityPins", "{not json");
    expect(readPins("p1", ls)).toEqual({});
    store.set("conduit.continuityPins", JSON.stringify({ p1: { a: { x: "nope" } } }));
    expect(readPins("p1", ls)).toEqual({});
  });
});

describe("askCardSide", () => {
  const me = { x: 0, y: 0 };
  it("opens right when nothing is nearby", () => {
    expect(askCardSide(me, [])).toBe("right");
    expect(askCardSide(me, [{ x: 0, y: 400 }, { x: -600, y: 0 }])).toBe("right");
  });
  it("flips left when a neighbour sits under the right-hand card", () => {
    expect(askCardSide(me, [{ x: 200, y: 60 }])).toBe("left");
  });
  it("picks the side with fewer overlaps, ties going right", () => {
    expect(askCardSide(me, [{ x: 200, y: 60 }, { x: 300, y: 100 }, { x: -200, y: 60 }])).toBe("left");
    expect(askCardSide(me, [{ x: 200, y: 60 }, { x: -200, y: 60 }, { x: -300, y: 100 }])).toBe("right");
    expect(askCardSide(me, [{ x: 200, y: 60 }, { x: -200, y: 60 }])).toBe("right");
  });
  it("honours a custom card size", () => {
    expect(askCardSide(me, [{ x: 200, y: 60 }], 100, 220)).toBe("right");
  });
});

describe("askCardGeometry", () => {
  it("keeps the card and tail on the avatar centre for both node sizes", () => {
    expect(askCardGeometry(72)).toEqual({ top: -6, tail: 36 });
    expect(askCardGeometry(56)).toEqual({ top: -14, tail: 36 });
    // The tail's centre (tail + 6) sits at the avatar centre in card coords (size/2 - top).
    for (const s of [56, 72]) {
      const g = askCardGeometry(s);
      expect(g.tail + 6).toBe(s / 2 - g.top);
    }
  });
});

describe("awaitingNodes", () => {
  const snap: GraphSnapshot = {
    available: true,
    nodes: [{ key: "s1", continuityId: "c-1" } as GraphSnapshot["nodes"][number]],
    edges: [],
    unanswered: {},
  };
  const msg = (id: string, from: string, to: string) => ({ id, from, to, kind: "message", createdAt: "t" });

  it("keeps a message whose endpoint has no node yet", () => {
    expect(awaitingNodes([msg("m1", "c-1", "c-new")], snap).map((m) => m.id)).toEqual(["m1"]);
  });

  it("drops a message both of whose endpoints are already drawn, and a self-message", () => {
    const both: GraphSnapshot = {
      ...snap,
      nodes: [...snap.nodes, { key: "s2", continuityId: "c-2" } as GraphSnapshot["nodes"][number]],
    };
    expect(awaitingNodes([msg("m2", "c-1", "c-2"), msg("m3", "c-9", "c-9")], both)).toEqual([]);
  });
});
