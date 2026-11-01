/**
 * Notifications with the screen off (Android): hands the computer connection to the native
 * background watcher (modules/bg-watch) as the app leaves the screen, takes it back when the app
 * returns, routes a tapped notification to its chat, and owns the notification permission and
 * battery-restriction state Settings shows. The decisions are in logic/watch.ts.
 *
 * Hand-over order matters both ways. Leaving: the watcher connects FIRST, then the app's socket
 * closes (LiveProvider waits on `setBackgroundHandover`). Returning: the app's socket is ready
 * FIRST, then the watcher stops. Either way there is always one socket registered as this phone,
 * so the computer keeps holding questions for it instead of handing them to the terminal.
 *
 * iOS (no module): every value reads "unavailable" and nothing here does anything.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { BgWatch, type WatchStatus } from "../../modules/bg-watch";
import { setBackgroundHandover, useLive } from "../bridge/LiveProvider";
import {
  anyNotify,
  HANDBACK_MAX_MS,
  handoverSettled,
  openTargetOf,
  shouldStopWatching,
  shouldWatch,
  watchAddresses,
  watchBaseline,
  type WatchTarget,
} from "../logic/watch";
import { usePrefs } from "./PrefsProvider";
import { diag } from "./diagnostics";

export interface BgWatchValue {
  /** this platform has a background watcher (Android) */
  available: boolean;
  /** notifications may be shown (permission granted and not switched off for the app) */
  notificationsAllowed: boolean;
  /** the system may stop Conduit in the background (battery optimization applies to it) */
  batteryRestricted: boolean;
  /** ask for the notification permission (or open the app's notification settings when Android
   * will no longer ask); resolves with whether notifications are allowed now */
  requestNotifications: () => Promise<boolean>;
  openBatterySettings: () => void;
  /** the user pressed Stop on the watcher's notification: it stays off on the next background
   * until a Notify switch is changed (in memory; a fresh app start watches again) */
  stoppedByUser: boolean;
  /** clear `stoppedByUser`: the watcher takes over again on the next background */
  resumeWatching: () => void;
  /** a tapped notification's chat, until `consumeOpenTarget` */
  openTarget: WatchTarget | null;
  consumeOpenTarget: () => void;
}

const IDLE: WatchStatus = { running: false, phase: "stopped", reason: null };
const Ctx = createContext<BgWatchValue | null>(null);

export function BgWatchProvider({ children }: { children: React.ReactNode }) {
  const native = BgWatch;
  const { currentMac, conn, address, hello, view, pending } = useLive();
  const { prefs, loaded: prefsLoaded, setPrefs } = usePrefs();
  const [status, setStatus] = useState<WatchStatus>(() => native?.status() ?? IDLE);
  const [notificationsAllowed, setNotificationsAllowed] = useState(() => native?.notificationsEnabled() ?? false);
  const [batteryRestricted, setBatteryRestricted] = useState(() => native?.batteryRestricted() ?? false);
  const [openTarget, setOpenTarget] = useState<WatchTarget | null>(null);
  // Only the notification's Stop reports reason "stopped" (our own stop leaves it null).
  const [stoppedByUser, setStoppedByUser] = useState(() => {
    const st = native?.status();
    return !!st && !st.running && st.reason === "stopped";
  });
  const stoppedByUserRef = useRef(stoppedByUser);
  stoppedByUserRef.current = stoppedByUser;
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const foregroundAt = useRef(Date.now());
  /** a permission dialog we opened is in front: that background is not a real one */
  const asking = useRef(false);

  const refreshPlatform = useCallback(() => {
    if (!native) return;
    setNotificationsAllowed(native.notificationsEnabled());
    setBatteryRestricted(native.batteryRestricted());
  }, [native]);

  const takeTarget = useCallback(() => {
    const t = openTargetOf(native?.takeOpenTarget() ?? null);
    if (t) setOpenTarget(t);
  }, [native]);

  useEffect(() => {
    if (!native) return;
    const s1 = native.addListener("onStatus", (st) => {
      setStatus(st);
      // stopped by itself: the computer refused the token, a protocol mismatch, or the
      // notification's Stop (only the first two are problems)
      if (!st.running && st.reason) diag.info("bgwatch", "stopped", st.reason);
      if (!st.running && st.reason === "stopped") setStoppedByUser(true);
    });
    const s2 = native.addListener("onOpen", takeTarget);
    takeTarget(); // a cold start from a notification
    return () => {
      s1.remove();
      s2.remove();
    };
  }, [native, takeTarget]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      const fg = s === "active";
      if (fg) {
        foregroundAt.current = Date.now();
        refreshPlatform(); // back from system settings, perhaps
        takeTarget();
      }
      setForeground(fg);
    });
    return () => sub.remove();
  }, [refreshPlatform, takeTarget]);

  // Everything the hand-over reads, current at the moment the app leaves the screen.
  const latest = useRef({ prefs, currentMac, conn, address, hello, view, pending });
  latest.current = { prefs, currentMac, conn, address, hello, view, pending };

  // Changing any Notify switch is the user asking for notifications again.
  const notifyKey = [
    prefs.notifyQuestion,
    prefs.notifyPermission,
    prefs.notifyFinished,
    prefs.notifyFailed,
    prefs.notifyStopped,
    prefs.notifyUnreachable,
  ].join("|");
  const prevNotifyKey = useRef(notifyKey);
  useEffect(() => {
    if (prevNotifyKey.current === notifyKey) return;
    prevNotifyKey.current = notifyKey;
    setStoppedByUser(false);
  }, [notifyKey]);

  useEffect(() => {
    if (!native) return;
    setBackgroundHandover(() => {
      // Stopped from its notification: do not start it straight back up on the next background.
      if (stoppedByUserRef.current) return null;
      const s = latest.current;
      const token = s.currentMac?.token || null;
      const addresses = watchAddresses(s.address, s.conn.addresses);
      const ok = shouldWatch({
        available: true,
        prefs: s.prefs,
        token,
        addresses,
        notificationsAllowed: native.notificationsEnabled(),
        asking: asking.current,
      });
      if (!ok || !token) return null;
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          sub.remove();
          resolve();
        };
        const sub = native.addListener("onStatus", (st) => {
          if (handoverSettled(st.phase)) finish();
        });
        native
          .start({
            addresses,
            token,
            computer: s.hello?.macName ?? s.currentMac?.macName ?? "",
            notifyQuestion: s.prefs.notifyQuestion,
            notifyPermission: s.prefs.notifyPermission,
            notifyFinished: s.prefs.notifyFinished,
            notifyFailed: s.prefs.notifyFailed,
            notifyStopped: s.prefs.notifyStopped,
            notifyUnreachable: s.prefs.notifyUnreachable,
            baseline: JSON.stringify(watchBaseline(s.view, s.pending)),
          })
          .then(
            () => {
              // already running and connected (an update): nothing to wait for
              if (handoverSettled(native.status().phase)) finish();
            },
            (e: unknown) => {
              // e.g. ERR_BG_WATCH_START: Android refused a foreground start from the background
              diag.error("bgwatch", "start.refused", e);
              finish();
            },
          );
      });
    });
    return () => setBackgroundHandover(null);
  }, [native]);

  // Back in front: stop the watcher once the app's own socket is up (or the wait ran out).
  const token = currentMac?.token || null;
  const wanted = anyNotify(prefs) && !!token;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!native) return;
    const since = Date.now() - foregroundAt.current;
    const stop = shouldStopWatching({
      foreground,
      wanted,
      running: status.running,
      connPhase: conn.phase,
      sinceForegroundMs: since,
    });
    if (stop) {
      native.stop().catch((e: unknown) => diag.warn("bgwatch", "stop.failed", e));
      return;
    }
    if (foreground && status.running) {
      const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, HANDBACK_MAX_MS - since) + 50);
      return () => clearTimeout(t);
    }
    // `tick` re-runs this once the hand-back wait has run out, so the watcher is stopped even
    // when the app's own socket never came up.
  }, [native, foreground, wanted, status.running, conn.phase, tick]);

  // A different computer (or a forgotten one): the watcher must not stay on the old one.
  const macId = currentMac?.deviceId ?? null;
  const prevMac = useRef(macId);
  useEffect(() => {
    if (prevMac.current === macId) return;
    prevMac.current = macId;
    if (native && status.running) native.stop().catch((e: unknown) => diag.warn("bgwatch", "stop.failed", e));
  }, [native, macId, status.running]);

  const requestNotifications = useCallback(async (): Promise<boolean> => {
    if (!native || Platform.OS !== "android") return false;
    if (native.notificationsEnabled()) {
      setNotificationsAllowed(true);
      return true;
    }
    let answer: string | null = null;
    if (Platform.Version >= 33) {
      asking.current = true;
      try {
        answer = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      } catch (e) {
        diag.warn("bgwatch", "permission.requestFailed", e);
        answer = null;
      } finally {
        asking.current = false;
      }
    }
    const allowed = native.notificationsEnabled();
    // Android will not ask again (or never asks, before 13), or the permission is granted but
    // notifications are switched off for the app: only its settings page can change that.
    if (!allowed && answer !== PermissionsAndroid.RESULTS.DENIED) native.openNotificationSettings();
    setNotificationsAllowed(allowed);
    return allowed;
  }, [native]);

  // Ask once, the first time the app is in front, connected, with a Notify switch on (they are
  // on by default, so waiting for a switch to be flipped would never ask most people).
  useEffect(() => {
    if (!native || !prefsLoaded || prefs.notifyAsked || notificationsAllowed) return;
    if (!foreground || conn.phase !== "ready" || !anyNotify(prefs)) return;
    setPrefs({ notifyAsked: true });
    requestNotifications().catch(() => {});
  }, [native, prefsLoaded, prefs, notificationsAllowed, foreground, conn.phase, setPrefs, requestNotifications]);

  const openBatterySettings = useCallback(() => {
    native?.openBatterySettings();
  }, [native]);
  const consumeOpenTarget = useCallback(() => setOpenTarget(null), []);
  const resumeWatching = useCallback(() => setStoppedByUser(false), []);

  const value = useMemo<BgWatchValue>(
    () => ({
      available: native !== null,
      notificationsAllowed,
      batteryRestricted,
      requestNotifications,
      openBatterySettings,
      stoppedByUser,
      resumeWatching,
      openTarget,
      consumeOpenTarget,
    }),
    [native, notificationsAllowed, batteryRestricted, requestNotifications, openBatterySettings, stoppedByUser, resumeWatching, openTarget, consumeOpenTarget],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBgWatch(): BgWatchValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBgWatch must be used within a BgWatchProvider");
  return v;
}
