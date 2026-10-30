import { COMPOSER, composerHeight, composerMetrics } from "./composer";

describe("composerMetrics", () => {
  it("is the design size at the default text size or before a measurement", () => {
    expect(composerMetrics(null, 8)).toEqual(COMPOSER);
    expect(composerMetrics(21, 8)).toEqual(COMPOSER);
    expect(composerMetrics(Number.NaN, 8)).toEqual(COMPOSER);
  });

  it("grows with large Dynamic Type so one line is never clipped", () => {
    const m = composerMetrics(40, 8);
    expect(m.min).toBe(56);
    expect(m.max).toBe(216);
    expect(composerHeight("a", null, m)).toBe(56);
    expect(composerHeight("", 300, m)).toBe(56);
  });
});

describe("composerHeight", () => {
  it("grows with the content up to about five lines", () => {
    expect(composerHeight("a", 38)).toBe(COMPOSER.min);
    expect(composerHeight("a\nb\nc", 82)).toBe(82);
    expect(composerHeight("1\n2\n3\n4\n5\n6\n7\n8", 220)).toBe(COMPOSER.max);
  });

  it("shrinks back to one line once cleared, whatever the stale reading says", () => {
    // The founder's bug: after sending 4 lines the field stayed 4 lines tall while empty.
    expect(composerHeight("", 104)).toBe(COMPOSER.min);
  });

  it("shrinks when lines are deleted", () => {
    expect(composerHeight("a\nb\nc", 82)).toBe(82);
    expect(composerHeight("a", 38)).toBe(COMPOSER.min);
  });

  it("never drops below one line, and survives a missing or bad reading", () => {
    expect(composerHeight("a", 10)).toBe(COMPOSER.min);
    expect(composerHeight("a", null)).toBe(COMPOSER.min);
    expect(composerHeight("a", Number.NaN)).toBe(COMPOSER.min);
  });
});
