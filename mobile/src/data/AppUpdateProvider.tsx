/**
 * In-app updates from GitHub Releases (Android). Checks once at launch and when the app comes
 * back to the front (at most every AUTO_CHECK_EVERY_MS, and only with the `updateCheck` pref on),
 * or whenever Settings' button asks. An update is downloaded into the app's cache and handed to
 * the system installer, which asks the user and refuses an APK signed with any other key.
 *
 * The request goes to api.github.com with no token and no identifying header beyond a generic
 * client name; it reveals only that some Conduit phone asked.
 */
import { Directory, File, Paths } from "expo-file-system";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { AppUpdate } from "../../modules/app-update";
import { AUTO_CHECK_EVERY_MS, RELEASES_URL, newerRelease, parseReleases, type MobileRelease } from "../logic/update";
import { usePrefs } from "./PrefsProvider";

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "error";

export interface AppUpdateValue {
  /** false on iOS / web / a build without the native module: nothing here applies */
  available: boolean;
  installed: { build: number; version: string } | null;
  phase: UpdatePhase;
  release: MobileRelease | null;
  error: string | null;
  checkedAt: number | null;
  check: () => Promise<void>;
  /** download the release and open the system installer */
  install: () => Promise<void>;
}

const Ctx = createContext<AppUpdateValue | null>(null);

function installedInfo(): { build: number; version: string } | null {
  if (!AppUpdate) return null;
  try {
    return { build: AppUpdate.versionCode(), version: AppUpdate.versionName() };
  } catch {
    return null;
  }
}

export function AppUpdateProvider({ children }: { children: React.ReactNode }) {
  const { prefs, loaded } = usePrefs();
  const installed = useMemo(installedInfo, []);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [release, setRelease] = useState<MobileRelease | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const busy = useRef(false);
  const lastAuto = useRef(0);

  const check = useCallback(async () => {
    if (!installed || busy.current) return;
    busy.current = true;
    setPhase("checking");
    setError(null);
    try {
      const res = await fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "conduit-mobile" } });
      if (!res.ok) throw new Error(res.status === 403 ? "GitHub is limiting requests; try again in a while." : `GitHub answered ${res.status}.`);
      const next = newerRelease(parseReleases(await res.json()), installed.build);
      setRelease(next);
      setPhase(next ? "available" : "current");
      setCheckedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach GitHub.");
      setPhase("error");
    } finally {
      busy.current = false;
    }
  }, [installed]);

  // Automatic checks: at launch and on return to the front, rate-limited.
  useEffect(() => {
    if (!installed || !loaded || !prefs.updateCheck) return;
    const maybe = () => {
      if (Date.now() - lastAuto.current < AUTO_CHECK_EVERY_MS) return;
      lastAuto.current = Date.now();
      void check();
    };
    maybe();
    const sub = AppState.addEventListener("change", (s) => s === "active" && maybe());
    return () => sub.remove();
  }, [installed, loaded, prefs.updateCheck, check]);

  const install = useCallback(async () => {
    const native = AppUpdate;
    if (!native || !release || busy.current) return;
    if (!native.canInstall()) {
      // Android asks once, on its own settings page; the user comes back and taps Update again.
      setError("Allow Conduit to install apps on the page that just opened, then come back and tap Update again.");
      native.openInstallSettings();
      return;
    }
    busy.current = true;
    setPhase("downloading");
    setError(null);
    try {
      const dir = new Directory(Paths.cache, "updates");
      // Only ever the one APK being installed: an old download is just space.
      if (dir.exists) dir.delete();
      dir.create({ intermediates: true });
      const file = await File.downloadFileAsync(release.apkUrl, new File(dir, release.apkName));
      if (release.apkSize !== null && file.size !== release.apkSize) throw new Error("The download was incomplete. Try again.");
      native.install(file.contentUri);
      setPhase("available");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The download failed.");
      setPhase("error");
    } finally {
      busy.current = false;
    }
  }, [release]);

  const value = useMemo<AppUpdateValue>(
    () => ({ available: installed !== null, installed, phase, release, error, checkedAt, check, install }),
    [installed, phase, release, error, checkedAt, check, install],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppUpdate(): AppUpdateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppUpdate must be used within an AppUpdateProvider");
  return v;
}
