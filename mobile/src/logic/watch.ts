/**
 * Notifications with the screen off (Android): the rules of the background watcher.
 *
 * While the app is in the background, the native service in `modules/bg-watch` holds one
 * authenticated socket to the computer and posts system notifications. It runs with no JS, so
 * its decisions are a Kotlin port of THIS file (`WatchRules.kt`): what each frame does to the
 * watcher's state, which notifications that state wants on screen, and what they say. Change
 * one, change the other -- the jest tests here are the specification both follow.
 *
 * The model is declarative: frames update a small state, `desiredNotifications` derives the set
 * of notifications that should be showing, and `diffNotifications` turns the change into posts
 * and cancels. So a resolved question, a session that runs again, or a switch turned off simply
 * stops being "desired" and its notification goes away.
 *
 * The JS side (data/BgWatchProvider.tsx) uses the rest: when to run the watcher, what to hand
 * it, when the hand-over is complete, and where a tapped notification leads.
 */
import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import type { Prefs } from "../data/prefs";
import type { SessionStatus } from "../data/types";
import { signalOf, transition, type Signal, type Signals } from "./banner";
import type { PendingItem, PendingState } from "./pending";

// ---------------------------------------------------------------- state machine (ported) ----

/** What the watcher knows about one session, from the `projects` frame. */
export interface WatchSession {
  id: string;
  projectId: string;
  project: string;
  name: string;
  branch: string | null;
  /** private / local-only: announced with no detail and never opened from the phone */
  silo: boolean;
  status: SessionStatus;
  needs: "question" | "permission" | null;
  /** the question, when the view carries it */
  needsText: string | null;
}

/** One held question or permission, reduced to what a notification can say. */
export interface WatchItem {
  id: string;
  sessionId: string;
  kind: "ask" | "permission";
  private: boolean;
  /** the first question (asks) */
  question: string;
  toolName: string;
  summary: string;
}

export interface WatchState {
  /** null until the first `projects` frame: nothing is posted before names are known */
  sessions: Record<string, WatchSession> | null;
  /** each session's last signal, seeded from what the app last saw */
  signals: Signals;
  /** open items; `silent` = the app had already shown it before the hand-over */
  items: Record<string, WatchItem & { silent: boolean }>;
  /** item ids the app already knew about (never announced again) */
  seen: string[];
  /** sessions that NEWLY need you per the view, with no held item to say what (other agents) */
  alerts: Record<string, "question" | "permission">;
  /** sessions whose turn ended while watching */
  finished: Record<string, true>;
}

export type WatchEvent =
  | { t: "projects"; sessions: WatchSession[] }
  | { t: "snapshot"; items: WatchItem[] }
  | { t: "added"; item: WatchItem }
  | { t: "resolved"; id: string };

export function initialWatch(seen: string[], signals: Signals): WatchState {
  return { sessions: null, signals, items: {}, seen, alerts: {}, finished: {} };
}

const without = <T>(r: Record<string, T>, k: string): Record<string, T> => {
  if (!(k in r)) return r;
  const { [k]: _gone, ...rest } = r;
  return rest;
};

function addItem(s: WatchState, item: WatchItem): WatchState {
  if (s.items[item.id]) return s;
  const kind = item.kind === "ask" ? "question" : "permission";
  const prev = s.signals[item.sessionId];
  return {
    ...s,
    items: { ...s.items, [item.id]: { ...item, silent: s.seen.includes(item.id) } },
    // The view that later shows this session asking is then not a second, generic alert.
    signals: { ...s.signals, [item.sessionId]: { needs: prev?.needs ?? kind, status: "needsInput" } },
  };
}

export function watchStep(s: WatchState, ev: WatchEvent): WatchState {
  switch (ev.t) {
    case "projects": {
      const sessions: Record<string, WatchSession> = {};
      const signals: Signals = {};
      let alerts: WatchState["alerts"] = {};
      let finished: WatchState["finished"] = {};
      for (const x of ev.sessions) {
        sessions[x.id] = x;
        const sig: Signal = { needs: x.needs, status: x.status };
        signals[x.id] = sig;
        const kind = transition(s.signals[x.id], sig);
        // carried over only for sessions still listed
        if (s.alerts[x.id] && sig.needs) alerts[x.id] = s.alerts[x.id];
        if (s.finished[x.id] && !sig.needs && sig.status !== "running") finished[x.id] = true;
        if (kind === "question" || kind === "permission") alerts = { ...alerts, [x.id]: kind };
        if (kind === "finished") finished = { ...finished, [x.id]: true };
      }
      return { ...s, sessions, signals, alerts, finished };
    }
    case "snapshot": {
      const ids = new Set(ev.items.map((i) => i.id));
      let next: WatchState = { ...s, items: {} };
      for (const [id, it] of Object.entries(s.items)) if (ids.has(id)) next.items[id] = it;
      for (const it of ev.items) next = addItem(next, it);
      return next;
    }
    case "added":
      return addItem(s, ev.item);
    case "resolved":
      return { ...s, items: without(s.items, ev.id) };
  }
}

export type WatchChannel = "needs" | "finished";

/** What the bg-watch module needs to open a chat from a notification. */
export interface WatchTarget {
  sessionId: string;
  projectId: string;
  name: string;
  branch: string | null;
}

export interface WatchNotification {
  /** stable per thing announced: `item:<id>`, `needs:<session>`, `done:<session>` */
  key: string;
  channel: WatchChannel;
  title: string;
  /** the project, under the title (null for private sessions) */
  subtitle: string | null;
  body: string;
  /** null = open the app on its home (private sessions cannot be opened from the phone) */
  target: WatchTarget | null;
}

export type WatchPrefs = Pick<Prefs, "notifyQuestion" | "notifyPermission" | "notifyFinished">;

export const APP_TITLE = "Conduit";
export const PRIVATE_NEEDS = "A private session needs you";
export const PRIVATE_FINISHED = "A private session finished";
/** what the lock screen shows when the reader hides sensitive content */
export const PUBLIC_NEEDS = "An agent needs you";
export const PUBLIC_FINISHED = "An agent finished";

const SHELL_TOOLS = /^(bash|powershell|shell|run_command|run_shell_command|exec|command)$/i;

/** "Wants to run: npm test" for a shell tool, "Wants to use Edit: src/a.ts" for anything else. */
export function permissionBody(toolName: string, summary: string): string {
  const tool = toolName.trim();
  const what = summary.trim();
  if (!what || what === tool) return tool ? `Wants to use ${tool}` : "Needs your permission";
  if (!tool || SHELL_TOOLS.test(tool)) return `Wants to run: ${what}`;
  return `Wants to use ${tool}: ${what}`;
}

function made(
  key: string,
  channel: WatchChannel,
  session: WatchSession | undefined,
  isPrivate: boolean,
  body: string,
): WatchNotification {
  if (isPrivate || !session) {
    // An item whose session is not listed (deleted meanwhile) still says something, and opens the app.
    if (isPrivate) return { key, channel, title: APP_TITLE, subtitle: null, body: channel === "needs" ? PRIVATE_NEEDS : PRIVATE_FINISHED, target: null };
    return { key, channel, title: APP_TITLE, subtitle: null, body, target: null };
  }
  return {
    key,
    channel,
    title: session.name || APP_TITLE,
    subtitle: session.project || null,
    body,
    target: { sessionId: session.id, projectId: session.projectId, name: session.name, branch: session.branch },
  };
}

/** Every notification the state wants on screen, given the reader's switches. Most urgent first. */
export function desiredNotifications(s: WatchState, prefs: WatchPrefs): WatchNotification[] {
  const sessions = s.sessions;
  if (!sessions) return [];
  const out: WatchNotification[] = [];
  const withItem = new Set<string>();
  for (const it of Object.values(s.items)) {
    withItem.add(it.sessionId);
    if (it.silent) continue;
    const isAsk = it.kind === "ask";
    if (isAsk ? !prefs.notifyQuestion : !prefs.notifyPermission) continue;
    const session = sessions[it.sessionId];
    const priv = it.private || !!session?.silo;
    const body = isAsk ? it.question.trim() || "Asks you a question" : permissionBody(it.toolName, it.summary);
    out.push(made(`item:${it.id}`, "needs", session, priv, body));
  }
  for (const [sid, kind] of Object.entries(s.alerts)) {
    // A held item says it better; the generic alert is for agents that hold nothing.
    if (withItem.has(sid)) continue;
    if (kind === "question" ? !prefs.notifyQuestion : !prefs.notifyPermission) continue;
    const session = sessions[sid];
    const body = kind === "question" ? session?.needsText?.trim() || "Asks you a question" : "Needs your input";
    out.push(made(`needs:${sid}`, "needs", session, !!session?.silo, body));
  }
  if (prefs.notifyFinished) {
    for (const sid of Object.keys(s.finished)) {
      const session = sessions[sid];
      out.push(made(`done:${sid}`, "finished", session, !!session?.silo, "Finished"));
    }
  }
  return out;
}

/** A notification's content fingerprint: re-posted only when this changes. */
export const notificationSignature = (n: WatchNotification): string =>
  JSON.stringify([n.channel, n.title, n.subtitle, n.body, n.target?.sessionId ?? null]);

/** Posts (new or changed) and cancels (no longer wanted) to bring the screen in line. */
export function diffNotifications(
  posted: Record<string, string>,
  desired: WatchNotification[],
): { post: WatchNotification[]; cancel: string[]; posted: Record<string, string> } {
  const next: Record<string, string> = {};
  const post: WatchNotification[] = [];
  for (const n of desired) {
    const sig = notificationSignature(n);
    next[n.key] = sig;
    if (posted[n.key] !== sig) post.push(n);
  }
  const cancel = Object.keys(posted).filter((k) => !(k in next));
  return { post, cancel, posted: next };
}

// ---------------------------------------------------------------- frame parsing (ported) ----

export function watchSessionsOf(view: WireProjectsView): WatchSession[] {
  return view.projects.flatMap((p) =>
    p.sessions.map((x: WireViewSession) => {
      const sig = signalOf(x);
      return {
        id: x.id,
        projectId: p.id,
        project: p.name,
        name: x.name,
        branch: x.branch,
        silo: x.silo,
        status: x.status,
        needs: sig.needs,
        needsText: x.needs?.kind === "ask" ? x.needs.text : null,
      };
    }),
  );
}

export function watchItemOf(i: PendingItem): WatchItem {
  if (i.private) return { id: i.id, sessionId: i.sessionId, kind: i.kind, private: true, question: "", toolName: "", summary: "" };
  if (i.kind === "ask")
    return { id: i.id, sessionId: i.sessionId, kind: "ask", private: false, question: i.questions[0]?.question ?? "", toolName: "", summary: "" };
  return { id: i.id, sessionId: i.sessionId, kind: "permission", private: false, question: "", toolName: i.toolName, summary: i.summary };
}

// ---------------------------------------------------------------- JS side: hand-over ----

export const anyNotify = (p: WatchPrefs): boolean => p.notifyQuestion || p.notifyPermission || p.notifyFinished;

/** Should the app hand over to the watcher as it goes to the background? */
export function shouldWatch(o: {
  available: boolean;
  prefs: WatchPrefs;
  token: string | null;
  addresses: string[];
  notificationsAllowed: boolean;
  /** a system dialog we opened (the notification permission) is in front: not a real background */
  asking: boolean;
}): boolean {
  return o.available && anyNotify(o.prefs) && !!o.token && o.addresses.length > 0 && o.notificationsAllowed && !o.asking;
}

/** The address that is working right now first, then the rest, without repeats. */
export function watchAddresses(working: string | null, all: string[]): string[] {
  return [...new Set([...(working ? [working] : []), ...all])];
}

/** What the app had already shown when it handed over: never announced again by the watcher. */
export function watchBaseline(
  view: WireProjectsView | null,
  pending: PendingState,
): { seen: string[]; signals: Record<string, Signal> } {
  const signals: Record<string, Signal> = {};
  for (const p of view?.projects ?? []) for (const x of p.sessions) signals[x.id] = signalOf(x);
  const seen = Object.values(pending.entries)
    .filter((e) => e.by === undefined)
    .map((e) => e.item.id);
  return { seen, signals };
}

/** The watcher's own report (`onStatus`). */
export type WatchPhase = "connecting" | "watching" | "retrying" | "stopped";

/**
 * The app's socket closes only once the watcher's is up (or has failed once): with no socket in
 * between, the computer would see the phone leave and hand every held question back to the
 * terminal -- the very question this is meant to deliver.
 */
export const handoverSettled = (phase: WatchPhase): boolean => phase !== "connecting";

/** How long, back in front, the watcher may keep its socket while the app's own redials. */
export const HANDBACK_MAX_MS = 10_000;

/**
 * Back in front: stop the watcher once the app's socket is ready (for the same reason as
 * above, in reverse), or once it has visibly failed, or after HANDBACK_MAX_MS regardless.
 */
export function shouldStopWatching(o: {
  foreground: boolean;
  wanted: boolean;
  running: boolean;
  connPhase: string;
  sinceForegroundMs: number;
}): boolean {
  if (!o.running) return false;
  if (!o.foreground) return !o.wanted;
  return o.connPhase === "ready" || o.connPhase === "failed" || o.sinceForegroundMs >= HANDBACK_MAX_MS;
}

/** A tapped notification's extras, as the module hands them over; null when they name no chat. */
export function openTargetOf(raw: unknown): WatchTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || !r.sessionId || typeof r.projectId !== "string") return null;
  return {
    sessionId: r.sessionId,
    projectId: r.projectId,
    name: typeof r.name === "string" ? r.name : "",
    branch: typeof r.branch === "string" && r.branch ? r.branch : null,
  };
}
