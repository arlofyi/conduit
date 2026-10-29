/** AskUserQuestion cards: pure rules. The Rust side holds the question open (asks.rs);
 *  this decides when a card may capture one and when to give it back to the terminal. */
import { MULTISELECT_JOIN } from "./askProtocol";
import type { ResolvedBy } from "./permissionView";

export type AskOption = { label: string; description?: string };
export type AskQuestion = { question: string; header?: string; options: AskOption[]; multiSelect?: boolean };
export type PendingAsk = { id: string; session: string; toolUseId: string; questions: AskQuestion[]; createdMs: number };

/** Capture only when a card could actually be seen: the view is open somewhere, or a
 *  Conduit window is focused (the dock shows it). Otherwise the menu appears as today. */
export function askGateOpen(i: { enabled: boolean; viewOpen: boolean; windowFocused: boolean }): boolean {
  return i.enabled && (i.viewOpen || i.windowFocused);
}

/** Hand back once the user is looking at that session's own terminal — the menu is about
 *  to be useful there, and a card elsewhere would be a second copy of the same question. */
export function askShouldHandOff(
  ask: PendingAsk,
  v: { selectedSessionId: string | null; continuityVisible: boolean; windowFocused: boolean },
): boolean {
  return v.windowFocused && !v.continuityVisible && v.selectedSessionId === ask.session;
}

/** Sessions with at least one ask still unanswered. An ask in `answered` is only holding
 *  its "Sent to …" confirmation, so it no longer makes its avatar "need" you. */
export function sessionsAwaitingAnswer(asks: Iterable<PendingAsk>, answered: Record<string, true>): Set<string> {
  const out = new Set<string>();
  for (const a of asks) if (!answered[a.id]) out.add(a.session);
  return out;
}

/** Whether an `ask-resolved` deserves a toast. A hand-off (automatic, or the card's own
 *  link) is the user already looking at the terminal, and an answer has its own done state;
 *  only a card the user could see running into the ceiling needs telling where it went. */
export function askResolvedToast(how: string, cardWasShown: boolean): boolean {
  return how === "timeout" && cardWasShown;
}

/** What an `ask-resolved` does to its card. `hold`: keep it up briefly; `answered`: it no
 *  longer makes its avatar "need" you; `note`: the remote resolution the card should name
 *  ("Answered on your phone") unless it shows its own "Sent to …"; `toast`: the timeout toast.
 *  A cancellation leaves silently. A hand-off THIS window made (the user is at the terminal)
 *  leaves at once; one this window did not make means the terminal answered it. */
export function askResolvedPlan(i: {
  how: string;
  by: ResolvedBy | null;
  shown: boolean;
  handedOffHere: boolean;
}): { hold: boolean; answered: boolean; note: ResolvedBy | null; toast: boolean } {
  const drop = { hold: false, answered: false, note: null, toast: false };
  if (i.by === "cancelled" || i.how === "cancelled") return drop;
  if (i.how === "timeout") return { ...drop, toast: askResolvedToast(i.how, i.shown) };
  if (i.how === "answered")
    return { hold: true, answered: true, note: i.by === "phone" || i.by === "desktop" ? i.by : null, toast: false };
  if (i.how === "handoff" && i.shown && !i.handedOffHere) return { ...drop, hold: true, note: "terminal" };
  return drop;
}

/** The `answers` map for ask_answer, or null while any question is unanswered. Free text
 *  (trimmed, non-empty) wins over picks; multi-select picks join in option order. */
export function buildAnswers(
  questions: AskQuestion[],
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

const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;

/** Claude marks its preferred option by appending " (Recommended)" to the label. The card
 *  shows that as a tag instead of label text. The ANSWER must still be the original label,
 *  because Claude matches its own option text. A label that is only the marker is kept. */
export function splitRecommended(label: string): { label: string; recommended: boolean } {
  if (!RECOMMENDED_SUFFIX.test(label)) return { label, recommended: false };
  const clean = label.replace(RECOMMENDED_SUFFIX, "");
  if (!clean.trim()) return { label, recommended: false };
  return { label: clean, recommended: true };
}

/** The done-state line: every answer joined with ", ", Recommended markers dropped,
 *  truncated to `max` characters with an ellipsis. */
export function answerSummary(answers: Record<string, string>, max = 60): string {
  const s = Object.values(answers)
    .flatMap((v) => v.split(MULTISELECT_JOIN))
    .map((v) => splitRecommended(v).label)
    .join(", ");
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** How long a question has waited, as m:ss (minutes are not capped at 59). */
export function waitingClock(createdMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - createdMs) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}
