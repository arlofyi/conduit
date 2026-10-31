/**
 * SF Symbol -> Material Symbol, for Android.
 *
 * expo-symbols draws SF Symbols on iOS only. Given a bare SF name on Android it renders its
 * `fallback`, which is nothing, so every icon in the app was blank there. Each SF name the
 * app uses maps to the Material Symbol that expo-symbols draws from its bundled font.
 * Where Android has its own convention the Android idiom wins (a back ARROW, a vertical
 * overflow menu) rather than a literal look-alike.
 *
 * `AppSymbol` is the ONLY type `Icon`/`GlassCircle`/`SheetRow` accept, so an icon with no
 * Android mapping fails `tsc` instead of rendering blank on Android. `satisfies` checks
 * that every key is a real SF Symbol and every value a real Material Symbol;
 * `androidSymbols.test.ts` checks the values against the font expo-symbols actually ships.
 */
import type { AndroidSymbol, SFSymbol } from "expo-symbols";

export const ANDROID_SYMBOLS = {
  "arrow.down.right.and.arrow.up.left": "close_fullscreen",
  "arrow.triangle.branch": "fork_right",
  "bubble.left.and.bubble.right": "forum",
  camera: "photo_camera",
  checkmark: "check",
  "checkmark.circle.fill": "check_circle",
  "checkmark.square.fill": "check_box",
  "chevron.down": "expand_more",
  "chevron.left": "arrow_back",
  "chevron.right": "chevron_right",
  "chevron.up": "expand_less",
  circle: "radio_button_unchecked",
  "circle.dotted": "pending",
  "circle.lefthalf.filled": "contrast",
  cpu: "memory",
  doc: "description",
  "doc.on.doc": "content_copy",
  ellipsis: "more_vert",
  eraser: "ink_eraser",
  folder: "folder",
  "gauge.with.dots.needle.33percent": "speed",
  gearshape: "settings",
  "info.circle": "info",
  laptopcomputer: "computer",
  "lock.fill": "lock",
  "paperplane.fill": "send",
  pencil: "edit",
  "person.crop.circle": "account_circle",
  paperclip: "attach_file",
  photo: "image",
  "photo.on.rectangle": "photo_library",
  plus: "add",
  "slider.horizontal.3": "tune",
  sparkles: "auto_awesome",
  square: "check_box_outline_blank",
  "square.stack": "stacks",
  "stop.circle": "stop_circle",
  "stop.fill": "stop",
  "wifi.slash": "wifi_off",
  xmark: "close",
  "xmark.circle.fill": "cancel",
} as const satisfies Partial<Record<SFSymbol, AndroidSymbol>>;

/** Every symbol the app draws: an SF Symbol name that has an Android equivalent. */
export type AppSymbol = keyof typeof ANDROID_SYMBOLS;

export function androidSymbolFor(sf: AppSymbol): AndroidSymbol {
  return ANDROID_SYMBOLS[sf];
}
