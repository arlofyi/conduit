import { describe, expect, it } from "vitest";
import {
  canOpenCanvas, effectiveCenterMode, modeAllowed, readViewPref, resolveCenterMode, toggledMode,
  type ViewPrefs,
} from "./centerViews";

const ALL: ViewPrefs = { canvasEnabled: true, boardEnabled: true, continuityViewEnabled: true };
const DEFAULTS: ViewPrefs = { canvasEnabled: false, boardEnabled: false, continuityViewEnabled: true };

describe("center views", () => {
  it("terminals is always allowed", () => {
    expect(modeAllowed("terminals", { canvasEnabled: false, boardEnabled: false, continuityViewEnabled: false })).toBe(true);
  });
  it("a disabled mode resolves to terminals", () => {
    expect(resolveCenterMode("board", DEFAULTS)).toBe("terminals");
    expect(resolveCenterMode("continuity", DEFAULTS)).toBe("continuity");
  });
  it("toggling the open mode returns to terminals; toggling another switches", () => {
    expect(toggledMode("board", "board", ALL)).toBe("terminals");
    expect(toggledMode("board", "continuity", ALL)).toBe("continuity");
    expect(toggledMode("terminals", "board", DEFAULTS)).toBe("terminals");
  });
  it("a stored mode whose pref was turned off renders as terminals", () => {
    expect(effectiveCenterMode("board", DEFAULTS)).toBe("terminals");
    expect(effectiveCenterMode(undefined, ALL)).toBe("terminals");
    expect(effectiveCenterMode("continuity", ALL)).toBe("continuity");
  });
  it("the canvas needs its pref and the main window", () => {
    expect(canOpenCanvas(DEFAULTS, false)).toBe(false);
    expect(canOpenCanvas(ALL, false)).toBe(true);
    expect(canOpenCanvas(ALL, true)).toBe(false);
  });
  it("pref readers default correctly and survive a throwing storage", () => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readViewPref("k1", false, ls)).toBe(false);
    expect(readViewPref("k2", true, ls)).toBe(true);
    store.set("k1", "1"); store.set("k2", "0");
    expect(readViewPref("k1", false, ls)).toBe(true);
    expect(readViewPref("k2", true, ls)).toBe(false);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => {} };
    expect(readViewPref("k3", true, broken)).toBe(true);
    expect(readViewPref("k4", false, broken)).toBe(false);
  });
});
