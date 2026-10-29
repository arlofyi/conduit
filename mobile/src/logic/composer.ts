/**
 * The composer's height. A multiline TextInput on iOS grows with its content but does not
 * reliably shrink again: after a send (value cleared) it kept its three-line height and showed
 * only the placeholder. So the screen owns the height and derives it here every time, from an
 * invisible mirror of the text that is measured on every change (see Composer.tsx).
 */

export interface ComposerMetrics {
  /** one line of text plus the pill's vertical padding */
  min: number;
  /** about five lines; past this the field scrolls */
  max: number;
}

/** The design size at the default text size: a 21 pt line plus 8 pt above and below. */
export const COMPOSER: ComposerMetrics = { min: 38, max: 128 };

/**
 * Metrics for the text size actually on screen. `lineHeight` is a measured ONE-line mirror
 * (null until it has been laid out); with large Dynamic Type a line is taller than 21 pt, and a
 * fixed 38 pt pill would clip it. Never smaller than the design size.
 */
export function composerMetrics(lineHeight: number | null, padV: number): ComposerMetrics {
  if (lineHeight === null || !Number.isFinite(lineHeight) || lineHeight <= 0) return COMPOSER;
  return {
    min: Math.max(COMPOSER.min, Math.ceil(lineHeight + padV * 2)),
    max: Math.max(COMPOSER.max, Math.ceil(lineHeight * 5 + padV * 2)),
  };
}

/**
 * `contentHeight` is the mirror's measured height plus padding. Empty text is ALWAYS one line:
 * a reading taken before a clear can lag a frame and still report the old height, which is
 * exactly the founder's bug. (The composer also drops its stored reading on send, so the next
 * keystroke cannot resurrect the old height either.)
 */
export function composerHeight(text: string, contentHeight: number | null, m: ComposerMetrics = COMPOSER): number {
  if (text === "" || contentHeight === null || !Number.isFinite(contentHeight)) return m.min;
  return Math.round(Math.min(m.max, Math.max(m.min, contentHeight)));
}
