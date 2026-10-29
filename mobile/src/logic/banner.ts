/**
 * In-app banners (spec §9: in-app only). A banner drops from the top when a session NEWLY
 * enters "needs you" (or, if the reader asked for it, finishes a turn) — never for the chat on
 * screen, and never for a state the phone first saw already in place.
 *
 * Two sources feed the same per-session signal map: the polled `projects` view (every session)
 * and live `status` frames (only the session this socket streams). Because both write the same
 * map, a transition seen first on a status frame is not raised again by the next poll.
 */
import type { WireProjectsView, WireViewProject, WireViewSession } from "../bridge/protocol";
import type { Prefs } from "../data/prefs";
import type { SessionStatus } from "../data/types";
import { isNeeds } from "./chatList";

export type BannerKind = "question" | "permission" | "finished";

export interface Signal {
  needs: "question" | "permission" | null;
  status: SessionStatus;
}

export type Signals = Record<string, Signal>;

export type NotifyPrefs = Pick<Prefs, "notifyQuestion" | "notifyPermission" | "notifyFinished">;

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

export const PRIVATE_NEEDS_TEXT = "Private session — open it on your Mac";

export function signalOf(s: WireViewSession): Signal {
  const needs = s.needs?.kind === "ask" ? "question" : isNeeds(s) ? "permission" : null;
  return { needs, status: s.status };
}

/** The banner kind for a change between two signals, or null when nothing new happened. */
export function transition(prev: Signal | undefined, next: Signal): BannerKind | null {
  if (!prev) return null; // first sight is not a transition
  if (next.needs && !prev.needs) return next.needs;
  if (!next.needs && prev.status === "running" && (next.status === "done" || next.status === "idle")) return "finished";
  return null;
}

function allowed(kind: BannerKind, prefs: NotifyPrefs): boolean {
  return kind === "question" ? prefs.notifyQuestion : kind === "permission" ? prefs.notifyPermission : prefs.notifyFinished;
}

let seq = 0;

function bannerFor(p: WireViewProject, s: WireViewSession, kind: BannerKind): Banner {
  let text: string;
  if (s.silo) text = kind === "finished" ? "Private session finished" : PRIVATE_NEEDS_TEXT;
  else if (kind === "question") text = s.needs?.kind === "ask" && s.needs.text ? `Asks: ${s.needs.text}` : "Asks you a question";
  else if (kind === "permission") text = "Needs your input";
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

const RANK: Record<BannerKind, number> = { question: 0, permission: 1, finished: 2 };

/** A new view: update every session's signal; raise banners for allowed transitions, most urgent first. */
export function bannersFromView(
  signals: Signals,
  next: WireProjectsView,
  openId: string | null,
  prefs: NotifyPrefs,
): { signals: Signals; banners: Banner[] } {
  const out: Signals = {};
  const banners: Banner[] = [];
  for (const p of next.projects) {
    for (const s of p.sessions) {
      const sig = signalOf(s);
      out[s.id] = sig;
      const kind = transition(signals[s.id], sig);
      if (kind && s.id !== openId && allowed(kind, prefs)) banners.push(bannerFor(p, s, kind));
    }
  }
  banners.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  return { signals: out, banners };
}

/**
 * A live status for the streamed session. A hook says only "needs input", not which kind, so a
 * session not already known to be asking reads as a permission prompt; the session's project and
 * name come from the last view (none there → ignored).
 */
export function bannerFromStatus(
  signals: Signals,
  view: WireProjectsView | null,
  sessionId: string,
  status: SessionStatus,
  openId: string | null,
  prefs: NotifyPrefs,
): { signals: Signals; banner: Banner | null } {
  const prev = signals[sessionId];
  if (!prev || !view) return { signals, banner: null };
  const next: Signal = { needs: status === "needsInput" ? prev.needs ?? "permission" : null, status };
  const updated = { ...signals, [sessionId]: next };
  const kind = transition(prev, next);
  if (!kind || sessionId === openId || !allowed(kind, prefs)) return { signals: updated, banner: null };
  for (const p of view.projects) {
    const s = p.sessions.find((x) => x.id === sessionId);
    if (s) return { signals: updated, banner: bannerFor(p, s, kind) };
  }
  return { signals: updated, banner: null };
}
