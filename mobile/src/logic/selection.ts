/**
 * Multi-select on the Chats list (long-press a row, then tap to add or remove). Pure.
 *
 * The phone sends ONE `sessionaction` for the whole selection; the desktop runs its own
 * stop/delete for each session it may act on and reports the rest as skipped.
 */

export type SessionAction = "stop" | "delete";
export type Skipped = { id: string; reason: string };
export type ActionResult = { ok: true; done: string[]; skipped: Skipped[] } | { ok: false; error: string };

/** Add or remove one id. */
export function toggle(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Drop ids no longer on screen (a session deleted elsewhere, a filter change). Same set
 * back when nothing changed, so a re-render does not cascade. */
export function prune(sel: ReadonlySet<string>, visible: readonly string[]): ReadonlySet<string> {
  const on = new Set(visible);
  let changed = false;
  const next = new Set<string>();
  for (const id of sel) {
    if (on.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : sel;
}

/** The confirmation for an action, or null when none is needed (stopping idle sessions). */
export function confirmText(action: SessionAction, count: number, running: number): { title: string; body: string } | null {
  const n = count === 1 ? "this session" : `these ${count} sessions`;
  if (action === "delete") {
    return {
      title: count === 1 ? "Delete this session?" : `Delete ${count} sessions?`,
      body:
        (running > 0 ? `${running === 1 ? "One is" : `${running} are`} still working and will be stopped. ` : "") +
        "Conversation history stays on your computer, and so does any worktree folder.",
    };
  }
  if (running === 0) return null;
  return {
    title: `Stop ${n}?`,
    body: `${running === 1 ? "One is" : `${running} are`} working right now; stopping ends the current turn. Open a session again to resume it.`,
  };
}

/** One line for after the action. */
export function resultText(action: SessionAction, r: ActionResult): string {
  if (!r.ok) return r.error;
  const verb = action === "delete" ? "Deleted" : "Stopped";
  const done = r.done.length === 1 ? "1 session" : `${r.done.length} sessions`;
  if (r.skipped.length === 0) return `${verb} ${done}.`;
  const why = [...new Set(r.skipped.map((s) => s.reason))].join(", ");
  return `${verb} ${done}. Skipped ${r.skipped.length} (${why}).`;
}
