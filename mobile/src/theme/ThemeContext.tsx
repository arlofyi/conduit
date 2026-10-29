import React, { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { Appearance } from "react-native";
import { usePrefs } from "../data/PrefsProvider";
import { nextTheme, PALETTES, type Palette, type ThemeId } from "./palettes";

interface ThemeContextValue {
  themeId: ThemeId;
  palette: Palette;
  /** advance to the next of the three Warm schemes (persisted in prefs) */
  cycle: () => void;
  setTheme: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Theme lives in the persisted prefs blob; must sit inside a PrefsProvider. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { prefs, setPrefs } = usePrefs();
  const themeId = prefs.theme;
  const setTheme = useCallback((id: ThemeId) => setPrefs({ theme: id }), [setPrefs]);
  const cycle = useCallback(() => setPrefs({ theme: nextTheme(themeId) }), [setPrefs, themeId]);
  const value = useMemo<ThemeContextValue>(
    () => ({ themeId, palette: PALETTES[themeId], cycle, setTheme }),
    [themeId, cycle, setTheme],
  );
  // Native chrome (Liquid Glass sheets and tab bar, system materials, the keyboard) follows the
  // app's appearance, not the phone's: a dark Warm theme under a light system would otherwise
  // get pale glass with the theme's pale text on it.
  const appearance = PALETTES[themeId].appearance;
  useEffect(() => {
    Appearance.setColorScheme(appearance);
  }, [appearance]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
