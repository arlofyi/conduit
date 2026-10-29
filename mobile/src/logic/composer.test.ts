import { COMPOSER, composerHeight } from "./composer";

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
