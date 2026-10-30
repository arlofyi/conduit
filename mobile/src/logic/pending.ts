/**
 * Questions and permissions the Mac is holding for a human, as the phone sees them.
 *
 * The Mac pushes a `pending` snapshot once the socket is trusted, then `pendingAdded` /
 * `resolved{by}` diffs (src-tauri/src/bridge_view.rs `push_frames`). The phone answers with
 * `answer` / `approve` and hears back `answerResult` / `approveResult`. First answer wins
 * anywhere (phone, Mac, terminal), so every card ends in one of a handful of honest states,
 * decided here and only drawn by ChatScreen.
 *
 * A settled entry is KEPT (capped) so its card can say how it ended: a question card joined to
 * the transcript keeps "Answered" in place, and a standalone card lingers SETTLED_SHOW_MS.
 */
import type { WireBy, WirePendingItem, WireQuestion } from "../bridge/protocol";
import { splitRecommended } from "./chatView";

export type By = WireBy;

export type PendingAsk = {
  kind: "ask";
  id: string;
  sessionId: string;
  private: false;
  toolUseId: string;
  questions: WireQuestion[];
  createdMs: number;
  /** a hook is waiting on it (a card may answer); false = the Mac's terminal has it */
  held: boolean;
};
export type PendingPermission = {
  kind: "permission";
  id: string;
  sessionId: string;
  private: false;
  toolName: string;
  summary: string;
  createdMs: number;
  held: boolean;
};
export type PendingPrivate = { kind: "ask" | "permission"; id: string; sessionId: string; private: true };
export type PendingItem = PendingAsk | PendingPermission | PendingPrivate;

/** What this phone sent for an item. */
export type Mine = { kind: "answer"; summary: string } | { kind: "approve"; allow: boolean };

export interface Entry {
  item: PendingItem;
  sent?: Mine;
  /** the last tap found no open socket: nothing went out, the card stays live and says so */
  unsent?: true;
  /** the Mac's answerResult / approveResult */
  ok?: boolean;
  /** the Mac refused OUR answer (answerResult ok:false) and nobody else has answered: the
   *  question is still waiting, so the card goes back to live and says why */
  rejected?: true;
  /** who resolved it, from `resolved` */
  by?: By;
  /** when it first settled (ok or by arrived), for how long a standalone card lingers */
  settledAt?: number;
}

export interface PendingState {
  /** arrival order */
  order: string[];
  entries: Record<string, Entry>;
}

export const emptyPending: PendingState = { order: [], entries: {} };

/** How long a standalone (trailing) card shows its outcome before it goes. */
export const SETTLED_SHOW_MS = 4000;
/** Settled entries remembered, so joined question cards keep their outcome. */
export const SETTLED_KEEP = 64;

export const PRIVATE_ANSWER_TEXT = "Private session — answer it on your Mac";
export const DENIED_TEXT = "Denied — if you'd already allowed it in the terminal, it keeps running.";

export function fromWire(w: WirePendingItem): PendingItem {
  const kind = w.kind === "permission" ? "permission" : "ask";
  if ("private" in w && w.private) return { kind, id: w.id, sessionId: w.sessionId, private: true };
  if (kind === "permission") {
    const p = w as Extract<WirePendingItem, { toolName: string }>;
    return {
      kind,
      id: p.id,
      sessionId: p.sessionId,
      private: false,
      toolName: p.toolName ?? "",
      summary: p.summary ?? "",
      createdMs: p.createdMs ?? 0,
      held: p.held !== false,
    };
  }
  const a = w as Extract<WirePendingItem, { toolUseId: string }>;
  return {
    kind: "ask",
    id: a.id,
    sessionId: a.sessionId,
    private: false,
    toolUseId: a.toolUseId ?? "",
    questions: Array.isArray(a.questions) ? a.questions : [],
    createdMs: a.createdMs ?? 0,
    held: a.held !== false,
  };
}

/** Whether this phone may send anything for an item: only a HELD one (a hook is waiting). */
const answerable = (item: PendingItem): boolean => !item.private && item.held;

export type PendingEvent =
  | { t: "snapshot"; items: PendingItem[]; now: number }
  | { t: "added"; item: PendingItem }
  | { t: "resolved"; id: string; by: By; now: number }
  | { t: "sent"; id: string; mine: Mine }
  | { t: "unsent"; id: string }
  | { t: "result"; id: string; ok: boolean; now: number };

export const isSettled = (e: Entry): boolean => e.ok !== undefined || e.by !== undefined;

function prune(order: string[], entries: Record<string, Entry>): PendingState {
  const settled = order.filter((id) => isSettled(entries[id]));
  if (settled.length <= SETTLED_KEEP) return { order, entries };
  const drop = new Set(
    [...settled].sort((a, b) => (entries[a].settledAt ?? 0) - (entries[b].settledAt ?? 0)).slice(0, settled.length - SETTLED_KEEP),
  );
  const next: Record<string, Entry> = {};
  for (const id of order) if (!drop.has(id)) next[id] = entries[id];
  return { order: order.filter((id) => !drop.has(id)), entries: next };
}

function patch(s: PendingState, id: string, f: (e: Entry) => Entry): PendingState {
  const e = s.entries[id];
  if (!e) return s;
  const next = f(e);
  if (next === e) return s;
  return { order: s.order, entries: { ...s.entries, [id]: next } };
}

export function pendingReducer(s: PendingState, ev: PendingEvent): PendingState {
  switch (ev.t) {
    case "snapshot": {
      // A fresh socket's view of what is waiting, and the Mac is the truth. Anything this phone
      // saw settle keeps its outcome UNLESS the snapshot names its id: ask-N / perm-N restart at
      // 1 when Conduit relaunches, so a listed id is a new item, never the settled one. Anything
      // still open here but absent there settled while we were away and nobody can say how, so
      // it simply goes. An open item keeps nothing of a send: a frame lost with the old socket
      // would otherwise sit at "Sending…" for good, and resending is safe (first answer wins).
      const listed = new Set(ev.items.map((i) => i.id));
      const order: string[] = [];
      const entries: Record<string, Entry> = {};
      for (const id of s.order) {
        if (isSettled(s.entries[id]) && !listed.has(id)) {
          order.push(id);
          entries[id] = s.entries[id];
        }
      }
      for (const item of ev.items) {
        if (entries[item.id]) continue;
        order.push(item.id);
        entries[item.id] = { item };
      }
      return prune(order, entries);
    }
    case "added": {
      const prev = s.entries[ev.item.id];
      if (prev && !isSettled(prev)) return s;
      // A settled id pushed again is a relaunched Mac's new item: replace it, at the end.
      const order = prev ? s.order.filter((id) => id !== ev.item.id) : s.order;
      return { order: [...order, ev.item.id], entries: { ...s.entries, [ev.item.id]: { item: ev.item } } };
    }
    case "resolved": {
      const e = s.entries[ev.id];
      if (!e) return s;
      if (ev.by === "cancelled") {
        // The turn moved on: the question no longer exists anywhere. No outcome to show.
        const { [ev.id]: _gone, ...rest } = s.entries;
        return { order: s.order.filter((id) => id !== ev.id), entries: rest };
      }
      return prune(s.order, { ...s.entries, [ev.id]: { ...e, by: ev.by, settledAt: e.settledAt ?? ev.now } });
    }
    case "sent":
      return patch(s, ev.id, (e) => (!answerable(e.item) || isSettled(e) ? e : { item: e.item, sent: ev.mine }));
    case "unsent":
      return patch(s, ev.id, (e) => (!answerable(e.item) || isSettled(e) || (e.sent && !e.rejected) || e.unsent ? e : { ...e, unsent: true }));
    case "result":
      return patch(s, ev.id, (e) => {
        // An answer refused while no `resolved` names a winner was refused for what it SAID
        // (`phone_may_answer`: over MAX_ANSWER_BYTES). The ask is still pending, so this is not
        // a settlement: keep the card live, and a retry may still win. If someone else did
        // answer, their `resolved` frame follows within one push and settles it.
        if (!ev.ok && e.sent?.kind === "answer" && e.by === undefined) return { item: e.item, sent: e.sent, rejected: true };
        return { ...e, ok: ev.ok, settledAt: e.settledAt ?? ev.now };
      });
  }
}

// ---- what a card shows ----

export type CardView =
  | { mode: "live"; item: PendingAsk | PendingPermission; notice?: string }
  | { mode: "sending"; item: PendingAsk | PendingPermission; mine: Mine }
  | { mode: "private"; item: PendingItem; text: string }
  /** the Mac's terminal has it (no hook waiting): the full item, read-only */
  | { mode: "watching"; item: PendingAsk | PendingPermission; text: string }
  | { mode: "done"; item: PendingItem; tone: "ok" | "bad" | "info"; text: string; detail?: string };

export const UNSENT_TEXT = "Not connected — try again";
export const REJECTED_ANSWER_TEXT = "Couldn't send that answer — try a shorter one";
export const WATCHING_TEXT = "Waiting for an answer in the terminal on your Mac";

function elsewhere(item: PendingItem, by: By | undefined, late: boolean): string {
  const kind = item.kind;
  switch (by) {
    case "desktop":
      return late ? "Already answered on your Mac" : "Answered on your Mac";
    case "terminal":
      // A HELD ask resolved by the terminal is always a hand-off (Esc in the pane, the last
      // phone left, the card's link) -- nobody answered it anywhere yet. An OBSERVED ask only
      // reads `terminal` when its own tool finished: it was answered there.
      if (kind === "ask") return !item.private && !item.held ? "Answered in the terminal" : "Moved to the terminal";
      return late ? "Already handled in the terminal" : "Handled in the terminal";
    case "timeout":
      return "Moved to the terminal";
    case "phone":
      return late ? "Already answered on another phone" : "Answered on another phone";
    default:
      return "Already answered";
  }
}

export function cardView(e: Entry): CardView {
  const item = e.item;
  if (item.private) return { mode: "private", item, text: PRIVATE_ANSWER_TEXT };
  const mine = e.sent;
  if (mine && e.rejected && e.by === undefined) return { mode: "live", item, notice: e.unsent ? UNSENT_TEXT : REJECTED_ANSWER_TEXT };
  if (mine) {
    // Ours won if the Mac said ok, or (result still in flight) the resolution names a phone.
    const won = e.ok === true || (e.ok === undefined && !e.rejected && e.by === "phone");
    if (won) {
      if (mine.kind === "answer") return { mode: "done", item, tone: "ok", text: "Answered", detail: mine.summary || undefined };
      // ok:true means the answer reached Claude's hook, not that the tool was stopped.
      return mine.allow ? { mode: "done", item, tone: "ok", text: "Allowed" } : { mode: "done", item, tone: "bad", text: DENIED_TEXT };
    }
    if (e.ok === false || e.by !== undefined) return { mode: "done", item, tone: "info", text: elsewhere(item, e.by, true) };
    return { mode: "sending", item, mine };
  }
  if (e.by !== undefined || e.ok !== undefined) return { mode: "done", item, tone: "info", text: elsewhere(item, e.by, false) };
  if (!item.held) return { mode: "watching", item, text: WATCHING_TEXT };
  return e.unsent ? { mode: "live", item, notice: UNSENT_TEXT } : { mode: "live", item };
}

/** Value equality for memoised rows. */
export function sameCard(a: CardView | undefined, b: CardView | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.mode !== b.mode || a.item !== b.item) return false;
  if (a.mode === "done" && b.mode === "done") return a.text === b.text && a.detail === b.detail && a.tone === b.tone;
  if (a.mode === "live" && b.mode === "live") return a.notice === b.notice;
  return true;
}

/** The pending (or settled) ask a transcript question card joins, by its tool_use id. */
export function entryForToolUse(s: PendingState, sessionId: string, toolUseId: string): Entry | null {
  if (!toolUseId) return null;
  for (let i = s.order.length - 1; i >= 0; i--) {
    const e = s.entries[s.order[i]];
    if (e.item.sessionId === sessionId && e.item.kind === "ask" && !e.item.private && e.item.toolUseId === toolUseId) return e;
  }
  return null;
}

/**
 * Cards drawn at the end of a chat's feed: every permission (they have no transcript card) and
 * every ask whose transcript card has not arrived yet. A settled one stays SETTLED_SHOW_MS so
 * the reader sees how it ended.
 */
export function trailingEntries(s: PendingState, sessionId: string, feedToolUseIds: Set<string>, now: number): Entry[] {
  const out: Entry[] = [];
  for (const id of s.order) {
    const e = s.entries[id];
    if (e.item.sessionId !== sessionId) continue;
    if (e.item.kind === "ask" && !e.item.private && feedToolUseIds.has(e.item.toolUseId)) continue;
    if (isSettled(e) && now - (e.settledAt ?? now) >= SETTLED_SHOW_MS) continue;
    out.push(e);
  }
  return out;
}

/** The earliest still-open item per session (the Chats list's needs preview). */
export function openBySession(s: PendingState): Record<string, PendingItem> {
  const out: Record<string, PendingItem> = {};
  for (const id of s.order) {
    const e = s.entries[id];
    if (isSettled(e) || (e.sent && !e.rejected)) continue;
    if (!out[e.item.sessionId]) out[e.item.sessionId] = e.item;
  }
  return out;
}

/** The next time a trailing card's linger ends (ms), or null when none is lingering. */
export function nextExpiry(s: PendingState, now: number): number | null {
  let next: number | null = null;
  for (const id of s.order) {
    const at = s.entries[id].settledAt;
    if (at === undefined) continue;
    const end = at + SETTLED_SHOW_MS;
    if (end > now && (next === null || end < next)) next = end;
  }
  return next;
}

// ---- building the answer (the desktop's src/asks.ts, kept in step) ----

/** The desktop's MULTISELECT_JOIN (src/askProtocol.ts). */
export const MULTISELECT_JOIN = ", ";

/**
 * Exact question text -> answer, or null while any question is unanswered. Free text wins over
 * picks; multi-select joins in OPTION order (not tap order); labels go back untouched, marker
 * and all, because Claude matches its own option text.
 */
export function buildAnswers(
  questions: WireQuestion[],
  picks: Record<string, string[]>,
  freeText: Record<string, string>,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const typed = (freeText[q.question] ?? "").trim();
    if (typed) {
      out[q.question] = typed;
      continue;
    }
    const chosen = picks[q.question] ?? [];
    const ordered = q.options.map((o) => o.label).filter((l) => chosen.includes(l));
    if (ordered.length === 0) return null;
    out[q.question] = q.multiSelect ? ordered.join(MULTISELECT_JOIN) : ordered[0];
  }
  return out;
}

/** "Yes, lint, build": what was sent, for the card's confirmation line. */
export function answerSummary(answers: Record<string, string>, max = 60): string {
  const s = Object.values(answers)
    .flatMap((v) => v.split(MULTISELECT_JOIN))
    .map((v) => splitRecommended(v).label)
    .join(", ");
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A permission's one-line ask, shared by the list preview and the banner. */
export function permissionLine(p: PendingPermission): { prefix: string | null; text: string } {
  const summary = p.summary.trim();
  if (!summary || summary === p.toolName) return { prefix: null, text: `Allow ${p.toolName}?` };
  return { prefix: `Allow ${p.toolName}:`, text: summary };
}
