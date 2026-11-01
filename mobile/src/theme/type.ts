import { Platform } from "react-native";

/**
 * Type scale aligned to Apple's Human Interface Guidelines text styles (points).
 * React Native font sizes are density-independent and map ~1:1 to iOS points.
 * Floor is 11pt (HIG Caption 2); body/headline is 17pt.
 */
export const TYPE = {
  largeTitle: 32,
  title: 28,
  title3: 20,
  headline: 17,
  body: 17,
  callout: 16,
  subhead: 15,
  footnote: 13,
  caption: 12,
  micro: 11,
} as const;

/** Minimum comfortable touch target per Apple HIG (points). */
export const MIN_TOUCH = 44;

/** System monospace face for code/paths. */
export const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * Bottom padding for a scroll view inside a TAB screen, so its last rows clear the tab bar.
 * The native tab bar draws OVER the screen on Android (Material's navigation bar, 80 dp plus the
 * gesture inset) and `contentInsetAdjustmentBehavior` only adjusts on iOS, so Settings' last
 * card sat behind the bar. iOS keeps its plain padding: the automatic inset already clears it.
 */
export function tabBarClearance(base: number, bottomInset: number, os: string): number {
  return os === "android" ? base + ANDROID_TAB_BAR_HEIGHT + bottomInset : base;
}

/** Material 3 navigation bar height, without the system gesture inset below it. */
export const ANDROID_TAB_BAR_HEIGHT = 80;
