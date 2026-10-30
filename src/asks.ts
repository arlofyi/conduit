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

/** Where the user is looking (see askHandoff.ts `handOffView`). */
export type HandOffView = { selectedSessionId: string | null; continuityVisible: boolean; windowFocused: boolean };

/** The session whose terminal is in front of the user: the selected one, while a Conduit
 *  window is focused and the Continuity graph is not covering it; else null. Sent to Rust
 *  with the gate (`set_ask_gate`), where the hook decides — once, when Claude asks —
 *  whether that session's question needs a card at all (hooks.rs `holder_for`). */
export function focusedTerminal(v: HandOffView): string | null {
  return v.windowFocused && !v.continuityVisible ? v.selectedSessionId : null;
}

export function terminalInFront(item: { session: string }, v: HandOffView): boolean {
  return focusedTerminal(v) === item.session;
}

/** The permission cards worth drawing. Claude's own dialog is already up in every
 *  session's terminal, so a permission for the terminal in front of the user is HIDDEN —
 *  never resolved: it comes back when the user looks away, and the terminal stays the one
 *  place to answer it meanwhile. (A question is never hidden: while a hook holds it the
 *  terminal shows no menu, so the card is the only way to answer it on the Mac.) */
export function permissionsToShow<P extends { session: string }>(list: P[], v: HandOffView): P[] {
  return list.filter((p) => !terminalInFront(p, v));
}

/** Sessions with at least one ask still unanswered. An ask in `answered` is only holding
 *  its "Sent to …" confirmation, so it no longer makes its avatar "need" you. */
export function sessionsAwaitingAnswer(asks: Iterable<PendingAsk>, answered: Record<string, true>): Set<string> {
  const out = new Set<string>();
  for (const a of asks) if (!answered[a.id]) out.add(a.session);
  return out;
}

/** Whether an `ask-resolved` deserves a toast. A hand-off (the card's own link, Esc in the
 *  terminal, the last phone leaving) and an answer each have their own done state; only a
 *  card the user could see running into the ceiling needs telling where it went. */
export function askResolvedToast(how: string, cardWasShown: boolean): boolean {
  return how === "timeout" && cardWasShown;
}

/** What an `ask-resolved` does to its card. `hold`: keep it up briefly; `answered`: it no
 *  longer makes its avatar "need" you; `note`: the remote resolution the card should name
 *  ("Answered on your phone") unless it shows its own "Sent to …"; `toast`: the timeout toast.
 *  A cancellation leaves silently. A hand-off THIS window made (the user is at the terminal)
 *  leaves at once; one another side made (Esc in the terminal, another window, the last
 *  phone leaving) is held with note `terminal`, which an ask card reads as "Moved to the
 *  terminal" — a hand-off answers nothing. */
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
