/** Pure display rules the phone shares with desktop's SessionChat, so one conversation
 * reads the same on both. */

const RECOMMENDED = / \(Recommended\)$/;

/** An AskUserQuestion option label with Claude's trailing " (Recommended)" split off into
 * a flag, which the card draws as a small tag (desktop's `Question` does the same). */
export function splitRecommended(label: string): { label: string; recommended: boolean } {
  return RECOMMENDED.test(label)
    ? { label: label.replace(RECOMMENDED, ""), recommended: true }
    : { label, recommended: false };
}

/** Lines of command output shown before "more" (desktop's `CommandOutput` uses 3). */
export const OUTPUT_PREVIEW_LINES = 3;

/** What a command output block shows: the first lines when collapsed, plus how many are
 * hidden. Output of 3 lines or fewer is never collapsed. */
export function outputPreview(text: string, open: boolean): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (open || lines.length <= OUTPUT_PREVIEW_LINES) return { text, hidden: 0 };
  return {
    text: lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n"),
    hidden: lines.length - OUTPUT_PREVIEW_LINES,
  };
}

/** Markdown blocks that lay out as flex rows or fixed grids (see the bubble's width rule). */
export function hasBlocks(md: string): boolean {
  return /^\s*([-*+]|\d+[.)])\s|^\s*\|.*\||^\s*```|^\s*#{1,6}\s/m.test(md);
}
