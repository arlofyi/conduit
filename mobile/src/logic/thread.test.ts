import type { ChatItem } from "../data/types";
import { groupFeed } from "./feed";
import { layoutThread, sameFeedRow } from "./thread";

const t = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const NOW = new Date(2026, 9, 30, 9, 0).getTime();

const bubble = (id: string, role: "user" | "assistant", at?: string): ChatItem => ({ kind: "bubble", id, role, text: id, at });

function shape(items: ChatItem[]) {
  return layoutThread(groupFeed(items), NOW).map((r) =>
    r.type === "date" ? `[${r.label}]` : `${r.key}${r.first ? "^" : ""}${r.last ? "$" : ""}`,
  );
}

describe("layoutThread / groupBubbles", () => {
  it("groups consecutive same-role bubbles; the first carries the tail, the last ends the run", () => {
    expect(
      shape([bubble("u1", "user", t(30, 8)), bubble("u2", "user", t(30, 8)), bubble("a1", "assistant", t(30, 8)), bubble("a2", "assistant", t(30, 8)), bubble("a3", "assistant", t(30, 8))]),
    ).toEqual(["[Today]", "u1^", "u2$", "a1^", "a2", "a3$"]);
  });

  it("breaks a run at anything that is not a same-role bubble", () => {
    const items: ChatItem[] = [
      bubble("a1", "assistant", t(30, 8)),
      { kind: "event", id: "e1", event: "read", label: "read", mono: "x.ts", at: t(30, 8) },
      bubble("a2", "assistant", t(30, 8)),
    ];
    expect(shape(items)).toEqual(["[Today]", "a1^$", "e1^$", "a2^$"]);
  });

  it("dateSeparator: a pill whenever the local day changes, and runs never cross it", () => {
    expect(shape([bubble("a", "user", t(28, 22)), bubble("b", "user", t(29, 9)), bubble("c", "user", t(30, 7))])).toEqual([
      "[Wednesday]",
      "a^$",
      "[Yesterday]",
      "b^$",
      "[Today]",
      "c^$",
    ]);
  });

  it("keeps untimed rows on the day before them and gives them no time", () => {
    const rows = layoutThread(
      groupFeed([bubble("a", "user", t(30, 8)), { kind: "divider", id: "d", label: "Interrupted", tone: "warning" }]),
      NOW,
    );
    expect(rows.map((r) => r.type)).toEqual(["date", "row", "row"]);
    const d = rows[2];
    expect(d.type === "row" && d.time).toBe("");
    const a = rows[1];
    expect(a.type === "row" && a.time).toBe("8:00 AM");
  });

  it("draws no pill for a feed with no times at all", () => {
    expect(shape([bubble("a", "user"), bubble("b", "user")])).toEqual(["a^", "b$"]);
  });
});

describe("sameFeedRow", () => {
  const ev = (id: string, toolUseId: string): ChatItem => ({ kind: "event", id, event: "read", label: "Read", toolUseId });
  const res = (toolUseId: string): ChatItem => ({ kind: "result", id: `r-${toolUseId}`, toolUseId, isError: false, errorText: null, diff: null });

  it("treats rows rebuilt around the same items as unchanged", () => {
    const a1 = bubble("a1", "assistant");
    const e1 = ev("e1", "t1");
    const before = groupFeed([a1, e1]);
    const after = groupFeed([a1, e1, bubble("a2", "assistant")]);
    expect(after[0]).not.toBe(before[0]);
    expect(sameFeedRow(before[0], after[0])).toBe(true);
    // the call row: still running before the new bubble, unknown after -> it DID change
    expect(sameFeedRow(before[1], after[1])).toBe(false);
  });

  it("sees a call's result arrive, and a folded run grow", () => {
    const e1 = ev("e1", "t1");
    const e2 = ev("e2", "t2");
    const e3 = ev("e3", "t3");
    const r1 = res("t1");
    const r2 = res("t2");
    const r3 = res("t3");
    const two = groupFeed([e1, r1, e2, r2]);
    const twoAgain = groupFeed([e1, r1, e2, r2]);
    const three = groupFeed([e1, r1, e2, r2, e3, r3]);
    expect(sameFeedRow(two[0], twoAgain[0])).toBe(true);
    expect(sameFeedRow(two[0], three[0])).toBe(false);
    expect(sameFeedRow(two[0], groupFeed([bubble("x", "user")])[0])).toBe(false);
  });
});
