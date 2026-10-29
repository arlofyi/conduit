/** Tool-permission cards and "who answered it": pure rules shared by the question card
 *  (AskCard) and the permission card (PermissionCard). Rust holds both open (asks.rs,
 *  broker.rs); whoever answers first wins, and `by` says who that was. */

/** Who resolved a held question or permission (Rust's `asks::By`, lowercase on the wire). */
export type ResolvedBy = "phone" | "desktop" | "terminal" | "timeout" | "cancelled";

/** A tool permission held open by Rust (`PermissionView`). The raw tool input never leaves
 *  Rust; `summary` is the one line it chose to show. */
export type PendingPermission = { id: string; session: string; toolName: string; summary: string; createdMs: number };

const BY: readonly ResolvedBy[] = ["phone", "desktop", "terminal", "timeout", "cancelled"];

/** Read `by` strictly: an unknown value is "unknown", never a guess. */
export function parseBy(v: unknown): ResolvedBy | null {
  return typeof v === "string" && (BY as readonly string[]).includes(v) ? (v as ResolvedBy) : null;
}

/** Where it was answered, as this Mac's card says it. A card's OWN answer never reaches
 *  this (it shows its own confirmation), so "desktop" here is another Conduit window.
 *  A cancellation (the turn moved on) is removed silently: null. */
export function resolvedCopy(by: ResolvedBy | null): string | null {
  switch (by) {
    case "phone":
      return "Answered on your phone";
    case "terminal":
      return "Answered in the terminal";
    case "timeout":
      return "Moved to the terminal";
    case "desktop":
      return "Answered in another Conduit window";
    default:
      return null;
  }
}

/** The note on a card whose own answer came back `false` (someone got there first). */
export function alreadyAnsweredCopy(by: ResolvedBy | null): string {
  switch (by) {
    case "phone":
      return "Already answered on your phone.";
    case "terminal":
      return "Already answered in the terminal.";
    case "desktop":
      return "Already answered in another Conduit window.";
    case "timeout":
      return "It moved to the terminal.";
    default:
      return "Already answered.";
  }
}

/** Which remote resolution a still-open card should show, if any. Rust resolves and emits
 *  `by: "desktop"` BEFORE the card's own invoke returns, so while this card is sending, a
 *  desktop resolution is its own answer and must not read as "another window". */
export function remoteNote(by: ResolvedBy | null, sendingHere: boolean): ResolvedBy | null {
  if (!by || by === "cancelled") return null;
  if (by === "desktop" && sendingHere) return null;
  return by;
}

/** Whether a resolved card stays up for a moment (to say where it went) or leaves at once.
 *  Cancelled, unknown and never-shown cards leave at once. */
export function resolutionHold(by: ResolvedBy | null, shown: boolean): boolean {
  return shown && by !== null && by !== "cancelled";
}

/** What this Mac's own Allow/Deny achieved. `permission_respond -> true` means Conduit's
 *  answer reached Claude's hook, NOT that the tool was stopped: if the user already pressed
 *  Yes in the terminal, a later Deny changes nothing. Never claim more than that. */
export function permissionOutcomeCopy(allow: boolean): { title: string; detail?: string } {
  return allow
    ? { title: "Allowed" }
    : { title: "Denied", detail: "If you'd already allowed it in the terminal, it keeps running." };
}

/** Oldest first: the one that has waited longest is the one docked on top. */
export function sortPermissions(list: PendingPermission[]): PendingPermission[] {
  return [...list].sort((a, b) => a.createdMs - b.createdMs);
}
