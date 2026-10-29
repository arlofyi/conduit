import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import { chatHeader, headerState, modelLabel, subline } from "./chatHeader";

function sess(over: Partial<WireViewSession> & { id: string }): WireViewSession {
  return {
    name: over.id,
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
    ...over,
  };
}

const VIEW: WireProjectsView = {
  profiles: [{ id: null, name: "Default" }],
  activeProfileId: null,
  projects: [
    {
      id: "p1",
      name: "conduit",
      profileId: null,
      color: "#123456",
      sessions: [sess({ id: "s1", name: "auto-stop fix", status: "running", updatedAt: 1000, model: "claude-opus-4-1" })],
    },
  ],
};

const NO_LIVE = { status: "idle" as const, at: 0 };

describe("subline", () => {
  it("subline_states", () => {
    expect(subline({ state: "needs", model: "Opus", fraction: 0.41 })).toBe("waiting on you · Opus · 41% context");
    expect(subline({ state: "running", model: "Opus", fraction: 0.41 })).toBe("working… · Opus · 41% context");
    expect(subline({ state: "idle", model: "Opus", fraction: 0.41 })).toBe("idle · Opus · 41% context");
    // without model / context the state stands alone
    expect(subline({ state: "needs", model: null, fraction: null })).toBe("waiting on you");
    expect(subline({ state: "running", model: "Sonnet", fraction: null })).toBe("working… · Sonnet");
    expect(subline({ state: "idle", model: null, fraction: 0.004 })).toBe("idle · 0% context");
    // a bogus fraction is dropped rather than printed as NaN
    expect(subline({ state: "idle", model: null, fraction: Number.NaN })).toBe("idle");
    expect(subline({ state: "idle", model: null, fraction: 1.7 })).toBe("idle · 100% context");
  });
});

describe("modelLabel", () => {
  it("names the family, keeps unknown ids as they are", () => {
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("Opus");
    expect(modelLabel("claude-sonnet-4-5")).toBe("Sonnet");
    expect(modelLabel("deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
    expect(modelLabel("")).toBeNull();
    expect(modelLabel(null)).toBeNull();
  });
});

describe("headerState", () => {
  it("maps statuses; done reads idle", () => {
    expect(headerState("needsInput")).toBe("needs");
    expect(headerState("running")).toBe("running");
    expect(headerState("done")).toBe("idle");
    expect(headerState("idle")).toBe("idle");
  });
});

describe("chatHeader", () => {
  const base = { view: VIEW, sessionId: "s1", projectId: "p1", fallbackName: "auto-stop fix", context: null };

  it("titles 'Project · title' with the agent initials on the project colour", () => {
    const h = chatHeader({ ...base, live: NO_LIVE });
    expect(h.title).toBe("conduit · auto-stop fix");
    expect(h.initials).toBe("CL");
    expect(h.color).toBe("#123456");
    expect(h.state).toBe("running");
    expect(h.canStop).toBe(true);
    expect(h.subline).toBe("working… · Opus");
  });

  it("a newer live status wins over the polled view, an older one does not", () => {
    expect(chatHeader({ ...base, live: { status: "done", at: 2000 } }).state).toBe("idle");
    expect(chatHeader({ ...base, live: { status: "done", at: 2000 } }).canStop).toBe(false);
    expect(chatHeader({ ...base, live: { status: "done", at: 500 } }).state).toBe("running");
  });

  it("a pending question in the view reads as waiting on you", () => {
    const v: WireProjectsView = {
      ...VIEW,
      projects: [{ ...VIEW.projects[0], sessions: [sess({ id: "s1", status: "running", needs: { kind: "ask", text: "Ship?" } })] }],
    };
    expect(chatHeader({ ...base, view: v, live: NO_LIVE }).state).toBe("needs");
  });

  it("prefers the context frame's model and shows its fraction", () => {
    const h = chatHeader({ ...base, live: NO_LIVE, context: { fraction: 0.415, model: "claude-sonnet-4-5" } });
    expect(h.subline).toBe("working… · Sonnet · 42% context");
  });

  it("falls back to the route params when the view does not have the session yet", () => {
    const h = chatHeader({ ...base, view: null, live: NO_LIVE });
    expect(h.title).toBe("auto-stop fix");
    expect(h.initials).toBe("?");
    expect(h.state).toBe("idle");
    expect(h.subline).toBe("idle");
  });
});
