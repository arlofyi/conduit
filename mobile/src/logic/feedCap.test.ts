import type { ChatItem } from "../data/types";
import { capFeed, FEED_CAP, FEED_CAP_ID } from "./feed";

const items = (n: number, from = 0): ChatItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "bubble", id: `b${from + i}`, role: "user", text: `${from + i}` }));

describe("capFeed", () => {
  it("leaves a feed under the cap untouched (same array)", () => {
    const f = items(10);
    expect(capFeed(f, 10)).toBe(f);
    expect(FEED_CAP).toBe(2000);
  });

  it("keeps the newest items behind one divider", () => {
    const out = capFeed(items(12), 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toMatchObject({ kind: "divider", id: FEED_CAP_ID, label: "Earlier messages are on your computer" });
    expect(out.slice(1).map((i) => i.id)).toEqual(["b8", "b9", "b10", "b11"]);
  });

  it("does not stack dividers as the feed keeps growing", () => {
    let f = capFeed(items(6), 5);
    f = capFeed([...f, ...items(3, 6)], 5);
    expect(f.filter((i) => i.id === FEED_CAP_ID)).toHaveLength(1);
    expect(f[0].id).toBe(FEED_CAP_ID);
    expect(f.slice(1).map((i) => i.id)).toEqual(["b5", "b6", "b7", "b8"]);
  });
});
