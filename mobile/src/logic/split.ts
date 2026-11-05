/**
 * Tablet / wide-window layout: when the window is wide enough, the session list stays beside
 * whatever is open (a chat, a general chat, a session's files) instead of being pushed under it.
 *
 * "Wide" is measured on the WINDOW, never the device: a tablet in Android split-screen, a phone
 * in landscape and a foldable all resize the same window, and the layout follows it live.
 */

/** Below this window width (dp) the app is one column, as on a phone held upright. */
export const SPLIT_MIN_WIDTH = 720;
/** The list never gets narrower than this... */
export const LIST_MIN = 300;
/** ...nor wider than this, or than half the window. */
export const LIST_MAX = 520;
/** The right pane keeps at least this much, whatever the list asks for. */
export const DETAIL_MIN = 380;
/** A chat column wider than this reads badly; extra room becomes margin. */
export const READING_MAX = 860;

export function isSplit(windowWidth: number, enabled = true): boolean {
  return enabled && windowWidth >= SPLIT_MIN_WIDTH;
}

/** The list pane's width for a window, from the stored preference. */
export function listWidth(pref: number, windowWidth: number): number {
  const max = Math.max(LIST_MIN, Math.min(LIST_MAX, Math.floor(windowWidth / 2), windowWidth - DETAIL_MIN));
  return Math.round(Math.min(max, Math.max(LIST_MIN, pref)));
}

/** Horizontal padding that centres a reading column of at most READING_MAX in `width`. */
export function readingInset(width: number): number {
  return width > READING_MAX ? Math.floor((width - READING_MAX) / 2) : 0;
}
