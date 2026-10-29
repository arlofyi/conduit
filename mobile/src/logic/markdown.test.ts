import { plainText, splitInsights } from "./markdown";

describe("splitInsights", () => {
  it("lifts an Insight block out as a callout, like the desktop", () => {
    const src = "Before.\n\n`★ Insight ─────────────────`\n- one\n- two\n`─────────────────`\n\nAfter.";
    expect(splitInsights(src)).toEqual([
      { kind: "md", text: "Before." },
      { kind: "insight", text: "- one\n- two" },
      { kind: "md", text: "After." },
    ]);
  });
  it("returns plain text as one segment", () => {
    expect(splitInsights("just **text**")).toEqual([{ kind: "md", text: "just **text**" }]);
    expect(splitInsights("")).toEqual([{ kind: "md", text: "" }]);
  });
});

describe("plainText", () => {
  it("drops markdown chrome but keeps the words and the code", () => {
    expect(plainText("**Bold lead.** Then `code` and a [link](https://x.y).")).toBe("Bold lead. Then code and a link.");
    expect(plainText("## Title\n- *item*")).toBe("Title\n- item");
    expect(plainText("```bash\ngit status\n```")).toBe("git status");
  });
});
