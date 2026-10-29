import { PIN_SLOP, holdPosition, isPinned, newItemCount, shouldFollow } from "./follow";

describe("follow rule (inverted feed: offset 0 is the newest message)", () => {
  it("follow_only_when_pinned", () => {
    // reading history higher up while the agent streams: never jump
    expect(shouldFollow(false, 1)).toBe(false);
    expect(shouldFollow(false, 20)).toBe(false);
    // at the bottom: follow the tail
    expect(shouldFollow(true, 1)).toBe(true);
    // nothing new: nothing to follow
    expect(shouldFollow(true, 0)).toBe(false);
    // the reader's own message always brings them down to it
    expect(shouldFollow(false, 1, true)).toBe(true);
    expect(shouldFollow(false, 0, true)).toBe(false);
  });

  it("isPinned reads the inverted offset with a small slop", () => {
    expect(isPinned(0)).toBe(true);
    expect(isPinned(PIN_SLOP)).toBe(true);
    expect(isPinned(PIN_SLOP + 1)).toBe(false);
    // iOS rubber-banding past the bottom reports a negative offset
    expect(isPinned(-30)).toBe(true);
  });

  it("holdPosition keeps the visible rows still only while scrolled up", () => {
    expect(holdPosition(true)).toBeUndefined();
    expect(holdPosition(false)).toEqual({ minIndexForVisible: 0 });
  });

  it("newItemCount counts rows added, never negative", () => {
    expect(newItemCount(3, 5)).toBe(2);
    expect(newItemCount(5, 5)).toBe(0);
    // a history replace that shrinks the feed is not "new"
    expect(newItemCount(9, 4)).toBe(0);
  });
});
