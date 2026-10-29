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
  theme: ThemeId;
}

export const PREFS_KEY = "prefs";

export const DEFAULT_PREFS: Prefs = {
  notifyQuestion: true,
  notifyPermission: true,
  notifyFinished: false,
  theme: DEFAULT_THEME,
};

type BoolKey = "notifyQuestion" | "notifyPermission" | "notifyFinished";

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
