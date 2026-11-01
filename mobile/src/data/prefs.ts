/** Per-phone preferences, one small JSON blob in SecureStore key `prefs`. Pure parse/merge;
 * the backend is injected (see secureBackend.ts) so this runs under jest. */

import { DEFAULT_THEME, PALETTES, type ThemeId } from "../theme/palettes";
import type { KeyValueBackend } from "./macStore";

export interface Prefs {
  /** banner when a session asks a question */
  notifyQuestion: boolean;
  /** banner when a session needs a permission */
  notifyPermission: boolean;
  /** banner when a session finishes */
  notifyFinished: boolean;
  /** a session's turn ended on an error (rate limit, sign-in, API error) */
  notifyFailed: boolean;
  /** a session that was running is stopped (desktop, phone, idle auto-stop) */
  notifyStopped: boolean;
  /** Android, screen off: the computer has been unreachable for 10 minutes while Tailscale is on */
  notifyUnreachable: boolean;
  /** mirror the computer's local web apps onto this phone's localhost (Android; Apps tab) */
  mirrorPorts: boolean;
  /** Android: the notification permission was asked for once already (never nag) */
  notifyAsked: boolean;
  /** Android: the "your phone may stop Conduit in the background" hint was dismissed */
  batteryHintDismissed: boolean;
  /** keep the last sessions list and opened chats on this phone, to read offline */
  keepChats: boolean;
  theme: ThemeId;
}

export const PREFS_KEY = "prefs";

export const DEFAULT_PREFS: Prefs = {
  notifyQuestion: true,
  notifyPermission: true,
  notifyFinished: false,
  // a failure is something to act on and rare; a stop or a lost connection is often deliberate
  // (idle auto-stop, Tailscale switched off to save battery), so those are opt-in
  notifyFailed: true,
  notifyStopped: false,
  notifyUnreachable: false,
  mirrorPorts: false,
  notifyAsked: false,
  batteryHintDismissed: false,
  keepChats: true,
  theme: DEFAULT_THEME,
};

type BoolKey =
  | "notifyQuestion"
  | "notifyPermission"
  | "notifyFinished"
  | "notifyFailed"
  | "notifyStopped"
  | "notifyUnreachable"
  | "mirrorPorts"
  | "notifyAsked"
  | "batteryHintDismissed"
  | "keepChats";

/** Unknown or wrong-typed fields fall back to their defaults one at a time; a corrupt blob
 * is the defaults. */
export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULT_PREFS;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return DEFAULT_PREFS;
  const r = o as Record<string, unknown>;
  const bool = (k: BoolKey): boolean => (typeof r[k] === "boolean" ? (r[k] as boolean) : DEFAULT_PREFS[k]);
  const theme =
    typeof r.theme === "string" && Object.prototype.hasOwnProperty.call(PALETTES, r.theme)
      ? (r.theme as ThemeId)
      : DEFAULT_PREFS.theme;
  return {
    notifyQuestion: bool("notifyQuestion"),
    notifyPermission: bool("notifyPermission"),
    notifyFinished: bool("notifyFinished"),
    notifyFailed: bool("notifyFailed"),
    notifyStopped: bool("notifyStopped"),
    notifyUnreachable: bool("notifyUnreachable"),
    mirrorPorts: bool("mirrorPorts"),
    notifyAsked: bool("notifyAsked"),
    batteryHintDismissed: bool("batteryHintDismissed"),
    keepChats: bool("keepChats"),
    theme,
  };
}

export function createPrefsStore(be: KeyValueBackend) {
  return {
    load: async (): Promise<Prefs> => {
      try {
        return parsePrefs(await be.get(PREFS_KEY));
      } catch {
        return DEFAULT_PREFS;
      }
    },
    save: (p: Prefs): Promise<void> => be.set(PREFS_KEY, JSON.stringify(p)),
  };
}

export type PrefsStore = ReturnType<typeof createPrefsStore>;
