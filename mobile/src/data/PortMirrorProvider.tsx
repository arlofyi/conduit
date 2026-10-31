/**
 * Drives the native port mirror (modules/port-mirror) from the live connection and the user's
 * switch: starts it, re-applies the port set when the computer's list changes, stops it. The
 * decisions are `mirrorPlan` (logic/ports.ts); this only carries them out.
 *
 * Mounted once, inside LiveProvider, so the mirror follows the computer's list whichever tab
 * is open. The list is refreshed every MIRROR_POLL_MS while mirroring; the Apps tab polls
 * faster on its own while it is in front.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PortMirror, type MirrorStatus } from "../../modules/port-mirror";
import { useLive } from "../bridge/LiveProvider";
import { mirrorPlan, type AppliedMirror } from "../logic/ports";
import { usePrefs } from "./PrefsProvider";

/** How often the computer's list is re-read while mirroring and the Apps tab is not open. */
export const MIRROR_POLL_MS = 30_000;

export interface PortMirrorValue {
  /** this platform has a mirror (Android) */
  available: boolean;
  /** the user's switch */
  on: boolean;
  setOn: (on: boolean) => void;
  /** the native side's own report */
  status: MirrorStatus;
  /** why the switch was turned off for the user, if it was ("unauthorized" / "stopped" / an error) */
  lastStop: string | null;
}

const IDLE: MirrorStatus = { running: false, reason: null, ports: [] };
const Ctx = createContext<PortMirrorValue | null>(null);

export function PortMirrorProvider({ children }: { children: React.ReactNode }) {
  const { webPorts, address, currentMac, hello, conn, refreshPorts } = useLive();
  const { prefs, setPrefs } = usePrefs();
  const [status, setStatus] = useState<MirrorStatus>(() => PortMirror?.status() ?? IDLE);
  const [lastStop, setLastStop] = useState<string | null>(null);
  const applied = useRef<AppliedMirror | null>(null);
  /** a stop WE asked for: its "stopped" report must not turn the user's switch off */
  const selfStop = useRef(false);
  const busy = useRef(false);

  const on = prefs.mirrorPorts && PortMirror !== null;
  const setOn = useCallback(
    (v: boolean) => {
      if (v) setLastStop(null);
      setPrefs({ mirrorPorts: v });
    },
    [setPrefs],
  );

  useEffect(() => {
    if (!PortMirror) return;
    const sub = PortMirror.addListener("onStatus", (s) => {
      setStatus(s);
      if (s.running) return;
      applied.current = null;
      if (selfStop.current) {
        selfStop.current = false;
        return;
      }
      // Stopped from outside: the notification's Stop, or the computer refused the token.
      // Turn the switch off so it is not started straight back up.
      if (s.reason === "stopped" || s.reason === "unauthorized") {
        setLastStop(s.reason);
        setPrefs({ mirrorPorts: false });
      }
    });
    return () => sub.remove();
  }, [setPrefs]);

  // Keep the list fresh while mirroring, so a dev server started later is mirrored too.
  const ready = conn.phase === "ready";
  useEffect(() => {
    if (!on || !ready) return;
    refreshPorts();
    const t = setInterval(refreshPorts, MIRROR_POLL_MS);
    return () => clearInterval(t);
  }, [on, ready, refreshPorts]);

  const token = currentMac?.token || null;
  const computer = hello?.macName ?? currentMac?.macName ?? "";
  useEffect(() => {
    const native = PortMirror;
    if (!native || busy.current) return;
    const plan = mirrorPlan({
      want: on,
      view: webPorts,
      address,
      token,
      running: status.running,
      applied: applied.current,
    });
    if (plan.kind === "none") return;
    busy.current = true;
    if (plan.kind === "stop") selfStop.current = status.running;
    const run =
      plan.kind === "stop"
        ? native.stop().then(() => {
            applied.current = null;
          })
        : native
            .start({ url: plan.applied.url, token: plan.applied.token, computer, ports: plan.applied.ports })
            .then(() => {
              applied.current = plan.applied;
              // The service reports `running` a moment later; until then this IS running, or
              // the next render would start it again.
              setStatus((s) => ({ ...s, running: true, reason: null }));
            });
    run
      .catch((e: unknown) => {
        applied.current = null;
        setLastStop(e instanceof Error ? e.message : String(e));
        setPrefs({ mirrorPorts: false });
      })
      .finally(() => {
        busy.current = false;
      });
  }, [on, webPorts, address, token, computer, status.running, setPrefs]);

  // A different computer (or a forgotten one): nothing of the old one may stay mirrored.
  const macId = currentMac?.deviceId ?? null;
  const prevMac = useRef(macId);
  useEffect(() => {
    if (prevMac.current === macId) return;
    prevMac.current = macId;
    if (PortMirror && (status.running || applied.current)) {
      selfStop.current = true;
      applied.current = null;
      PortMirror.stop().catch(() => {});
    }
  }, [macId, status.running]);

  const value = useMemo(
    () => ({ available: PortMirror !== null, on, setOn, status, lastStop }),
    [on, setOn, status, lastStop],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePortMirror(): PortMirrorValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePortMirror must be used within a PortMirrorProvider");
  return v;
}
