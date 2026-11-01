import { describe, expect, it } from "vitest";
import { createDedupe, detailsText, formatUptime, toReport } from "./diagnostics";

describe("toReport", () => {
  it("normalizes an Error with its stack and the component stack", () => {
    const e = new TypeError("boom");
    const r = toReport("render", e, "settings:about", "\n    at AboutPanel");
    expect(r.kind).toBe("render");
    expect(r.message).toBe("TypeError: boom");
    expect(r.stack).toContain("component stack:");
    expect(r.stack).toContain("at AboutPanel");
    expect(r.source).toBe("settings:about");
  });

  it("accepts strings, objects and undefined without throwing", () => {
    expect(toReport("rejection", "nope", "window").message).toBe("nope");
    expect(toReport("rejection", { code: 3 }, "window").message).toBe('{"code":3}');
    expect(toReport("rejection", undefined, "window").message).toBe("undefined");
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(toReport("error", circ, "window").message).toBe("[object Object]");
  });

  it("caps oversized messages and stacks", () => {
    const e = new Error("x".repeat(10_000));
    e.stack = "s".repeat(50_000);
    const r = toReport("error", e, "window");
    expect(r.message.length).toBeLessThanOrEqual(2001);
    expect((r.stack ?? "").length).toBeLessThanOrEqual(6001);
  });
});

describe("createDedupe", () => {
  it("drops an identical report inside the window and admits it after", () => {
    const allow = createDedupe(5000);
    const r = toReport("render", new Error("a"), "panel");
    expect(allow(r, 0)).toBe(true);
    expect(allow(r, 100)).toBe(false);
    expect(allow(toReport("render", new Error("b"), "panel"), 100)).toBe(true);
    expect(allow(r, 5000)).toBe(true);
  });

  it("stays bounded under many distinct messages", () => {
    const allow = createDedupe(5000, 10);
    for (let i = 0; i < 100; i++) allow(toReport("error", `m${i}`, "w"), i);
    // The earliest keys were evicted, so m0 is admitted again inside its window.
    expect(allow(toReport("error", "m0", "w"), 101)).toBe(true);
  });
});

describe("formatting", () => {
  it("formats uptime", () => {
    expect(formatUptime(12)).toBe("12s");
    expect(formatUptime(245)).toBe("4m 05s");
    expect(formatUptime(3720)).toBe("1h 02m");
  });

  it("builds copyable details", () => {
    const t = detailsText(toReport("render", new Error("bad"), "board"), "0.50.0");
    expect(t.split("\n")[0]).toBe("Conduit 0.50.0 — render in board");
    expect(t).toContain("Error: bad");
  });
});
