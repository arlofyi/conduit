import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PREFS, type Prefs } from "./prefs";
import { prefsStore } from "./secureBackend";

interface PrefsValue {
  prefs: Prefs;
  /** false until the stored prefs have been read (defaults render meanwhile) */
  loaded: boolean;
  setPrefs: (patch: Partial<Prefs>) => void;
}

const Ctx = createContext<PrefsValue | null>(null);

/** Per-phone preferences (notification toggles, theme), persisted in SecureStore `prefs`. */
export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setState] = useState<Prefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  // A change made before the load finishes must win over the stored value.
  const touched = useRef(false);

  useEffect(() => {
    let live = true;
    prefsStore.load().then((p) => {
      if (!live) return;
      if (!touched.current) setState(p);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    touched.current = true;
    setState((prev) => {
      const next = { ...prev, ...patch };
      prefsStore.save(next).catch(() => {
        // Keychain write failed: the change still applies for this run.
      });
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, loaded, setPrefs }), [prefs, loaded, setPrefs]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrefs(): PrefsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePrefs must be used within a PrefsProvider");
  return v;
}
