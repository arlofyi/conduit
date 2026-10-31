import { outputPreview, splitRecommended } from "./chatView";

describe("splitRecommended", () => {
  it("strips a trailing (Recommended) into a tag", () => {
    expect(splitRecommended("Ship it (Recommended)")).toEqual({ label: "Ship it", recommended: true });
  });
  it("leaves every other label alone", () => {
    expect(splitRecommended("Ship it")).toEqual({ label: "Ship it", recommended: false });
    expect(splitRecommended("(Recommended) first")).toEqual({ label: "(Recommended) first", recommended: false });
    expect(splitRecommended("Ship it(Recommended)")).toEqual({ label: "Ship it(Recommended)", recommended: false });
  });
});

describe("outputPreview", () => {
  const five = "1\n2\n3\n4\n5";
  it("shows the first 3 lines of long output and counts the rest", () => {
    expect(outputPreview(five, false)).toEqual({ text: "1\n2\n3", hidden: 2 });
  });
  it("shows everything when expanded", () => {
    expect(outputPreview(five, true)).toEqual({ text: five, hidden: 0 });
  });
  it("never collapses 3 lines or fewer", () => {
    expect(outputPreview("1\n2\n3", false)).toEqual({ text: "1\n2\n3", hidden: 0 });
    expect(outputPreview("one", false)).toEqual({ text: "one", hidden: 0 });
  });
});

describe("hasBlocks", () => {
  it("spots lists, tables, fences and headings, not prose", () => {
    const { hasBlocks } = require("./chatView");
    expect(hasBlocks("Found the cause:\n\n- one\n- two")).toBe(true);
    expect(hasBlocks("1. first\n2. second")).toBe(true);
    expect(hasBlocks("| a | b |\n|---|---|")).toBe(true);
    expect(hasBlocks("```ts\nx\n```")).toBe(true);
    expect(hasBlocks("## Title")).toBe(true);
    expect(hasBlocks("Done. The fix is in - see above.")).toBe(false);
    expect(hasBlocks("Costs 5 - 3 = 2")).toBe(false);
  });
});
