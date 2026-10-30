import { accentFor, PROJECT_PALETTE, projectAccent, tint } from "./accent";

describe("projectAccent", () => {
  it("accent_matches_desktop", () => {
    // Same fixture as src/layout.test.ts ("accent_matches_desktop"), produced by running the
    // desktop's own projectAccent. Change only together with that copy.
    expect(projectAccent("p1")).toBe("#c47f88");
    expect(projectAccent("A")).toBe("#75a898");
    expect(projectAccent("ooozzy")).toBe("#93ad7c");
    expect(projectAccent("Samle")).toBe("#c9a86b");
    expect(projectAccent("9f3c1e")).toBe("#b8b072");
  });

  it("ports the desktop palette exactly", () => {
    expect(PROJECT_PALETTE).toEqual([
      "#c4906c",
      "#c9a86b",
      "#b8b072",
      "#93ad7c",
      "#75a898",
      "#7c9fb8",
      "#9691c4",
      "#b989b1",
      "#c47f88",
      "#a89383",
    ]);
  });
});

describe("accentFor", () => {
  it("a chosen colour wins, else the derived accent", () => {
    expect(accentFor({ id: "p1", color: "#123456" })).toBe("#123456");
    expect(accentFor({ id: "p1", color: null })).toBe("#c47f88");
    expect(accentFor({ id: "p1", color: "" })).toBe("#c47f88");
  });
});

describe("tint", () => {
  it("adds alpha to a 6-digit hex and leaves anything else alone", () => {
    expect(tint("#c47f88", 0.2)).toBe("#c47f8833");
    expect(tint("rgb(1,2,3)", 0.2)).toBeNull();
  });
});
