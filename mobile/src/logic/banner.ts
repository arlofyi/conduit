/**
 * In-app banners (spec §9: in-app only). A banner drops from the top when a session NEWLY
 * enters "needs you", or (each behind its own switch) fails, is stopped, or finishes a turn --
 * never for the chat on screen, and never for a state the phone first saw already in place.
 *
 * Two sources feed the same per-session signal map: the polled `projects` view (every session)
 * and live `status` frames (only the session this socket streams). Because both write the same
 * map, a transition seen first on a status frame is not raised again by the next poll.
 *
 * "Finished" is SETTLED, not immediate. A session's status leaves `running` many times inside
 * one piece of work: an agy session reads `idle` at every permission menu and between steps
 * (its status line is its only activity signal), a Claude session's `Stop` fires again each
 * time a background task wakes it, and a compaction reads `idle` mid-turn. Announcing each of
 * those was a notification per chat bubble. So a running -> done/idle change only records
 * WHEN it happened (`finishAt`); the banner is raised once the session has stayed quiet for
 * FINISH_SETTLE_MS (`dueBanners`, called on a timer), and running or asking again in between
 * cancels it. The background watcher (watch.ts / WatchRules.kt) follows the same rule.
 */
import type { WireProjectsView, WireViewProject, WireViewSession } from "../bridge/protocol";
import type { Prefs } from "../data/prefs";
import type { SessionStatus } from "../data/types";
import { isNeeds } from "./chatList";
import { permissionLine, type PendingItem } from "./pending";

export type BannerKind = "question" | "permission" | "failed" | "stopped" | "finished";

export interface Signal {
  needs: "question" | "permission" | null;
  status: SessionStatus;
  /** the session's agent process is up (`running` in the view); absent from older baselines */
  running?: boolean;
  /** hibernated (`stopped` in the view); absent = unknown, which never reads as a stop */
  stopped?: boolean;
  /** the last turn ended on an error (Claude's StopFailure): its kind; null/absent = none */
  failed?: string | null;
  /** seen running and not stopped since the last stop: only a live session can BE stopped */
  live?: boolean;
  /** when it left `running` for a quiet state not yet announced as finished (ms) */
  finishAt?: number;
}

export type Signals = Record<string, Signal>;

export type NotifyPrefs = Pick<Prefs, "notifyQuestion" | "notifyPermission" | "notifyFinished" | "notifyFailed" | "notifyStopped">;

export interface Banner {
  /** unique per raise, so the same session raising twice restarts the banner */
  id: string;
  sessionId: string;
  projectId: string;
  name: string;
  branch: string | null;
  /** "Project · title" */
  title: string;
  text: string;
  kind: BannerKind;
  /** private sessions are announced but cannot be opened from the phone */
  openable: boolean;
}

export const BANNER_MS = 5000;

/**
 * How long a session must stay out of `running` (and not need you) before its turn counts as
 * finished. Long enough to ride out the gaps inside one piece of work -- Claude's 3 s
 * done-holdoff, an agy permission menu answered by auto-approve, a compaction, a background
 * task waking the agent, the bridge's 0.7 s push gap -- and short enough that "finished"
 * still arrives while it is news. Kept identical to WatchRules.kt.
 */
export const FINISH_SETTLE_MS = 20_000;

/** How often the app re-checks for a settled finish (LiveProvider). */
export const SETTLE_TICK_MS = 2_000;

export const PRIVATE_NEEDS_TEXT = "Private session — open it on your computer";

export function signalOf(s: WireViewSession): Signal {
  const needs = s.needs?.kind === "ask" ? "question" : isNeeds(s) ? "permission" : null;
  return {
    needs,
    status: s.status,
    running: s.running,
    stopped: s.stopped,
    failed: s.failed ?? null,
    live: s.running && !s.stopped,
  };
}

/** Quiet: not running, not asking, not stopped, not failed -- what a settling finish requires. */
export const quiet = (s: Signal): boolean => !s.needs && s.status !== "running" && !s.stopped && !s.failed;

/** The banner kind for a change between two signals, or null when nothing new happened. */
export function transition(prev: Signal | undefined, next: Signal): BannerKind | null {
  if (!prev) return null; // first sight is not a transition
  if (next.needs && !prev.needs) return next.needs;
  if (next.failed && !prev.failed) return "failed";
  // `stopped === false` explicitly: an older baseline that never said is not a stop
  if (next.stopped && prev.stopped === false && prev.live) return "stopped";
  if (!next.needs && !next.failed && !next.stopped && prev.status === "running" && (next.status === "done" || next.status === "idle"))
    return "finished";
  return null;
}

/**
 * The signal to keep for a session given the view's (or a status frame's) new one: what the
 * previous signal remembered (live, a settling finish) carried forward. Kept identical to
 * WatchRules.kt `nextSignal`.
 */
export function nextSignal(prev: Signal | undefined, sig: Signal, now: number): Signal {
  const live = sig.running === true && !sig.stopped ? true : sig.stopped ? false : (prev?.live ?? false);
  let finishAt = prev?.finishAt;
  if (finishAt === undefined && transition(prev, sig) === "finished") finishAt = now;
  const out: Signal = { needs: sig.needs, status: sig.status, live };
  if (sig.running !== undefined) out.running = sig.running;
  if (sig.stopped !== undefined) out.stopped = sig.stopped;
  if (sig.failed !== undefined) out.failed = sig.failed;
  if (finishAt !== undefined && quiet(sig)) out.finishAt = finishAt;
  return out;
}

/** A settling finish that has now been quiet long enough. */
export const settled = (s: Signal | undefined, now: number): s is Signal =>
  !!s && s.finishAt !== undefined && quiet(s) && now - s.finishAt >= FINISH_SETTLE_MS;

/** The same signal with its settling finish dropped (announced, or cancelled). */
export function withoutFinish(s: Signal): Signal {
  if (s.finishAt === undefined) return s;
  const { finishAt: _done, ...rest } = s;
  return rest;
}

function allowed(kind: BannerKind, prefs: NotifyPrefs): boolean {
  switch (kind) {
    case "question":
      return prefs.notifyQuestion;
    case "permission":
      return prefs.notifyPermission;
    case "failed":
      return prefs.notifyFailed;
    case "stopped":
      return prefs.notifyStopped;
    case "finished":
      return prefs.notifyFinished;
  }
}

const FAILED_WORDS: Record<string, string> = {
  rate_limit: "rate limit",
  overloaded: "the API is overloaded",
  authentication_failed: "sign-in failed",
  oauth_org_not_allowed: "sign-in not allowed",
  account_on_hold: "account on hold",
  verification_required: "verification required",
  billing_error: "billing problem",
  invalid_request: "invalid request",
  model_not_found: "model not found",
  server_error: "API server error",
  max_output_tokens: "hit the output limit",
  cloud_credential_error: "cloud credentials",
};

/** "Stopped on an error: rate limit" -- a StopFailure kind in words. Kept identical to WatchRules.kt. */
export function failedText(kind: string | null | undefined): string {
  const k = (kind ?? "").trim();
  const words = FAILED_WORDS[k] ?? (k && k !== "unknown" && k !== "error" ? k.replace(/_/g, " ") : "");
  return words ? `Stopped on an error: ${words}` : "Stopped on an error";
}

let seq = 0;

function bannerFor(p: WireViewProject, s: WireViewSession, kind: BannerKind): Banner {
  let text: string;
  if (s.silo)
    text =
      kind === "finished"
        ? "Private session finished"
        : kind === "failed"
          ? "Private session failed"
          : kind === "stopped"
            ? "Private session stopped"
            : PRIVATE_NEEDS_TEXT;
  else if (kind === "question") text = s.needs?.kind === "ask" && s.needs.text ? `Asks: ${s.needs.text}` : "Asks you a question";
  else if (kind === "permission") text = "Needs your input";
  else if (kind === "failed") text = failedText(s.failed);
  else if (kind === "stopped") text = "Stopped";
  else text = "Finished";
  seq += 1;
  return {
    id: `${s.id}#${seq}`,
    sessionId: s.id,
    projectId: p.id,
    name: s.name,
    branch: s.branch,
    title: `${p.name} · ${s.name}`,
    text,
    kind,
    openable: !s.silo,
  };
}

const RANK: Record<BannerKind, number> = { question: 0, permission: 1, failed: 2, stopped: 3, finished: 4 };

/**
 * A new view: update every session's signal; raise banners for allowed transitions, most urgent
 * first. A finished turn only starts settling here; `dueBanners` raises it (also run at the end
 * of this, so a settled one rides the next frame as well as the timer).
 */
export function bannersFromView(
  signals: Signals,
  next: WireProjectsView,
  openId: string | null,
  prefs: NotifyPrefs,
  now: number = Date.now(),
): { signals: Signals; banners: Banner[] } {
  const out: Signals = {};
  const banners: Banner[] = [];
  for (const p of next.projects) {
    for (const s of p.sessions) {
      const sig = nextSignal(signals[s.id], signalOf(s), now);
      out[s.id] = sig;
      const kind = transition(signals[s.id], sig);
      if (kind && kind !== "finished" && s.id !== openId && allowed(kind, prefs)) banners.push(bannerFor(p, s, kind));
    }
  }
  const due = dueBanners(out, next, openId, prefs, now);
  banners.push(...due.banners);
  banners.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  return { signals: due.signals, banners };
}

/**
 * Finished turns that have now settled (quiet for FINISH_SETTLE_MS): their banners, once each.
 * Returns the same `signals` object when nothing settled, so a timer calling this costs nothing.
 */
export function dueBanners(
  signals: Signals,
  view: WireProjectsView | null,
  openId: string | null,
  prefs: NotifyPrefs,
  now: number,
): { signals: Signals; banners: Banner[] } {
  if (!view) return { signals, banners: [] };
  let out = signals;
  const banners: Banner[] = [];
  for (const p of view.projects) {
    for (const s of p.sessions) {
      const sig = out[s.id];
      if (!settled(sig, now)) continue;
      if (out === signals) out = { ...signals };
      out[s.id] = withoutFinish(sig);
      if (s.id !== openId && allowed("finished", prefs)) banners.push(bannerFor(p, s, "finished"));
    }
  }
  return { signals: out, banners };
}

/**
 * A live status for the streamed session. A hook says only "needs input", not which kind, so a
 * session not already known to be asking reads as a permission prompt; the session's project and
 * name come from the last view (none there → ignored). A finish only starts settling here.
 */
export function bannerFromStatus(
  signals: Signals,
  view: WireProjectsView | null,
  sessionId: string,
  status: SessionStatus,
  openId: string | null,
  prefs: NotifyPrefs,
  now: number = Date.now(),
): { signals: Signals; banner: Banner | null } {
  const prev = signals[sessionId];
  if (!prev || !view) return { signals, banner: null };
  const raw: Signal = { ...withoutFinish(prev), needs: status === "needsInput" ? (prev.needs ?? "permission") : null, status };
  const next = nextSignal(prev, raw, now);
  const updated = { ...signals, [sessionId]: next };
  const kind = transition(prev, next);
  if (!kind || kind === "finished" || sessionId === openId || !allowed(kind, prefs)) return { signals: updated, banner: null };
  for (const p of view.projects) {
    const s = p.sessions.find((x) => x.id === sessionId);
    if (s) return { signals: updated, banner: bannerFor(p, s, kind) };
  }
  return { signals: updated, banner: null };
}

/**
 * The Mac pushed a NEW question or permission (`pendingAdded`, within ~250 ms of the hook):
 * banner now rather than at the next 10 s poll. Same toggles, same open-chat and silo rules;
 * the signal is updated so the poll that later shows the session asking raises nothing more.
 * The caller calls it once per NEW item id, so each question or permission is announced once.
 */
export function bannerFromPending(
  signals: Signals,
  view: WireProjectsView | null,
  item: PendingItem,
  openId: string | null,
  prefs: NotifyPrefs,
): { signals: Signals; banner: Banner | null } {
  const prev = signals[item.sessionId];
  if (!prev || !view) return { signals, banner: null };
  const kind: "question" | "permission" = item.kind === "ask" ? "question" : "permission";
  // asking now: a settling finish is cancelled
  const updated = { ...signals, [item.sessionId]: { ...withoutFinish(prev), needs: prev.needs ?? kind, status: "needsInput" as const } };
  // Keyed by the ITEM, not the session's needs flag: `pendingAdded` fires once per new id, so a
  // second question in a session that already needed you (the first answered on your computer before
  // any poll cleared the flag) is still announced.
  if (item.sessionId === openId || !allowed(kind, prefs)) return { signals: updated, banner: null };
  for (const p of view.projects) {
    const s = p.sessions.find((x) => x.id === item.sessionId);
    if (!s) continue;
    const b = bannerFor(p, s, kind);
    if (!s.silo && !item.private) {
      if (item.kind === "ask") {
        const q = item.questions[0]?.question?.trim();
        b.text = q ? `Asks: ${q}` : "Asks you a question";
      } else {
        const l = permissionLine(item);
        b.text = l.prefix ? `${l.prefix} ${l.text}` : l.text;
      }
    } else {
      b.openable = false;
      b.text = PRIVATE_NEEDS_TEXT;
    }
    return { signals: updated, banner: b };
  }
  return { signals: updated, banner: null };
}
