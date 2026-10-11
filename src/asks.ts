/** AskUserQuestion cards: pure rules. The Rust side holds the question open (asks.rs);
 *  this decides when a card may capture one and when to give it back to the terminal. */
import { MULTISELECT_JOIN } from "./askProtocol";

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
