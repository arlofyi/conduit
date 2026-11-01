/**
 * "While you were away": after the phone has been out of touch for a while (Tailscale off, the
 * app closed, no signal), the first fresh projects list is compared with the last one the phone
 * had, and the difference is said once: "Since 2:05 PM: 2 finished, 1 needs you".
 */
import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import { isNeeds } from "./chatList";
import { savedAtText } from "./offlineCache";

/** A gap shorter than this is a blip, not an absence: nothing is summarized. */
export const AWAY_MIN_MS = 3 * 60 * 1000;

export interface AwaySummary {
  /** when the phone last heard from the computer */
  since: number;
  /** turns that ended while away */
  finished: number;
  /** sessions that newly need you */
  needs: number;
  /** sessions that appeared while away */
  started: number;
  /** still working now (not news by itself, said only alongside something else) */
  working: number;
  /** a session that newly needs you, for a tap to open (the first by project order) */
  firstNeedsId: string | null;
}

function byId(view: WireProjectsView): Map<string, WireViewSession> {
  const m = new Map<string, WireViewSession>();
  for (const p of view.projects) for (const s of p.sessions) if (!s.silo) m.set(s.id, s);
  return m;
}

const ended = (s: WireViewSession) => !isNeeds(s) && s.status !== "running";

/**
 * What changed between `before` (the last list the phone had) and `after` (the first fresh one).
 * null when the gap was short, there is nothing to compare with, or nothing worth saying changed.
 * Private sessions are never counted.
 */
export function awaySummary(before: WireProjectsView | null, since: number | null, after: WireProjectsView, now: number): AwaySummary | null {
  if (!before || since === null || now - since < AWAY_MIN_MS) return null;
  const old = byId(before);
  let finished = 0;
  let needs = 0;
  let started = 0;
  let working = 0;
  let firstNeedsId: string | null = null;
  for (const s of byId(after).values()) {
    if (s.status === "running" && !isNeeds(s)) working++;
    const o = old.get(s.id);
    if (!o) {
      started++;
      if (isNeeds(s)) {
        needs++;
        firstNeedsId ??= s.id;
      }
      continue;
    }
    if (isNeeds(s) && !isNeeds(o)) {
      needs++;
      firstNeedsId ??= s.id;
    } else if (ended(s) && (o.status === "running" || (s.status === "done" && o.status !== "done") || ((s.updatedAt ?? 0) > since && s.status === "done"))) {
      finished++;
    }
  }
  if (finished === 0 && needs === 0 && started === 0) return null;
  return { since, finished, needs, started, working, firstNeedsId };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Since 2:05 PM: 2 finished, 1 needs you, 1 new session · 3 still working". */
export function awayText(s: AwaySummary, now: number): string {
  const parts: string[] = [];
  if (s.finished > 0) parts.push(`${s.finished} finished`);
  if (s.needs > 0) parts.push(`${s.needs} need${s.needs === 1 ? "s" : ""} you`);
  if (s.started > 0) parts.push(plural(s.started, "new session", "new sessions"));
  const tail = s.working > 0 ? ` · ${s.working} still working` : "";
  return `Since ${savedAtText(s.since, now)}: ${parts.join(", ")}${tail}`;
}
