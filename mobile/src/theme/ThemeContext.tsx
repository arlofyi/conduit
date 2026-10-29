import React, { createContext, useCallback, useContext, useMemo } from "react";
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
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
