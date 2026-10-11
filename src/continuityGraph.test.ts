import { describe, expect, it } from "vitest";
import { pulsesFor, readPins, writePins, type GraphSnapshot } from "./continuityGraph";

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
