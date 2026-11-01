/**
 * Local diagnostics: the pure half (formatting, redaction, rotation, counters). The file
 * backend is data/diagnostics.ts. NOTHING here or there leaves the phone -- no service, no
 * upload, no report to the computer; the only way out is the reader tapping "Share log".
 *
 * What a line may carry: an event KIND ("conn.failed", "bgwatch.startRefused") and an error's
 * message. Never a token, a pairing secret, a chat message, a prompt or a file's contents --
 * callers do not pass them, and `redact` is the second line of defence for whatever an error
 * message happens to quote. The same rules are ported to Kotlin
 * (modules/bg-watch/.../NativeLogRules.kt); change both together.
 */

export type DiagLevel = "info" | "warn" | "error";

export interface DiagEntry {
  /** epoch ms */
  at: number;
  level: DiagLevel;
  /** where it came from: "js", "bridge", "bgwatch", "mirror", "files", "ui" ... */
  source: string;
  /** a short event kind, e.g. "conn.failed" */
  event: string;
  /** an error message or a few safe facts, redacted before it is written */
  detail?: string;
}

/** One line's detail is capped: an error message is a sentence, not a payload. */
export const MAX_DETAIL = 500;
/** The app log rotates at this size... */
export const LOG_MAX_BYTES = 1024 * 1024;
/** ...keeping this many files (app.log, app.1.log, app.2.log). */
export const LOG_KEEP = 3;
/** How many recent errors the counters file keeps for Settings → Diagnostics. */
export const RECENT_ERRORS = 20;

const REDACTED = "<redacted>";

/**
 * Scrub anything secret-shaped out of `text`. Order matters: structured keys first (so the
 * value goes, whatever its shape), then URLs, then bare long runs.
 */
export function redact(text: string): string {
  let s = text;
  // "token":"...", 'secret': '...', and the like (JSON or JS-ish)
  s = s.replace(
    /(["']?)([A-Za-z_]*(?:token|secret|password|passwd|nonce|apikey|api_key|authorization|cookie)[A-Za-z_]*)\1(\s*[:=]\s*)(["'])(?:\\.|(?!\4).)*\4/gi,
    (_m, q: string, k: string, sep: string, vq: string) => `${q}${k}${q}${sep}${vq}${REDACTED}${vq}`,
  );
  // token=abc, secret: abc (query strings, header-ish text)
  s = s.replace(
    /\b([A-Za-z_]*(?:token|secret|password|passwd|nonce|apikey|api_key)[A-Za-z_]*)(\s*[=:]\s*)(?!<redacted>)([^\s&"',;)}\]]+)/gi,
    (_m, k: string, sep: string) => `${k}${sep}${REDACTED}`,
  );
  s = s.replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, (_m, k: string) => `${k} ${REDACTED}`);
  // A user's own files: the name and folder are theirs, not the log's.
  s = s.replace(/\b(?:file|content|ph|assets-library):\/\/[^\s"',;)]+/gi, "<uri>");
  // ws://user:pass@host:port/path?q -> ws://host:port (an address may be named, never its
  // credentials, path or query)
  s = s.replace(/\b(wss?|https?):\/\/(?:[^\s/@"']*@)?([^\s/?#"',;)]+)[^\s"',;)]*/gi, (_m, sc: string, host: string) => `${sc}://${host}`);
  // Absolute file paths (two folders deep or more): which files a person works on is theirs.
  s = s.replace(/(?<![\w:/])(?:[A-Za-z]:[\\/]|\/)(?:[^\s/\\:"'<>]+[\\/]){2,}[^\s"',;:)<>]*/g, "<path>");
  // Long opaque runs: base64/hex/url-safe tokens, device tokens, pairing secrets.
  s = s.replace(/[A-Za-z0-9_\-+/]{32,}={0,2}/g, REDACTED);
  return s;
}

/** One line of text: newlines folded, redacted, capped. */
export function cleanDetail(text: string, max = MAX_DETAIL): string {
  const one = redact(text).replace(/\s*[\r\n]+\s*/g, " | ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * What an unknown thrown value says, safely: its name and message, plus (when asked) the top
 * stack frames, which carry function names and bundle offsets but no user data.
 */
export function errorDetail(e: unknown, frames = 0): string {
  let head: string;
  let stack = "";
  if (e instanceof Error) {
    head = e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message || e.name;
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code) head = `[${code}] ${head}`;
    if (frames > 0 && typeof e.stack === "string") {
      stack = e.stack
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("at ") || /^\S+@/.test(l))
        .slice(0, frames)
        .join(" < ");
    }
  } else if (typeof e === "string") {
    head = e;
  } else if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    head = (e as { message: string }).message;
  } else {
    head = String(e);
  }
  return cleanDetail(stack ? `${head} @ ${stack}` : head);
}

/** `2026-11-01T09:30:00.000Z ERROR bridge conn.failed: detail` -- one line, newline-terminated. */
export function formatLine(entry: DiagEntry): string {
  const ts = new Date(entry.at).toISOString();
  const lvl = entry.level.toUpperCase().padEnd(5);
  const src = entry.source.replace(/\s+/g, "_");
  const ev = entry.event.replace(/\s+/g, "_");
  const detail = entry.detail ? `: ${cleanDetail(entry.detail)}` : "";
  return `${ts} ${lvl} ${src} ${ev}${detail}\n`;
}

/** UTF-8 byte length (no TextEncoder dependency: Hermes has one, jest's node env too, but
 * this is called per line and is trivial). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** File names, newest first: `app.log`, `app.1.log`, `app.2.log`. */
export function rotatedNames(base = "app", keep = LOG_KEEP): string[] {
  const out = [`${base}.log`];
  for (let i = 1; i < keep; i++) out.push(`${base}.${i}.log`);
  return out;
}

/** Whether appending `addBytes` to a file of `size` must rotate first. An empty file never
 * rotates (a single oversized line still gets written). */
export function shouldRotate(size: number, addBytes: number, max = LOG_MAX_BYTES): boolean {
  return size > 0 && size + addBytes > max;
}

/**
 * The renames a rotation performs, oldest first so nothing is overwritten before it moves:
 * the oldest file is deleted, every other shifts down one, and the live file starts empty.
 */
export function rotationPlan(base = "app", keep = LOG_KEEP): { remove: string; moves: [string, string][] } {
  const names = rotatedNames(base, keep);
  const moves: [string, string][] = [];
  for (let i = names.length - 1; i > 0; i--) moves.push([names[i - 1], names[i]]);
  return { remove: names[names.length - 1], moves };
}

// ---- counters ----

export interface CounterSet {
  appStarts: number;
  connects: number;
  reconnects: number;
  connectionFailures: number;
  messagesSent: number;
  /** in-app banners shown by the JS side (system notifications are the native watcher's) */
  notificationsPosted: number;
  errorsLogged: number;
}

export type CounterKey = keyof CounterSet;

export interface RecentError {
  at: number;
  source: string;
  event: string;
  detail: string;
}

export interface Counters {
  version: 1;
  lifetime: CounterSet;
  /** this app run (reset at every start) */
  run: CounterSet;
  /** the run before this one -- what led up to a crash, if it ended in one */
  previousRun: CounterSet | null;
  runStartedAt: number;
  lastErrorAt: number | null;
  /** newest first */
  recentErrors: RecentError[];
}

export const COUNTER_KEYS: CounterKey[] = [
  "appStarts",
  "connects",
  "reconnects",
  "connectionFailures",
  "messagesSent",
  "notificationsPosted",
  "errorsLogged",
];

export function emptySet(): CounterSet {
  return { appStarts: 0, connects: 0, reconnects: 0, connectionFailures: 0, messagesSent: 0, notificationsPosted: 0, errorsLogged: 0 };
}

export function emptyCounters(now = 0): Counters {
  return { version: 1, lifetime: emptySet(), run: emptySet(), previousRun: null, runStartedAt: now, lastErrorAt: null, recentErrors: [] };
}

function setOf(v: unknown): CounterSet | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out = emptySet();
  for (const k of COUNTER_KEYS) {
    const n = o[k];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
  }
  return out;
}

/** Read the counters file defensively: anything unreadable is a fresh start, never a throw. */
export function parseCounters(text: string | null, now = 0): Counters {
  if (!text) return emptyCounters(now);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyCounters(now);
  }
  if (!raw || typeof raw !== "object") return emptyCounters(now);
  const o = raw as Record<string, unknown>;
  const recent = Array.isArray(o.recentErrors)
    ? o.recentErrors
        .filter(
          (r): r is RecentError =>
            !!r && typeof r === "object" && typeof (r as RecentError).at === "number" && typeof (r as RecentError).event === "string",
        )
        .map((r) => ({ at: r.at, source: String(r.source ?? ""), event: r.event, detail: String(r.detail ?? "") }))
        .slice(0, RECENT_ERRORS)
    : [];
  return {
    version: 1,
    lifetime: setOf(o.lifetime) ?? emptySet(),
    run: setOf(o.run) ?? emptySet(),
    previousRun: setOf(o.previousRun),
    runStartedAt: typeof o.runStartedAt === "number" ? o.runStartedAt : now,
    lastErrorAt: typeof o.lastErrorAt === "number" ? o.lastErrorAt : null,
    recentErrors: recent,
  };
}

/** A new app run: the old run becomes `previousRun`, the new one starts at one app start. */
export function startRun(c: Counters, now: number): Counters {
  const run = { ...emptySet(), appStarts: 1 };
  return {
    ...c,
    previousRun: c.runStartedAt ? c.run : null,
    run,
    runStartedAt: now,
    lifetime: { ...c.lifetime, appStarts: c.lifetime.appStarts + 1 },
  };
}

export function bump(c: Counters, key: CounterKey, n = 1): Counters {
  return { ...c, run: { ...c.run, [key]: c.run[key] + n }, lifetime: { ...c.lifetime, [key]: c.lifetime[key] + n } };
}

/** An error-level entry: counted, timestamped, and kept (redacted) in the recent list. */
export function recordError(c: Counters, e: DiagEntry): Counters {
  const next = bump(c, "errorsLogged");
  const item: RecentError = { at: e.at, source: e.source, event: e.event, detail: e.detail ? cleanDetail(e.detail, 200) : "" };
  return { ...next, lastErrorAt: e.at, recentErrors: [item, ...c.recentErrors].slice(0, RECENT_ERRORS) };
}

/** The header of a shared log: counters as plain text, no addresses or names. */
export function countersReport(c: Counters, now: number): string {
  const row = (k: CounterKey) => `  ${k.padEnd(20)} run ${String(c.run[k]).padStart(5)}   lifetime ${String(c.lifetime[k]).padStart(7)}`;
  const lines = [
    `Conduit diagnostics -- generated ${new Date(now).toISOString()}`,
    `run started ${c.runStartedAt ? new Date(c.runStartedAt).toISOString() : "?"}`,
    `last error ${c.lastErrorAt ? new Date(c.lastErrorAt).toISOString() : "never"}`,
    ...COUNTER_KEYS.map(row),
  ];
  if (c.previousRun) lines.push(`previous run: ${COUNTER_KEYS.map((k) => `${k}=${c.previousRun![k]}`).join(" ")}`);
  return `${lines.join("\n")}\n`;
}
