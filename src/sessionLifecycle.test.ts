import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIFECYCLE,
  clampMinutes,
  idleStopTargets,
  launchResumeTargets,
  parseLifecycle,
} from "./sessionLifecycle";

describe("parseLifecycle", () => {
  it("defaults to resuming only working sessions and stopping after 5 minutes", () => {
    expect(parseLifecycle(null, null)).toEqual(DEFAULT_LIFECYCLE);
    expect(DEFAULT_LIFECYCLE.launchRestore).toBe("working");
    expect(DEFAULT_LIFECYCLE.autoStopMinutes).toBe(5);
    expect(DEFAULT_LIFECYCLE.resumeWaitingOnLaunch).toBe(false);
  });

  it("maps the legacy restore switch only when it was turned off", () => {
    expect(parseLifecycle(null, "0").launchRestore).toBe("none");
    expect(parseLifecycle(null, "1").launchRestore).toBe("working");
  });

  it("keeps valid fields and repairs bad ones individually", () => {
    const p = parseLifecycle(
      JSON.stringify({ launchRestore: "bogus", autoStopMinutes: 0, autoStopWaiting: true }),
      null,
    );
    expect(p.launchRestore).toBe("working");
    expect(p.autoStopMinutes).toBe(1);
    expect(p.autoStopWaiting).toBe(true);
    expect(p.keepAgentsInProject).toBe(true);
    expect(parseLifecycle("{not json", null)).toEqual(DEFAULT_LIFECYCLE);
  });

  it("clamps minutes to a sane range", () => {
    expect(clampMinutes(-3)).toBe(1);
    expect(clampMinutes(99999)).toBe(1440);
    expect(clampMinutes("7")).toBe(7);
    expect(clampMinutes(Number.NaN)).toBe(5);
  });
});

describe("launchResumeTargets", () => {
  const sessions = [
    { id: "working", agentState: "running" },
    { id: "waiting", agentState: "needsInput" },
    { id: "done", agentState: "done" },
    { id: "never" },
    { id: "parked", agentState: "running", stopped: true },
  ];

  it("brings back only agents that were mid-task", () => {
    expect([...launchResumeTargets(sessions, DEFAULT_LIFECYCLE)]).toEqual(["working"]);
  });

  it("adds waiting sessions only when asked", () => {
    const p = { ...DEFAULT_LIFECYCLE, resumeWaitingOnLaunch: true };
    expect([...launchResumeTargets(sessions, p)].sort()).toEqual(["waiting", "working"]);
  });

  it("starts nothing by itself in the other modes", () => {
    expect(launchResumeTargets(sessions, { ...DEFAULT_LIFECYCLE, launchRestore: "none" }).size).toBe(0);
    expect(launchResumeTargets(sessions, { ...DEFAULT_LIFECYCLE, launchRestore: "project" }).size).toBe(0);
  });
});

describe("idleStopTargets", () => {
  const now = 10 * 60_000;
  const base = {
    now,
    visible: new Set<string>(),
    prefs: DEFAULT_LIFECYCLE,
    sessions: [
      { id: "doneLong", projectId: "p" },
      { id: "doneShort", projectId: "p" },
      { id: "running", projectId: "p" },
      { id: "waiting", projectId: "p" },
      { id: "conductor", projectId: "p", role: "conductor" },
      { id: "neverReported", projectId: "p" },
      { id: "stopped", projectId: "p", stopped: true },
    ],
    live: {
      doneLong: { status: "done", updatedAt: now - 6 * 60_000 },
      doneShort: { status: "done", updatedAt: now - 60_000 },
      running: { status: "running", updatedAt: 0 },
      waiting: { status: "needsInput", updatedAt: 0 },
      conductor: { status: "idle", updatedAt: 0 },
      neverReported: { status: "idle" },
      stopped: { status: "done", updatedAt: 0 },
    },
  };
  const ids = (input: Parameters<typeof idleStopTargets>[0]) =>
    idleStopTargets(input).map((t) => t.sessionId);

  it("stops only finished sessions that have been quiet long enough", () => {
    expect(ids(base)).toEqual(["doneLong"]);
  });

  it("never stops a running agent, even with every option on", () => {
    const all = {
      ...base,
      prefs: { ...DEFAULT_LIFECYCLE, autoStopWaiting: true, autoStopVisible: true },
    };
    expect(ids(all)).toEqual(["doneLong", "waiting"]);
  });

  it("leaves the session on screen alone unless asked", () => {
    expect(ids({ ...base, visible: new Set(["doneLong"]) })).toEqual([]);
    expect(
      ids({ ...base, visible: new Set(["doneLong"]), prefs: { ...DEFAULT_LIFECYCLE, autoStopVisible: true } }),
    ).toEqual(["doneLong"]);
  });

  it("does nothing when switched off", () => {
    expect(ids({ ...base, prefs: { ...DEFAULT_LIFECYCLE, autoStopIdle: false } })).toEqual([]);
  });
});
