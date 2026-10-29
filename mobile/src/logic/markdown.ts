/**
 * Port of the desktop's `splitInsights` (src/markdown.ts): split an assistant message around
 * its `★ Insight` blocks so each renders as a callout card instead of raw dash-rule chrome.
 * Keep the regex identical to the desktop's.
 */

export type MdSegment = { kind: "md" | "insight"; text: string };

/** `★ Insight ─────` (code span) … body … `─────` (closing code-span rule). */
const INSIGHT_RE = /`★\s*Insight[^\n`]*`\s*\n([\s\S]*?)\n\s*`─+`/g;

export function splitInsights(source: string): MdSegment[] {
  const out: MdSegment[] = [];
  let last = 0;
  for (const m of source.matchAll(INSIGHT_RE)) {
    const at = m.index ?? 0;
    const before = source.slice(last, at).trim();
    if (before) out.push({ kind: "md", text: before });
    const inner = m[1].trim();
    if (inner) out.push({ kind: "insight", text: inner });
    last = at + m[0].length;
  }
  const rest = source.slice(last).trim();
  if (rest) out.push({ kind: "md", text: rest });
  if (out.length === 0) out.push({ kind: "md", text: source });
  return out;
}

/**
 * Plain text of a markdown message, for the long-press Copy and the accessibility label:
 * the reader wants the words, not the asterisks. Code fences keep their contents.
 */
export function plainText(md: string): string {
  return md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
}
