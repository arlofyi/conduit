import {
  activeModel,
  compactModel,
  contextRing,
  effortIndicator,
  effortText,
  headerMeta,
  stateText,
  usageBadge,
} from "./sessionHeader";
import type { UsageRow } from "./usage";

function row(windows: UsageRow["windows"]): UsageRow {
  return { key: "k", agent: "claude", label: "Claude", plan: null, windows, money: null, models: [], updatedAt: null, source: null };
}

describe("activeModel", () => {
  it("prefers the pin, then the live model, and never answers a dash", () => {
    expect(activeModel({ pinned: "claude-sonnet-4-5", live: "claude-opus-4-1" })).toEqual({ id: "claude-sonnet-4-5", label: "Sonnet" });
    expect(activeModel({ pinned: null, live: "claude-opus-4-1" })).toEqual({ id: "claude-opus-4-1", label: "Opus" });
    expect(activeModel({ pinned: null, live: null })).toEqual({ id: null, label: "Default" });
    expect(activeModel({ pinned: undefined, live: "" }).label).toBe("Default");
  });
  it("uses the agent's own label when it listed the model", () => {
    expect(activeModel({ pinned: null, live: "x/y", models: [{ id: "x/y", label: "Why" }] }).label).toBe("Why");
    expect(activeModel({ pinned: null, live: "deepseek/deepseek-v4-flash" }).label).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("effort", () => {
  it("an unpinned effort reads Default", () => {
    expect(effortText(null)).toBe("Default");
    expect(effortText("xhigh")).toBe("Extra high");
  });
  it("bars fill to the level; default is outlined and empty", () => {
    expect(effortIndicator(null)).toEqual({ filled: 0, steps: 5, isDefault: true, label: "Effort default" });
    expect(effortIndicator("high", ["low", "medium", "high"])).toEqual({ filled: 5, steps: 5, isDefault: false, label: "Effort high" });
    expect(effortIndicator("low", ["low", "medium", "high"]).filled).toBe(2);
    expect(effortIndicator("medium").filled).toBe(3);
  });
});

describe("contextRing", () => {
  it("colours green, amber from 70 %, red from 90 %", () => {
    expect(contextRing(0.36)).toEqual({ fraction: 0.36, tone: "ok", percent: 36, a11y: "36% of the context window used" });
    expect(contextRing(0.7)!.tone).toBe("warn");
    expect(contextRing(0.9)!.tone).toBe("bad");
    expect(contextRing(1.4)!.fraction).toBe(1);
    expect(contextRing(-1)!.percent).toBe(0);
  });
  it("is absent when unknown", () => {
    expect(contextRing(null)).toBeNull();
    expect(contextRing(undefined)).toBeNull();
    expect(contextRing(Number.NaN)).toBeNull();
  });
});

describe("usageBadge", () => {
  it("draws the 5-hour window with a caption and both windows spoken", () => {
    const b = usageBadge(
      row([
        { kind: "fiveHour", label: "5-hour", used: 0.19, resetsAt: null },
        { kind: "weekly", label: "Weekly", used: 0.42, resetsAt: null },
      ]),
    )!;
    expect(b).toEqual({ used: 0.19, percent: 19, caption: "5h", tone: "ok", a11y: "Usage: 5-hour 19% used, Weekly 42% used" });
  });
  it("falls back to the week, and to nothing", () => {
    const b = usageBadge(row([{ kind: "weekly", label: "Weekly", used: 0.93, resetsAt: null }]))!;
    expect(b.caption).toBe("wk");
    expect(b.tone).toBe("bad");
    expect(usageBadge(row([]))).toBeNull();
    expect(usageBadge(null)).toBeNull();
  });
});

describe("header line 2", () => {
  it("compacts a provider-prefixed model", () => {
    expect(compactModel("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(compactModel("Opus")).toBe("Opus");
    expect(compactModel(null)).toBeNull();
  });
  it("composes project, status, model, effort and auto-approve", () => {
    const m = headerMeta({
      name: "fix",
      projectName: "conduit",
      state: "running",
      model: "Opus",
      effort: "high",
      efforts: ["low", "medium", "high"],
      autoApprove: true,
      context: contextRing(0.36),
    });
    expect(m.status).toBe(stateText("running"));
    expect(m.model).toBe("Opus");
    expect(m.effort.filled).toBe(5);
    expect(m.autoApprove).toBe(true);
    expect(m.a11y).toBe("fix, conduit, working…, model Opus, Effort high, auto-approve on, 36% of the context window used. Session details");
  });
  it("leaves out what it does not know", () => {
    const m = headerMeta({ name: "s", projectName: null, state: "idle", model: null, effort: null });
    expect(m.autoApprove).toBe(false);
    expect(m.effort.isDefault).toBe(true);
    expect(m.a11y).toBe("s, idle, Effort default. Session details");
  });
});
