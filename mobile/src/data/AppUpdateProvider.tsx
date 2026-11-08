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

/** `handedOff`: the download finished and Android's installer was opened on it. */
export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "handedOff" | "error";

export interface AppUpdateValue {
  /** false on iOS / web / a build without the native module: nothing here applies */
  available: boolean;
  installed: { build: number; version: string } | null;
  phase: UpdatePhase;
  release: MobileRelease | null;
  error: string | null;
  checkedAt: number | null;
  /** 0..1 while downloading, when the size is known */
  progress: number | null;
  check: () => Promise<void>;
  /** download the release and open the system installer */
  install: () => Promise<void>;
  /** open the installer again on the APK already downloaded (it was dismissed or hidden) */
  reopenInstaller: () => void;
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
  const [progress, setProgress] = useState<number | null>(null);
  // The APK handed to the installer, so a dismissed installer can be reopened without a
  // second download (a 50 MB APK took over 4 minutes on a tablet's Wi-Fi).
  const downloaded = useRef<string | null>(null);
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
    setProgress(null);
    setError(null);
    try {
      const dir = new Directory(Paths.cache, "updates");
      // Only ever the one APK being installed: an old download is just space.
      if (dir.exists) dir.delete();
      dir.create({ intermediates: true });
      const file = await File.downloadFileAsync(release.apkUrl, new File(dir, release.apkName), {
        onProgress: ({ bytesWritten, totalBytes }) => {
          const total = totalBytes > 0 ? totalBytes : (release.apkSize ?? 0);
          if (total > 0) setProgress(Math.min(1, bytesWritten / total));
        },
      });
      if (release.apkSize !== null && file.size !== release.apkSize) throw new Error("The download was incomplete. Try again.");
      downloaded.current = file.contentUri;
      native.install(file.contentUri);
      setPhase("handedOff");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The download failed.");
      setPhase("error");
    } finally {
      busy.current = false;
      setProgress(null);
    }
  }, [release]);

  const reopenInstaller = useCallback(() => {
    if (!AppUpdate || !downloaded.current) return;
    try {
      AppUpdate.install(downloaded.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open the installer.");
      setPhase("error");
    }
  }, []);

  const value = useMemo<AppUpdateValue>(
    () => ({ available: installed !== null, installed, phase, release, error, checkedAt, progress, check, install, reopenInstaller }),
    [installed, phase, release, error, checkedAt, progress, check, install, reopenInstaller],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppUpdate(): AppUpdateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppUpdate must be used within an AppUpdateProvider");
  return v;
}
