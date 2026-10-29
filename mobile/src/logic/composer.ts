/**
 * The composer's height. A multiline TextInput on iOS grows with its content but does not
 * reliably shrink again: after a send (value cleared) it kept its three-line height and showed
 * only the placeholder. So the screen owns the height and derives it here every time.
 */

export interface ComposerMetrics {
  /** one line of text plus the pill's vertical padding */
  min: number;
  /** about five lines; past this the field scrolls */
  max: number;
}

export const COMPOSER: ComposerMetrics = { min: 38, max: 128 };

/**
 * `contentHeight` is the last `onContentSizeChange` reading plus padding. Empty text is ALWAYS
 * one line: the native reading after a clear can lag a frame and still report the old height,
 * which is exactly the founder's bug. (The screen also drops its stored reading on send, so the next
 * keystroke cannot resurrect the old height either.)
 */
export function composerHeight(text: string, contentHeight: number | null, m: ComposerMetrics = COMPOSER): number {
  if (text === "" || contentHeight === null || !Number.isFinite(contentHeight)) return m.min;
  return Math.round(Math.min(m.max, Math.max(m.min, contentHeight)));
}
