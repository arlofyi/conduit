import type { ChatItem } from "../data/types";
import { groupFeed } from "./feed";
import { layoutThread } from "./thread";

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
