import type { WireDiff } from "../bridge/protocol";
import type { ApprovalItem, ChatItem, EventItem, ResultItem } from "../data/types";

let seq = 0;
/** Monotonic id generator (deterministic; avoids Math.random for testability). */
export function genId(prefix = "x"): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Append a user prompt as a chat bubble. Pure: returns a new array. */
export function appendPrompt(items: ChatItem[], text: string, id: string = genId("u")): ChatItem[] {
  const trimmed = text.trim();
  if (!trimmed) return items;
  return [...items, { kind: "bubble", id, role: "user", text: trimmed }];
}

/** Append an assistant reply bubble. */
export function appendAssistantReply(items: ChatItem[], text: string, id: string = genId("a")): ChatItem[] {
  return [...items, { kind: "bubble", id, role: "assistant", text }];
}

/** Resolve an approval item (immutably) to allow/deny. */
export function resolveApproval(
  items: ChatItem[],
  approvalId: string,
  decision: "allow" | "deny",
): ChatItem[] {
  return items.map((it) =>
    it.kind === "approval" && it.id === approvalId ? { ...it, resolved: decision } : it,
  );
}

/** The first unresolved approval in a feed, if any. */
export function pendingApproval(items: ChatItem[]): ApprovalItem | null {
  return (
    items.find((it): it is ApprovalItem => it.kind === "approval" && !it.resolved) ?? null
  );
}

/** Most items a chat keeps in memory. A long-running session's transcript can hold tens of
 * thousands of lines; the phone keeps the newest and says where the rest are. */
export const FEED_CAP = 2000;
export const FEED_CAP_ID = "feed-cap";

/**
 * The newest `max` items of a feed (the "earlier messages" divider counts as one of them),
 * led by that divider whenever anything was dropped. Returns the same array when under the
 * cap, so a feed that did not overflow keeps its identity.
 */
export function capFeed(feed: ChatItem[], max: number = FEED_CAP): ChatItem[] {
  if (feed.length <= max) return feed;
  const rest = feed[0]?.id === FEED_CAP_ID ? feed.slice(1) : feed;
  return [
    { kind: "divider", id: FEED_CAP_ID, label: "Earlier messages are on your computer", tone: "info" },
    ...rest.slice(rest.length - (max - 1)),
  ];
}

export type CallStatus = "running" | "ok" | "error" | "unknown";

/** A tool call with its outcome folded in. */
export type Call = {
  event: EventItem;
  status: CallStatus;
  errorText: string | null;
  diff: WireDiff | null;
};

export type FeedRow =
  | { type: "item"; item: Exclude<ChatItem, EventItem | ResultItem> }
  | { type: "call"; call: Call }
  | { type: "tools"; id: string; calls: Call[] };

/** Quiet = has a result, not an error, no diff. Only quiet calls fold. */
const isQuiet = (c: Call) => c.status === "ok" && c.diff === null;

/**
 * Pair each event with its result by `toolUseId` across the whole feed, drop `result`
 * items, and fold runs of >= 2 quiet calls. Same rule as the desktop (`groupTools`).
 * A call with no result is `running` only when nothing but events/`usage`/`result` follows it;
 * otherwise the turn moved on without a result and its status is `unknown` (never folds).
 */
export function groupFeed(items: ChatItem[]): FeedRow[] {
  const results = new Map<string, ResultItem>();
  for (const it of items) if (it.kind === "result") results.set(it.toolUseId, it);
  // `tailOpen[i]`: everything after item i is an event or result (turn has not moved on).
  const tailOpen: boolean[] = new Array(items.length);
  let open = true;
  for (let i = items.length - 1; i >= 0; i--) {
    tailOpen[i] = open;
    if (items[i].kind !== "event" && items[i].kind !== "result") open = false;
  }

  const rows: FeedRow[] = [];
  let run: Call[] = [];
  const flush = () => {
    if (run.length >= 2) rows.push({ type: "tools", id: `tools-${run[0].event.id}`, calls: run });
    else for (const call of run) rows.push({ type: "call", call });
    run = [];
  };
  items.forEach((item, i) => {
    if (item.kind === "result") return;
    if (item.kind === "event") {
      const r = item.toolUseId ? results.get(item.toolUseId) : undefined;
      const call: Call = r
        ? { event: item, status: r.isError ? "error" : "ok", errorText: r.errorText, diff: r.diff }
        : { event: item, status: tailOpen[i] ? "running" : "unknown", errorText: null, diff: null };
      if (isQuiet(call)) {
        run.push(call);
      } else {
        flush();
        rows.push({ type: "call", call });
      }
      return;
    }
    flush();
    rows.push({ type: "item", item });
  });
  flush();
  return rows;
}

/** The tool a call kind names, for a line that no longer has a verb of its own. */
const CALL_NOUN: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  search: "Search",
  web: "Web",
  subagent: "Agent",
};

/** A refusal, whoever refused: Conduit's own deny (`broker::DENY_MESSAGE`), a terminal "No",
 *  or a permission rule. */
const DENIED = /\b(denied|rejected)\b|doesn't want to proceed/i;

/** The verb a call line shows. The transcript fixes it when the tool is CALLED ("ran"), so a
 *  call whose result is an error would still read "ran touch a.txt" beside its ✕ -- which
 *  contradicts an honest "Denied". Once the result is an error the line says what happened.
 *  Keep identical to `callVerb` in src/chatItems.ts (desktop). */
export function callVerb(call: Call, verb: string): string {
  if (call.status !== "error") return verb;
  const noun = CALL_NOUN[call.event.event] ?? "tool";
  return `${call.errorText && DENIED.test(call.errorText) ? "Denied" : "Failed"}: ${noun}`;
}

/** One-line digest of a folded run: buckets in descending count (stable on first seen). Matches desktop `groupLabel`. */
export function groupLabel(calls: Call[]): string {
  const buckets: [string, string][] = [];
  const counts = new Map<string, number>();
  const spec = (k: string): [string, string] =>
    k === "bash"
      ? ["bash", "ran %d shell command"]
      : k === "read"
        ? ["read", "read %d file"]
        : k === "search"
          ? ["search", "searched %d time"]
          : k === "web"
            ? ["web", "browsed %d page"]
            : k === "subagent"
              ? ["subagent", "ran %d subagent"]
              : ["other", "called %d tool"];
  for (const c of calls) {
    const sp = spec(c.event.event);
    if (!counts.has(sp[0])) buckets.push(sp);
    counts.set(sp[0], (counts.get(sp[0]) ?? 0) + 1);
  }
  const text = buckets
    .map((b, i) => ({ b, i, n: counts.get(b[0])! }))
    .sort((x, y) => y.n - x.n || x.i - y.i)
    .map(({ b, n }) => b[1].replace("%d", String(n)) + (n === 1 ? "" : "s"))
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
