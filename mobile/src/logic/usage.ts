/**
 * The phone's usage meters: the `usage` frame (desktop `usageRows.ts` rows, from cached reads)
 * as the compact 5 h + week gauges in Settings and the chat header.
 *
 * Same semantics as the desktop ("Where the usage meter's semantics live"): `used` is the
 * fraction CONSUMED, the label reads "18% used" (the desktop's default metric), and severity
 * is always consumption -- a meter nearly spent is red. A row with no readable window is
 * UNKNOWN, never a healthy 0%.
 */

export interface UsageWindow {
  kind: string;
  label: string;
  /** fraction consumed, clamped to 0..1 */
  used: number;
  /** unix ms; null when the agent gave none */
  resetsAt: number | null;
}

export interface UsageMoney {
  spent: number;
  limit: number | null;
  remaining: number | null;
}

export interface UsageRow {
  key: string;
  agent: string;
  label: string;
  plan: string | null;
  windows: UsageWindow[];
  money: UsageMoney | null;
  models: string[];
  /** unix ms of the desktop's last good read */
  updatedAt: number | null;
  source: string | null;
}

export type Severity = "ok" | "warn" | "bad";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** A time as unix ms: a number below 1e12 is taken as seconds, a string is parsed as ISO. */
export function toMs(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n <= 0 ? null : n < 1e12 ? n * 1000 : n;
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function windowOf(v: unknown): UsageWindow | null {
  const w = v as Record<string, unknown> | null;
  if (!w || typeof w !== "object") return null;
  const used = num(w.used);
  if (used === null) return null;
  const kind = str(w.kind) ?? "";
  return { kind, label: str(w.label) ?? kindLabel(kind), used: clamp01(used), resetsAt: toMs(w.resetsAt) };
}

function moneyOf(v: unknown): UsageMoney | null {
  const m = v as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return null;
  const spent = num(m.spent);
  if (spent === null) return null;
  return { spent, limit: num(m.limit), remaining: num(m.remaining) };
}

function modelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((m) => {
    if (typeof m === "string") return m ? [m] : [];
    const o = m as { id?: unknown; label?: unknown } | null;
    const name = str(o?.label) ?? str(o?.id);
    return name ? [name] : [];
  });
}

/** One row, or null when it has no key (it could never be matched or keyed in a list). */
export function usageRowOf(v: unknown): UsageRow | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const key = str(r.key);
  if (!key) return null;
  const agent = str(r.agent) ?? "";
  return {
    key,
    agent,
    label: str(r.label) ?? (agent || key),
    plan: str(r.plan),
    windows: Array.isArray(r.windows) ? r.windows.map(windowOf).filter((w): w is UsageWindow => w !== null) : [],
    money: moneyOf(r.money),
    models: modelsOf(r.models),
    updatedAt: toMs(r.updatedAt),
    source: str(r.source),
  };
}

/** The `usage` frame's rows; null when it is not a usage answer at all. */
export function parseUsageFrame(m: unknown): UsageRow[] | null {
  const f = m as { type?: unknown; agents?: unknown } | null;
  if (!f || f.type !== "usage") return null;
  return Array.isArray(f.agents) ? f.agents.map(usageRowOf).filter((r): r is UsageRow => r !== null) : [];
}

const KIND_LABEL: Record<string, string> = {
  fiveHour: "5-hour",
  weekly: "Weekly",
  weeklyOpus: "Weekly · Opus",
  context: "Context",
  credit: "Credit",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

const isWeek = (w: UsageWindow) => w.kind === "weekly" || w.kind === "weeklyOpus" || (!KIND_LABEL[w.kind] && /week/i.test(w.label));
const isFive = (w: UsageWindow) => w.kind === "fiveHour" || (!KIND_LABEL[w.kind] && /5[\s-]?h/i.test(w.label));

/** The worst (most consumed) of several windows: agy has one per pool, and the gauge shows danger. */
function worst(ws: UsageWindow[]): UsageWindow | null {
  return ws.reduce<UsageWindow | null>((a, w) => (a === null || w.used > a.used ? w : a), null);
}

/** The two windows the compact gauges draw. Prefers plain `weekly` over `weeklyOpus` for "week"
 * unless the Opus one is the more spent of the two. */
export function pickWindows(row: UsageRow | null): { fiveHour: UsageWindow | null; week: UsageWindow | null } {
  if (!row) return { fiveHour: null, week: null };
  return { fiveHour: worst(row.windows.filter(isFive)), week: worst(row.windows.filter(isWeek)) };
}

/** Consumption, never the direction the user reads: 90 % used is red, 70 % amber. */
export function severity(used: number): Severity {
  if (used >= 0.9) return "bad";
  if (used >= 0.7) return "warn";
  return "ok";
}

export function pct(used: number): number {
  return Math.round(clamp01(used) * 100);
}

/** "18% used" */
export function usedLabel(w: UsageWindow): string {
  return `${pct(w.used)}% used`;
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "$12.40 spent" (uncapped: no bar) or "$12.40 of $50.00". */
export function moneyLabel(m: UsageMoney): string {
  return m.limit === null ? `${money(m.spent)} spent` : `${money(m.spent)} of ${money(m.limit)}`;
}

/** The bar a money meter draws: none when uncapped (the provider gave no denominator). */
export function moneyFraction(m: UsageMoney): number | null {
  if (m.limit === null || m.limit <= 0) return null;
  return clamp01(m.spent / m.limit);
}

function span(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** "resets in 2h 10m"; null when the agent gave no reset time. */
export function resetCopy(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const ms = resetsAt - now;
  if (ms <= 30_000) return "resets now";
  return `resets in ${span(ms)}`;
}

/** "updated 12s ago" / "updated 4m ago"; null when unknown. */
export function updatedAgo(updatedAt: number | null, now: number): string | null {
  if (updatedAt === null) return null;
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 60) return `updated ${s}s ago`;
  if (s < 3600) return `updated ${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `updated ${Math.floor(s / 3600)}h ago`;
  return `updated ${Math.floor(s / 86_400)}d ago`;
}

/** A stale read is still shown, but said: the desktop serves a last good read up to an hour. */
export function sourceNote(source: string | null): string | null {
  if (source === "stale") return "last good read";
  if (source === "unavailable") return "not available";
  return null;
}

/** The row a session draws from: its `usageKey` exactly, else (older desktop) the first row of
 * the same agent -- an agent with one account is the common case. */
export function rowForSession(rows: readonly UsageRow[] | null, usageKey: string | null | undefined, agent: string): UsageRow | null {
  if (!rows || rows.length === 0) return null;
  if (usageKey) {
    const exact = rows.find((r) => r.key === usageKey);
    if (exact) return exact;
  }
  return rows.find((r) => r.agent === agent) ?? null;
}

/** The header's mini gauge: the 5-hour window, else the week, else nothing. */
export function headerGauge(row: UsageRow | null): { window: UsageWindow; a11y: string } | null {
  const { fiveHour, week } = pickWindows(row);
  const w = fiveHour ?? week;
  if (!w) return null;
  const parts = [`${w.label} ${usedLabel(w)}`];
  if (fiveHour && week) parts.push(`${week.label} ${usedLabel(week)}`);
  return { window: w, a11y: `Usage: ${parts.join(", ")}` };
}
