/** Continuity view service tables: row shapes (mirror continuity_tables.rs, serde
 *  camelCase), id → graph-node mapping, and formatting. Store-free for vitest. */
import type { FeedDecision } from "./continuityFeed";
import type { GraphSnapshot } from "./continuityGraph";

export type TableTab = "graph" | "decisions" | "handoffs" | "tasks" | "files" | "activity";
export type ServiceTab = Exclude<TableTab, "graph">;

export type HandoffRow = {
  id: string; from: string; to?: string; status: string; context: string; nextActions?: string; createdAt: string;
};
export type TaskRow = {
  id: string; repo: string; issue: number; status: string; claimant?: string; pr?: number;
  expiresAt: string; lastActivityAt: string;
};
export type FileRow = { path: string; collision: boolean; sessions: string[]; tools: string[]; touchedAt: string };
export type ActivityRow = { id: string; type: string; session?: string; createdAt: string; payload?: string };

export type TableRows = {
  decisions: FeedDecision[];
  handoffs: HandoffRow[];
  tasks: TaskRow[];
  files: FileRow[];
  activity: ActivityRow[];
};
export type TablesView<T extends ServiceTab = ServiceTab> = { available: boolean; tab: T; rows: TableRows[T] };

/** Compact age: "just now" under a minute, then floored m / h / d. Clock skew (a row from
 *  a machine slightly ahead) reads as "just now", never a negative age. */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Table rows carry CONTINUITY session ids; nodes are keyed by Conduit session id where one
 *  exists. Null when the id is not on the graph — a row never invents a node. */
export function nodeKeyForContinuityId(id: string, snap: GraphSnapshot): string | null {
  if (!id) return null;
  return snap.nodes.find((n) => n.continuityId === id)?.key ?? null;
}

/** Decisions arrive with the author's `agent_label` rather than its id. For a Conduit
 *  session that label IS the Conduit session id; for a checkout row it is the raw label. */
export function nodeKeyForAuthorLabel(label: string | null | undefined, snap: GraphSnapshot): string | null {
  if (!label) return null;
  return (
    snap.nodes.find((n) => n.conduitSessionId === label)?.key ??
    snap.nodes.find((n) => n.label === label)?.key ??
    null
  );
}

/** `id`, then what it superseded, and so on — newest to oldest. Stops at a link outside the
 *  loaded page and on a cycle (continuity does not forbid one). */
export function supersedeChain(decisions: FeedDecision[], id: string): string[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur.id);
    cur = cur.supersedes ? byId.get(cur.supersedes) : undefined;
  }
  return out;
}

/** Continuity's task_claims statuses are claimed / in_progress / pr_open / released /
 *  completed; expiry is not a status, it is `expires_at`. */
const TASK_DONE = new Set(["completed", "released"]);

/** A claim still holding its issue: not finished and not past its expiry. The ONE rule for
 *  both the tab count and the row's muting/"expired" display. */
export function isTaskOpen(t: TaskRow, nowMs: number): boolean {
  if (TASK_DONE.has(t.status)) return false;
  const at = Date.parse(t.expiresAt);
  return !Number.isNaN(at) && at > nowMs;
}

/** Finished by status (as opposed to merely lapsed). */
export function isTaskDone(t: TaskRow): boolean {
  return TASK_DONE.has(t.status);
}

/** The tab-strip number: what still wants attention, not the row total — active decisions,
 *  pending handoffs, open claims. Null for tabs whose count is not cheap or not meaningful. */
export function tabCount<T extends ServiceTab>(tab: T, rows: TableRows[T], nowMs: number): number | null {
  switch (tab) {
    case "decisions":
      return (rows as FeedDecision[]).filter((d) => d.status === "active").length;
    case "handoffs":
      return (rows as HandoffRow[]).filter((h) => h.status === "pending").length;
    case "tasks":
      return (rows as TaskRow[]).filter((t) => isTaskOpen(t, nowMs)).length;
    default:
      return null;
  }
}

/** A deadline (a claim's expiry): "in 4m" while it is ahead, "expired" once passed. */
export function relativeUntil(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  if (at <= nowMs) return "expired";
  const mins = Math.floor((at - nowMs) / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.floor(hours / 24)}d`;
}
