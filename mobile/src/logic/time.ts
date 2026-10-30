/**
 * Message times as a messenger shows them, in the phone's local time zone. Transcript lines
 * carry an ISO `at` (Task 8a); the list carries unix ms. Pure: `now` is always passed in.
 */

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO string or unix ms → ms; null when absent or unparseable. */
export function toMs(at: string | number | null | undefined): number | null {
  if (at === null || at === undefined || at === "") return null;
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** "7:01 PM" (local). Empty when unknown. */
export function formatTime(at: string | number | null | undefined): string {
  const ms = toMs(at);
  if (ms === null) return "";
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Local calendar day, as a sortable key ("2026-10-30"). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Whole local days between two instants (calendar days, not 24 h spans; DST-safe). */
function daysApart(then: number, now: number): number {
  const a = new Date(then);
  const b = new Date(now);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / DAY);
}

function shortDate(ms: number, now: number): string {
  const d = new Date(ms);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** The pill between days in a chat: "Today" · "Yesterday" · "Monday" (this week) · "Oct 12" · "Oct 12, 2025". */
export function dateSeparator(at: string | number, now: number): string {
  const ms = toMs(at);
  if (ms === null) return "";
  const n = daysApart(ms, now);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n < 7) return WEEKDAYS[new Date(ms).getDay()];
  return shortDate(ms, now);
}

/** The Chats row's time: "7:01 PM" today, then "Yesterday", a weekday, a short date. */
export function listTime(at: string | number | null | undefined, now: number): string {
  const ms = toMs(at);
  if (ms === null) return "";
  const n = daysApart(ms, now);
  if (n <= 0) return formatTime(ms);
  if (n === 1) return "Yesterday";
  if (n < 7) return WEEKDAYS[new Date(ms).getDay()];
  return shortDate(ms, now);
}
