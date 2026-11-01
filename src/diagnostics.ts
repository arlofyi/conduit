// Pure helpers for local error reporting. Standalone (no store, no Tauri import) so the
// node-env vitest can load it. The Rust side (`diag.rs`) owns redaction, the size caps
// and the rate limit; these helpers only shape a report and keep a render loop from
// sending the same error hundreds of times a second.

export type ErrorKind = "render" | "error" | "rejection";

export interface FrontendErrorReport {
  kind: ErrorKind;
  message: string;
  stack?: string;
  /** Which boundary or handler caught it, e.g. `settings:mobile` or `window`. */
  source: string;
}

const MESSAGE_CAP = 2000;
const STACK_CAP = 6000;

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Normalize anything thrown (Error, string, object, undefined) into a report. */
export function toReport(
  kind: ErrorKind,
  thrown: unknown,
  source: string,
  componentStack?: string | null,
): FrontendErrorReport {
  let message: string;
  let stack: string | undefined;
  if (thrown instanceof Error) {
    message = `${thrown.name}: ${thrown.message}`;
    stack = thrown.stack;
  } else if (typeof thrown === "string") {
    message = thrown;
  } else {
    try {
      message = JSON.stringify(thrown) ?? String(thrown);
    } catch {
      message = String(thrown);
    }
  }
  const parts = [stack, componentStack ? `component stack:${componentStack}` : undefined]
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join("\n");
  return {
    kind,
    message: cap(message || "(no message)", MESSAGE_CAP),
    stack: parts ? cap(parts, STACK_CAP) : undefined,
    source,
  };
}

/**
 * Drops a report identical (kind + source + message) to one sent within `windowMs`.
 * A component that throws on every render would otherwise flood the IPC; the Rust rate
 * limit still applies behind this.
 */
export function createDedupe(windowMs = 5000, maxKeys = 100) {
  const seen = new Map<string, number>();
  return (r: FrontendErrorReport, now: number): boolean => {
    const key = `${r.kind}|${r.source}|${r.message}`;
    const last = seen.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    seen.set(key, now);
    if (seen.size > maxKeys) {
      for (const [k, t] of seen) {
        if (now - t >= windowMs) seen.delete(k);
      }
      // Still full of fresh keys: drop the oldest.
      while (seen.size > maxKeys) {
        const first = seen.keys().next().value;
        if (first === undefined) break;
        seen.delete(first);
      }
    }
    return true;
  };
}

/** Plain-text details for the fallback's "Copy details" button. */
export function detailsText(r: FrontendErrorReport, version?: string): string {
  return [
    `Conduit${version ? ` ${version}` : ""} — ${r.kind} in ${r.source}`,
    r.message,
    r.stack ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** "1h 02m", "4m 05s", "12s". */
export function formatUptime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** Human labels for the counters `diagnostics` returns, in display order. */
export const COUNTER_LABELS: Record<string, string> = {
  sessions_spawned: "Sessions started",
  spawn_failures: "Start failures",
  phone_connections: "Phone connections",
  phone_auth_failures: "Phone auth failures",
  tunnels_opened: "Mirrored ports opened",
  errors: "Errors",
  warnings: "Warnings",
  panics: "Crashes (panics)",
  frontend_errors: "UI errors",
  frontend_dropped: "UI errors not logged (rate limit)",
};
