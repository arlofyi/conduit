import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import { AWAY_MIN_MS, awaySummary, awayText } from "./catchUp";

function sess(id: string, over: Partial<WireViewSession> = {}): WireViewSession {
  return {
    id,
    name: id,
    agent: "claude",
    branch: null,
    model: null,
    stopped: false,
    running: false,
    silo: false,
    status: "idle",
    activity: null,
    updatedAt: null,
    needs: null,
    lastMessage: null,
    ...over,
  };
}
const view = (sessions: WireViewSession[]): WireProjectsView => ({
  profiles: [],
  activeProfileId: null,
  projects: [{ id: "p", name: "P", profileId: null, color: null, sessions }],
});

const SINCE = new Date(2026, 10, 1, 14, 5).getTime();
const NOW = SINCE + 60 * 60_000;

describe("while you were away", () => {
  it("counts finished turns, new questions and new sessions", () => {
    const before = view([sess("a", { status: "running" }), sess("b", { status: "running" }), sess("c"), sess("d", { status: "running" })]);
    const after = view([
      sess("a", { status: "done" }),
      sess("b", { status: "idle" }),
      sess("c", { needs: { kind: "ask", text: "Which?" } }),
      sess("d", { status: "running" }),
      sess("e", { status: "running" }),
    ]);
    const s = awaySummary(before, SINCE, after, NOW);
    expect(s).toEqual({ since: SINCE, finished: 2, needs: 1, started: 1, working: 2, firstNeedsId: "c" });
    expect(awayText(s!, NOW)).toBe("Since 2:05 PM: 2 finished, 1 needs you, 1 new session · 2 still working");
  });

  it("a turn that started AND finished while away counts as finished", () => {
    const s = awaySummary(view([sess("a", { status: "idle" })]), SINCE, view([sess("a", { status: "done", updatedAt: SINCE + 1000 })]), NOW);
    expect(s?.finished).toBe(1);
  });

  it("says nothing after a short blip", () => {
    const before = view([sess("a", { status: "running" })]);
    const after = view([sess("a", { status: "done" })]);
    expect(awaySummary(before, NOW - AWAY_MIN_MS + 1, after, NOW)).toBeNull();
  });

  it("says nothing when nothing worth saying changed", () => {
    const v = view([sess("a", { status: "running" }), sess("b", { needs: { kind: "input", text: null } })]);
    expect(awaySummary(v, SINCE, v, NOW)).toBeNull();
  });

  it("says nothing without a list to compare with", () => {
    expect(awaySummary(null, SINCE, view([sess("a")]), NOW)).toBeNull();
    expect(awaySummary(view([]), null, view([sess("a")]), NOW)).toBeNull();
  });

  it("never counts private sessions", () => {
    const before = view([sess("s", { silo: true, status: "running" })]);
    const after = view([sess("s", { silo: true, status: "done" }), sess("t", { silo: true, needs: { kind: "input", text: null } })]);
    expect(awaySummary(before, SINCE, after, NOW)).toBeNull();
  });

  it("words plurals", () => {
    const s = { since: SINCE, finished: 0, needs: 2, started: 3, working: 0, firstNeedsId: "x" };
    expect(awayText(s, NOW)).toBe("Since 2:05 PM: 2 need you, 3 new sessions");
  });
});
