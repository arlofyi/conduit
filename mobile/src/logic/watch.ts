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
 * Time matters in two places, so the state is also stepped by `tick` (the service schedules one
 * at `nextWakeAt`): a finished turn is announced only once it has stayed finished for
 * FINISH_SETTLE_MS (see banner.ts for why -- without it every chat bubble of an agy session
 * read as "finished"), and a link down for UNREACHABLE_MS becomes "can't reach your computer".
 *
 * The JS side (data/BgWatchProvider.tsx) uses the rest: when to run the watcher, what to hand
 * it, when the hand-over is complete, and where a tapped notification leads.
 */
import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import type { Prefs } from "../data/prefs";
import type { SessionStatus } from "../data/types";
import { FINISH_SETTLE_MS, failedText, nextSignal, settled, signalOf, transition, withoutFinish, type Signal, type Signals } from "./banner";
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
  /** its agent process is up */
  running: boolean;
  /** hibernated */
  stopped: boolean;
  /** the last turn ended on an error: its kind (null = it did not) */
  failed: string | null;
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

/** The background link to the computer, as the rules see it. */
export interface WatchLink {
  /** when the link went down (ms), null while it is up */
  lostSince: number | null;
  /** down for UNREACHABLE_MS: announced (once) until it comes back */
  unreachable: boolean;
}

export interface WatchState {
  /** null until the first `projects` frame: nothing is posted before names are known */
  sessions: Record<string, WatchSession> | null;
  /** each session's last signal, seeded from what the app last saw; a settling finish lives here */
  signals: Signals;
  /** open items; `silent` = the app had already shown it before the hand-over */
  items: Record<string, WatchItem & { silent: boolean }>;
  /** item ids the app already knew about (never announced again) */
  seen: string[];
  /** sessions that NEWLY need you per the view, with no held item to say what (other agents) */
  alerts: Record<string, "question" | "permission">;
  /** sessions whose turn ended, and stayed ended for FINISH_SETTLE_MS, while watching */
  finished: Record<string, true>;
  /** sessions whose turn ended on an error while watching: the error's kind */
  failed: Record<string, string>;
  /** sessions that were live and were stopped while watching */
  stopped: Record<string, true>;
  /** general chats' titles, from `rootChats` */
  chatTitles: Record<string, string>;
  /** general chats whose reply finished while watching: a preview of it ("" = none) */
  chatsDone: Record<string, string>;
  link: WatchLink;
  /** the phone has a VPN (Tailscale) up: only then is an unreachable computer news */
  tunnel: boolean;
}

export type WatchEvent =
  | { t: "projects"; sessions: WatchSession[]; now: number }
  | { t: "snapshot"; items: WatchItem[] }
  | { t: "added"; item: WatchItem }
  | { t: "resolved"; id: string }
  | { t: "chats"; chats: { id: string; title: string }[] }
  | { t: "chatEvent"; event: string; chatId: string; result?: string | null; isError?: boolean }
  /** time passed: a settling finish may be due, a lost link may now be news */
  | { t: "tick"; now: number }
  /** the watcher's link phase ("watching" = up; "connecting" / "retrying" = down) */
  | { t: "link"; phase: string; now: number }
  | { t: "network"; tunnel: boolean };

/**
 * How long the link may be down before "can't reach your computer" is posted. Ten minutes is
 * past a laptop lid closed for a coffee or a Wi-Fi hand-over, so it means the computer is
 * asleep, off, or off the tailnet. Kept identical to WatchRules.kt.
 */
export const UNREACHABLE_MS = 10 * 60_000;

export function initialWatch(seen: string[], signals: Signals): WatchState {
  return {
    sessions: null,
    signals,
    items: {},
    seen,
    alerts: {},
    finished: {},
    failed: {},
    stopped: {},
    chatTitles: {},
    chatsDone: {},
    link: { lostSince: null, unreachable: false },
    tunnel: true,
  };
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
    // The view that later shows this session asking is then not a second, generic alert; and a
    // session holding a question has not finished (agy reads `idle` at its permission menu).
    signals: { ...s.signals, [item.sessionId]: { ...(prev ? withoutFinish(prev) : {}), needs: prev?.needs ?? kind, status: "needsInput" } },
  };
}

/** Promote settled finishes and a long-lost link. The same `s` when nothing is due. */
function settle(s: WatchState, now: number): WatchState {
  let next = s;
  if (s.link.lostSince === null && s.sessions) {
    // A finish only settles on a live link: with the computer out of reach "still quiet" is a guess.
    for (const [sid, sig] of Object.entries(s.signals)) {
      if (!s.sessions[sid] || !settled(sig, now)) continue;
      if (next === s) next = { ...s, signals: { ...s.signals }, finished: { ...s.finished } };
      next.signals[sid] = withoutFinish(sig);
      next.finished[sid] = true;
    }
  }
  if (s.link.lostSince !== null && !s.link.unreachable && now - s.link.lostSince >= UNREACHABLE_MS) {
    next = { ...next, link: { ...next.link, unreachable: true } };
  }
  return next;
}

/** When the state next needs a `tick` (ms), or null: the service schedules its re-check from this. */
export function nextWakeAt(s: WatchState): number | null {
  let at: number | null = null;
  const take = (t: number) => {
    if (at === null || t < at) at = t;
  };
  if (s.link.lostSince === null) {
    if (s.sessions) for (const sig of Object.values(s.signals)) if (sig.finishAt !== undefined) take(sig.finishAt + FINISH_SETTLE_MS);
  } else if (!s.link.unreachable) take(s.link.lostSince + UNREACHABLE_MS);
  return at;
}

export function watchStep(s: WatchState, ev: WatchEvent): WatchState {
  switch (ev.t) {
    case "projects": {
      const sessions: Record<string, WatchSession> = {};
      const signals: Signals = {};
      const withItem = new Set(Object.values(s.items).map((i) => i.sessionId));
      let alerts: WatchState["alerts"] = {};
      const finished: WatchState["finished"] = {};
      const failed: WatchState["failed"] = {};
      const stopped: WatchState["stopped"] = {};
      for (const x of ev.sessions) {
        sessions[x.id] = x;
        const prev = s.signals[x.id];
        const raw: Signal = { needs: x.needs, status: x.status, running: x.running, stopped: x.stopped, failed: x.failed };
        let sig = nextSignal(prev, raw, ev.now);
        if (withItem.has(x.id)) sig = withoutFinish(sig);
        signals[x.id] = sig;
        const kind = transition(prev, sig);
        // carried over only for sessions still listed, and only while still true
        if (s.alerts[x.id] && sig.needs) alerts[x.id] = s.alerts[x.id];
        if (s.finished[x.id] && !sig.needs && sig.status !== "running") finished[x.id] = true;
        if (s.failed[x.id] !== undefined && sig.failed) failed[x.id] = s.failed[x.id];
        if (s.stopped[x.id] && sig.stopped) stopped[x.id] = true;
        if (kind === "question" || kind === "permission") alerts = { ...alerts, [x.id]: kind };
        if (kind === "failed") failed[x.id] = x.failed ?? "";
        if (kind === "stopped") stopped[x.id] = true;
        // "finished" only starts settling here (sig.finishAt); `settle` announces it
      }
      return settle({ ...s, sessions, signals, alerts, finished, failed, stopped }, ev.now);
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
    case "chats": {
      const chatTitles: Record<string, string> = {};
      for (const c of ev.chats) chatTitles[c.id] = c.title;
      return { ...s, chatTitles };
    }
    case "chatEvent":
      // A reply finished: announce it -- once per TURN; `item` events (every bubble) never
      // notify. A new message from anyone starts a new turn.
      if (ev.event === "done") return { ...s, chatsDone: { ...s.chatsDone, [ev.chatId]: chatPreview(ev.result, ev.isError) } };
      // root_chat publishes `error` (no `done`) when the turn itself failed -- an Antigravity
      // failure or a crashed child. It is a finished turn too, and it failed. Kept identical
      // to WatchRules.kt.
      if (ev.event === "error") return { ...s, chatsDone: { ...s.chatsDone, [ev.chatId]: CHAT_FAILED } };
      if (ev.event === "user") return { ...s, chatsDone: without(s.chatsDone, ev.chatId) };
      return s;
    case "tick":
      return settle(s, ev.now);
    case "link": {
      if (ev.phase === "watching") {
        if (s.link.lostSince === null && !s.link.unreachable) return s;
        return { ...s, link: { lostSince: null, unreachable: false } };
      }
      const lost = s.link.lostSince === null ? { ...s, link: { lostSince: ev.now, unreachable: false } } : s;
      return settle(lost, ev.now);
    }
    case "network":
      return s.tunnel === ev.tunnel ? s : { ...s, tunnel: ev.tunnel };
  }
}

/** `needs`: wants you (incl. a failed turn). `finished`: a turn or reply ended. `status`: a
 * session stopped, or the computer is out of reach. */
export type WatchChannel = "needs" | "finished" | "status";

/** What the bg-watch module needs to open a chat from a notification. */
export interface WatchTarget {
  sessionId: string;
  projectId: string;
  name: string;
  branch: string | null;
}

export interface WatchNotification {
  /** stable per thing announced: `item:<id>`, `needs:<s>`, `failed:<s>`, `stopped:<s>`,
   * `done:<s>`, `chat:<id>`, `unreachable` */
  key: string;
  channel: WatchChannel;
  title: string;
  /** the project, under the title (null for private sessions) */
  subtitle: string | null;
  body: string;
  /** null = open the app on its home (private sessions cannot be opened from the phone) */
  target: WatchTarget | null;
}

export type WatchPrefs = Pick<
  Prefs,
  "notifyQuestion" | "notifyPermission" | "notifyFinished" | "notifyFailed" | "notifyStopped" | "notifyUnreachable"
>;

export const APP_TITLE = "Conduit";
export const PRIVATE_NEEDS = "A private session needs you";
export const PRIVATE_FINISHED = "A private session finished";
export const PRIVATE_FAILED = "A private session failed";
export const PRIVATE_STOPPED = "A private session stopped";
/** what the lock screen shows when the reader hides sensitive content */
export const PUBLIC_NEEDS = "An agent needs you";
export const PUBLIC_FINISHED = "An agent finished";
export const PUBLIC_STATUS = "An update from your computer";
export const STOPPED_BODY = "Stopped";
export const UNREACHABLE_KEY = "unreachable";
export const UNREACHABLE_BODY = "Can't reach your computer for 10 minutes. Nothing from it will arrive until it's back.";

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
  privateBody: string,
): WatchNotification {
  // A private session says only that something happened, and opens the app.
  if (isPrivate) return { key, channel, title: APP_TITLE, subtitle: null, body: privateBody, target: null };
  // An item whose session is not listed (deleted meanwhile) still says something, and opens the app.
  if (!session) return { key, channel, title: APP_TITLE, subtitle: null, body, target: null };
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
    out.push(made(`item:${it.id}`, "needs", session, priv, body, PRIVATE_NEEDS));
  }
  for (const [sid, kind] of Object.entries(s.alerts)) {
    // A held item says it better; the generic alert is for agents that hold nothing.
    if (withItem.has(sid)) continue;
    if (kind === "question" ? !prefs.notifyQuestion : !prefs.notifyPermission) continue;
    const session = sessions[sid];
    const body = kind === "question" ? session?.needsText?.trim() || "Asks you a question" : "Needs your input";
    out.push(made(`needs:${sid}`, "needs", session, !!session?.silo, body, PRIVATE_NEEDS));
  }
  if (prefs.notifyFailed) {
    for (const [sid, kind] of Object.entries(s.failed)) {
      const session = sessions[sid];
      out.push(made(`failed:${sid}`, "needs", session, !!session?.silo, failedText(kind), PRIVATE_FAILED));
    }
  }
  if (prefs.notifyStopped) {
    for (const sid of Object.keys(s.stopped)) {
      const session = sessions[sid];
      out.push(made(`stopped:${sid}`, "status", session, !!session?.silo, STOPPED_BODY, PRIVATE_STOPPED));
    }
  }
  if (prefs.notifyFinished) {
    for (const sid of Object.keys(s.finished)) {
      const session = sessions[sid];
      out.push(made(`done:${sid}`, "finished", session, !!session?.silo, "Finished", PRIVATE_FINISHED));
    }
  }
  for (const [chatId, body] of Object.entries(s.chatsDone)) {
    // a failed reply is a failure (its own switch); a good one is a finish
    if (body === CHAT_FAILED ? !prefs.notifyFailed : !prefs.notifyFinished) continue;
    const title = s.chatTitles[chatId]?.trim() || CHAT_DEFAULT_TITLE;
    out.push({
      key: `chat:${chatId}`,
      channel: "finished",
      title,
      subtitle: "Chats",
      body: body || CHAT_REPLIED,
      target: { sessionId: `${CHAT_TARGET_PREFIX}${chatId}`, projectId: "", name: title, branch: null },
    });
  }
  // Only with a tunnel up: with Tailscale switched off on purpose the computer is unreachable by design.
  if (prefs.notifyUnreachable && s.link.unreachable && s.tunnel) {
    out.push({ key: UNREACHABLE_KEY, channel: "status", title: APP_TITLE, subtitle: null, body: UNREACHABLE_BODY, target: null });
  }
  return out;
}

/** The body of a finished general chat's notification: the reply's start, else a plain line. */
export function chatPreview(result: string | null | undefined, isError?: boolean): string {
  if (isError) return CHAT_FAILED;
  const t = (result ?? "").replace(/\s+/g, " ").trim();
  if (!t) return CHAT_REPLIED;
  return t.length > CHAT_PREVIEW_MAX ? `${t.slice(0, CHAT_PREVIEW_MAX - 1).trimEnd()}…` : t;
}

export const CHAT_REPLIED = "Replied";
export const CHAT_FAILED = "The reply failed";
export const CHAT_DEFAULT_TITLE = "Chat";
export const CHAT_PREVIEW_MAX = 140;
/** A target naming a general chat rather than a session: `chat:<id>` in `sessionId`. */
export const CHAT_TARGET_PREFIX = "chat:";

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
        running: x.running,
        stopped: x.stopped,
        failed: x.failed ?? null,
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

export const anyNotify = (p: WatchPrefs): boolean =>
  p.notifyQuestion || p.notifyPermission || p.notifyFinished || p.notifyFailed || p.notifyStopped || p.notifyUnreachable;

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
