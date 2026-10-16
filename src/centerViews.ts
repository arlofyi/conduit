/** Which center overlay a project shows, and which of them the user has switched on.
 *  Store-free on purpose (store.ts touches localStorage at module scope and cannot be
 *  imported under the node-env vitest). Every overlay sits over still-mounted terminals —
 *  none may unmount or reparent a TerminalView. The global canvas is not a CenterMode (it
 *  belongs to no project), but it is mutually exclusive with every non-terminals mode. */

export type CenterMode = "terminals" | "board" | "continuity";

export type ViewPrefs = {
  canvasEnabled: boolean;
  boardEnabled: boolean;
  continuityViewEnabled: boolean;
};

export const CANVAS_ENABLED_KEY = "conduit.canvasEnabled";
export const BOARD_ENABLED_KEY = "conduit.boardEnabled";
export const CONTINUITY_VIEW_ENABLED_KEY = "conduit.continuityViewEnabled";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Default-off prefs are on only when "1"; default-on prefs are off only when "0". */
export function readViewPref(key: string, defaultOn: boolean, ls: Storage = localStorage): boolean {
  try {
    const v = ls.getItem(key);
    return defaultOn ? v !== "0" : v === "1";
  } catch {
    return defaultOn;
  }
}

export function writeViewPref(key: string, on: boolean, ls: Storage = localStorage): void {
  try {
    ls.setItem(key, on ? "1" : "0");
  } catch {
    /* quota — non-fatal */
  }
}

export function modeAllowed(mode: CenterMode, prefs: ViewPrefs): boolean {
  if (mode === "board") return prefs.boardEnabled;
  if (mode === "continuity") return prefs.continuityViewEnabled;
  return true;
}

export function resolveCenterMode(requested: CenterMode, prefs: ViewPrefs): CenterMode {
  return modeAllowed(requested, prefs) ? requested : "terminals";
}

export function toggledMode(current: CenterMode, target: CenterMode, prefs: ViewPrefs): CenterMode {
  return current === target ? "terminals" : resolveCenterMode(target, prefs);
}

/** What actually renders: a stored mode whose pref has since been turned off is terminals. */
export function effectiveCenterMode(stored: CenterMode | undefined, prefs: ViewPrefs): CenterMode {
  return resolveCenterMode(stored ?? "terminals", prefs);
}

export function canOpenCanvas(prefs: ViewPrefs, secondaryWindow: boolean): boolean {
  return prefs.canvasEnabled && !secondaryWindow;
}
