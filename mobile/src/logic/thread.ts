/**
 * How a conversation is laid out on the phone: a "Today"/"Yesterday"/date pill wherever the
 * local day changes, and consecutive messages from the same side GROUPED the way a messenger
 * groups them (tight spacing, a tail only on the first bubble of a run, the time on each).
 * Pure over `groupFeed`'s rows, so the rules are tested here and the screen only draws.
 */
import type { Call, FeedRow } from "./feed";

function sameCall(a: Call, b: Call): boolean {
  return a.event === b.event && a.status === b.status && a.errorText === b.errorText && a.diff === b.diff;
}

/**
 * Does `b` draw exactly what `a` drew? `groupFeed` rebuilds its row objects on every new item,
 * but the items inside them keep their identity, so comparing what a row is MADE of lets a
 * memoised row skip re-rendering when only the end of the conversation changed.
 */
export function sameFeedRow(a: FeedRow, b: FeedRow): boolean {
  if (a === b) return true;
  if (a.type === "item" && b.type === "item") return a.item === b.item;
  if (a.type === "call" && b.type === "call") return sameCall(a.call, b.call);
  if (a.type === "tools" && b.type === "tools") {
    return a.id === b.id && a.calls.length === b.calls.length && a.calls.every((c, i) => sameCall(c, b.calls[i]));
  }
  return false;
}
import { dateSeparator, dayKey, formatTime, toMs } from "./time";

export type ThreadRow =
  | { type: "date"; key: string; label: string }
  | {
      type: "row";
      key: string;
      row: FeedRow;
      /** for bubbles: first / last of a same-role run (first carries the tail) */
      first: boolean;
      last: boolean;
      /** "7:01 PM", or "" when the line had no time */
      time: string;
    };

export function rowKey(row: FeedRow): string {
  return row.type === "tools" ? row.id : row.type === "call" ? row.call.event.id : row.item.id;
}

/** The transcript time of a feed row (a folded run takes its first call's). */
export function rowAt(row: FeedRow): string | undefined {
  if (row.type === "tools") return row.calls[0]?.event.at;
  if (row.type === "call") return row.call.event.at;
  return row.item.at;
}

/** "user" | "assistant" for a bubble row, else null (anything else breaks a run). */
function bubbleRole(row: FeedRow): "user" | "assistant" | null {
  return row.type === "item" && row.item.kind === "bubble" ? row.item.role : null;
}

/** Chronological feed rows → thread rows with day pills and run flags. `now` picks "Today". */
export function layoutThread(rows: FeedRow[], now: number): ThreadRow[] {
  const out: ThreadRow[] = [];
  // Day of every row: an untimed row belongs to the day before it (the phone's own divider).
  const days: (string | null)[] = [];
  let day: string | null = null;
  for (const r of rows) {
    const ms = toMs(rowAt(r));
    if (ms !== null) day = dayKey(ms);
    days.push(day);
  }
  let shownDay: string | null = null;
  rows.forEach((r, i) => {
    const d = days[i];
    if (d !== null && d !== shownDay) {
      const at = rowAt(r)!;
      out.push({ type: "date", key: `date-${d}`, label: dateSeparator(at, now) });
      shownDay = d;
    }
    const role = bubbleRole(r);
    const prev = i > 0 ? rows[i - 1] : null;
    const next = i + 1 < rows.length ? rows[i + 1] : null;
    const first = role === null || !prev || bubbleRole(prev) !== role || days[i - 1] !== d;
    const last = role === null || !next || bubbleRole(next) !== role || days[i + 1] !== d;
    out.push({ type: "row", key: rowKey(r), row: r, first, last, time: formatTime(rowAt(r)) });
  });
  return out;
}
