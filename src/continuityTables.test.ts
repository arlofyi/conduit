import { describe, expect, it } from "vitest";
import { nodeKeyForAuthorLabel, nodeKeyForContinuityId, relativeTime, supersedeChain, tabCount, relativeUntil } from "./continuityTables";
import type { GraphSnapshot } from "./continuityGraph";
import type { FeedDecision } from "./continuityFeed";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("relativeTime", () => {
  it("reads under a minute as just now", () => {
    expect(relativeTime(ago(59_000), NOW)).toBe("just now");
    expect(relativeTime(ago(0), NOW)).toBe("just now");
  });
  it("switches to minutes at 60 s", () => {
    expect(relativeTime(ago(60_000), NOW)).toBe("1m");
    expect(relativeTime(ago(4 * 60_000), NOW)).toBe("4m");
  });
  it("floors 90 minutes to 1h", () => {
    expect(relativeTime(ago(90 * 60_000), NOW)).toBe("1h");
  });
  it("floors 49 hours to 2d", () => {
    expect(relativeTime(ago(49 * 3_600_000), NOW)).toBe("2d");
  });
  it("treats clock skew as just now and garbage as empty", () => {
    expect(relativeTime(new Date(NOW + 30_000).toISOString(), NOW)).toBe("just now");
    expect(relativeTime("not a date", NOW)).toBe("");
  });
});

const snap: GraphSnapshot = {
  available: true,
  nodes: [
    { key: "cs-1", conduitSessionId: "cs-1", continuityId: "c-1", label: "cs-1", status: "active", visitor: false },
    { key: "c-cli", continuityId: "c-cli", label: "conduit-8e755e", status: "idle", visitor: false },
    { key: "cs-2", conduitSessionId: "cs-2", label: "cs-2", status: "none", visitor: false },
  ],
  edges: [],
  unanswered: {},
};

describe("nodeKeyForContinuityId", () => {
  it("maps a Conduit session's continuity id to its Conduit key", () => {
    expect(nodeKeyForContinuityId("c-1", snap)).toBe("cs-1");
  });
  it("maps a checkout-only row to its own key", () => {
    expect(nodeKeyForContinuityId("c-cli", snap)).toBe("c-cli");
  });
  it("returns null for an id not on the graph", () => {
    expect(nodeKeyForContinuityId("c-unknown", snap)).toBeNull();
    expect(nodeKeyForContinuityId("", snap)).toBeNull();
  });
});

describe("nodeKeyForAuthorLabel", () => {
  it("maps a Conduit session label (its session id) to the node", () => {
    expect(nodeKeyForAuthorLabel("cs-2", snap)).toBe("cs-2");
  });
  it("maps a checkout row by its raw label", () => {
    expect(nodeKeyForAuthorLabel("conduit-8e755e", snap)).toBe("c-cli");
  });
  it("returns null for an unknown or absent label", () => {
    expect(nodeKeyForAuthorLabel("stranger", snap)).toBeNull();
    expect(nodeKeyForAuthorLabel(null, snap)).toBeNull();
  });
});

const d = (id: string, supersedes: string | null): FeedDecision => ({
  id,
  decisionKey: `k.${id}`,
  content: "",
  decisionType: "architecture",
  status: "active",
  supersedes,
  createdAt: "2026-10-12T00:00:00.000Z",
  authorLabel: null,
});

describe("supersedeChain", () => {
  it("follows d3 -> d2 -> d1, newest first", () => {
    const all = [d("d1", null), d("d3", "d2"), d("d2", "d1")];
    expect(supersedeChain(all, "d3")).toEqual(["d3", "d2", "d1"]);
  });
  it("stops at a link that is not loaded", () => {
    expect(supersedeChain([d("d3", "d2"), d("d2", "gone")], "d3")).toEqual(["d3", "d2"]);
  });
  it("terminates on a cycle", () => {
    expect(supersedeChain([d("a", "b"), d("b", "a")], "a")).toEqual(["a", "b"]);
  });
  it("is empty for an unknown id and singular for a root", () => {
    expect(supersedeChain([d("d1", null)], "nope")).toEqual([]);
    expect(supersedeChain([d("d1", null)], "d1")).toEqual(["d1"]);
  });
});

describe("tabCount", () => {
  it("counts what still wants attention", () => {
    expect(tabCount("decisions", [d("a", null), { ...d("b", null), status: "superseded" }])).toBe(1);
    expect(
      tabCount("tasks", [
        { id: "t1", repo: "o/r", issue: 1, status: "claimed", expiresAt: "", lastActivityAt: "" },
        { id: "t2", repo: "o/r", issue: 2, status: "released", expiresAt: "", lastActivityAt: "" },
      ]),
    ).toBe(1);
    expect(tabCount("files", [])).toBeNull();
  });
});

describe("relativeUntil", () => {
  it("reads a future time as a countdown and a past one as expired", () => {
    expect(relativeUntil(new Date(NOW + 4 * 60_000).toISOString(), NOW)).toBe("in 4m");
    expect(relativeUntil(new Date(NOW + 30_000).toISOString(), NOW)).toBe("in <1m");
    expect(relativeUntil(ago(1000), NOW)).toBe("expired");
    expect(relativeUntil("x", NOW)).toBe("");
  });
});
