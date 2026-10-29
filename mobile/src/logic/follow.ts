/**
 * Whether the chat feed follows the tail. The feed is an INVERTED list, so scroll offset 0 is
 * the newest message and a reader scrolled up into history has a positive offset.
 *
 * The rule (plan Review Focus 5): a reader scrolled up while the agent streams must not be
 * yanked to the bottom. Only a reader already at the bottom follows new rows; the reader's
 * own message is the one exception, since they just acted at the bottom of the screen.
 */

/** How far (pt) above the newest row still counts as "at the bottom". */
export const PIN_SLOP = 24;

/** Inverted list: offset 0 (or a rubber-band past it) is the bottom. */
export function isPinned(offsetY: number): boolean {
  return offsetY <= PIN_SLOP;
}

export function shouldFollow(atBottom: boolean, newItems: number, sentByMe = false): boolean {
  if (newItems <= 0) return false;
  return atBottom || sentByMe;
}

/** Rows added between two renders; a shrink (history replaced) is not "new". */
export function newItemCount(prevLength: number, nextLength: number): number {
  return Math.max(0, nextLength - prevLength);
}

/**
 * FlatList `maintainVisibleContentPosition` for the current pin state: while scrolled up, the
 * first visible row is held still as rows arrive at index 0 (the bottom); while pinned, the
 * list is left alone so offset 0 keeps showing the newest row.
 */
export function holdPosition(atBottom: boolean): { minIndexForVisible: number } | undefined {
  return atBottom ? undefined : { minIndexForVisible: 0 };
}
