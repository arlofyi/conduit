import {
  headerGauge,
  moneyFraction,
  moneyLabel,
  parseUsageFrame,
  pickWindows,
  resetCopy,
  rowForSession,
  severity,
  toMs,
  updatedAgo,
  usedLabel,
  type UsageRow,
} from "./usage";

const NOW = Date.parse("2026-11-01T12:00:00Z");

const frame = {
  type: "usage",
  requestId: "u1",
  agents: [
    {
      key: "claude:default",
      agent: "claude",
      label: "usman@arlo.fyi",
      plan: "Max",
      windows: [
        { kind: "fiveHour", label: "5-hour", used: 0.18, resetsAt: "2026-11-01T14:10:00Z" },
        { kind: "weekly", label: "Weekly", used: 0.42, resetsAt: null },
        { kind: "weeklyOpus", label: "Weekly · Opus", used: 0.3, resetsAt: null },
      ],
      models: ["claude-opus-4-1", { id: "sonnet", label: "Sonnet" }, 3],
      updatedAt: NOW - 12_000,
      source: "live",
    },
    {
      key: "antigravity:a",
      agent: "antigravity",
      label: "agy",
      plan: null,
      windows: [
        { kind: "fiveHour", label: "Gemini Models · 5-hour", used: 0.2, resetsAt: 1762005600 },
        { kind: "fiveHour", label: "Claude & GPT Models · 5-hour", used: 0.95, resetsAt: null },
      ],
      updatedAt: null,
      source: null,
    },
    { agent: "codex" },
    { key: "openrouter:hermes", agent: "hermes", windows: [{ kind: "credit", used: 0 }], money: { spent: 12.4, limit: null, remaining: null } },
  ],
};

describe("parseUsageFrame", () => {
  it("reads rows defensively and drops keyless ones", () => {
    const rows = parseUsageFrame(frame)!;
    expect(rows.map((r) => r.key)).toEqual(["claude:default", "antigravity:a", "openrouter:hermes"]);
    expect(rows[0].models).toEqual(["claude-opus-4-1", "Sonnet"]);
    expect(rows[0].windows[0].resetsAt).toBe(Date.parse("2026-11-01T14:10:00Z"));
    expect(rows[1].windows[0].resetsAt).toBe(1762005600 * 1000);
    expect(rows[2].money).toEqual({ spent: 12.4, limit: null, remaining: null });
    expect(rows[2].label).toBe("hermes");
    expect(rows[2].windows[0].label).toBe("Credit");
  });
  it("is null for another frame, empty for no agents", () => {
    expect(parseUsageFrame({ type: "ports" })).toBeNull();
    expect(parseUsageFrame({ type: "usage" })).toEqual([]);
  });
  it("clamps used into 0..1", () => {
    const rows = parseUsageFrame({ type: "usage", agents: [{ key: "k", windows: [{ kind: "weekly", used: 1.4 }, { kind: "fiveHour", used: -1 }] }] })!;
    expect(rows[0].windows.map((w) => w.used)).toEqual([1, 0]);
  });
});

describe("toMs", () => {
  it("takes seconds, ms and ISO", () => {
    expect(toMs(1762005600)).toBe(1762005600000);
    expect(toMs(1762005600000)).toBe(1762005600000);
    expect(toMs("nope")).toBeNull();
    expect(toMs(0)).toBeNull();
  });
});

describe("pickWindows", () => {
  const rows = parseUsageFrame(frame)!;
  it("picks the 5 h and week windows; plain weekly unless Opus is more spent", () => {
    const w = pickWindows(rows[0]);
    expect(w.fiveHour?.used).toBe(0.18);
    expect(w.week?.kind).toBe("weekly");
  });
  it("shows the worst pool for agy", () => {
    expect(pickWindows(rows[1]).fiveHour?.used).toBe(0.95);
    expect(pickWindows(rows[1]).week).toBeNull();
  });
  it("nothing for no row", () => {
    expect(pickWindows(null)).toEqual({ fiveHour: null, week: null });
  });
});

describe("severity and labels", () => {
  it("is consumption: nearly spent is red", () => {
    expect(severity(0.1)).toBe("ok");
    expect(severity(0.7)).toBe("warn");
    expect(severity(0.92)).toBe("bad");
  });
  it("reads 'N% used' like the desktop default", () => {
    expect(usedLabel({ kind: "fiveHour", label: "5-hour", used: 0.183, resetsAt: null })).toBe("18% used");
  });
  it("money: uncapped shows spend and no bar", () => {
    expect(moneyLabel({ spent: 12.4, limit: null, remaining: null })).toBe("$12.40 spent");
    expect(moneyFraction({ spent: 12.4, limit: null, remaining: null })).toBeNull();
    expect(moneyLabel({ spent: 5, limit: 50, remaining: 45 })).toBe("$5.00 of $50.00");
    expect(moneyFraction({ spent: 5, limit: 50, remaining: 45 })).toBeCloseTo(0.1);
  });
});

describe("times", () => {
  it("reset copy", () => {
    expect(resetCopy(null, NOW)).toBeNull();
    expect(resetCopy(NOW + 10_000, NOW)).toBe("resets now");
    expect(resetCopy(NOW + 42 * 60_000, NOW)).toBe("resets in 42m");
    expect(resetCopy(NOW + 130 * 60_000, NOW)).toBe("resets in 2h 10m");
    expect(resetCopy(NOW + 3 * 3_600_000, NOW)).toBe("resets in 3h");
    expect(resetCopy(NOW + 52 * 3_600_000, NOW)).toBe("resets in 2d 4h");
  });
  it("updated ago", () => {
    expect(updatedAgo(null, NOW)).toBeNull();
    expect(updatedAgo(NOW - 12_000, NOW)).toBe("updated 12s ago");
    expect(updatedAgo(NOW - 5 * 60_000, NOW)).toBe("updated 5m ago");
    expect(updatedAgo(NOW - 2 * 3_600_000, NOW)).toBe("updated 2h ago");
  });
});

describe("rowForSession", () => {
  const rows = parseUsageFrame(frame)!;
  it("matches usageKey exactly, else the agent's first row", () => {
    expect(rowForSession(rows, "antigravity:a", "claude")?.key).toBe("antigravity:a");
    expect(rowForSession(rows, null, "claude")?.key).toBe("claude:default");
    expect(rowForSession(rows, "gone", "claude")?.key).toBe("claude:default");
    expect(rowForSession(rows, null, "codex")).toBeNull();
    expect(rowForSession(null, "x", "claude")).toBeNull();
  });
});

describe("headerGauge", () => {
  it("draws the 5 h window and names both in its label", () => {
    const rows = parseUsageFrame(frame)!;
    const g = headerGauge(rows[0])!;
    expect(g.window.kind).toBe("fiveHour");
    expect(g.a11y).toBe("Usage: 5-hour 18% used, Weekly 42% used");
  });
  it("falls back to the week; nothing with neither", () => {
    const row: UsageRow = { key: "k", agent: "a", label: "a", plan: null, windows: [{ kind: "weekly", label: "Weekly", used: 0.5, resetsAt: null }], money: null, models: [], updatedAt: null, source: null };
    expect(headerGauge(row)?.window.kind).toBe("weekly");
    expect(headerGauge({ ...row, windows: [] })).toBeNull();
    expect(headerGauge(null)).toBeNull();
  });
});
