import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EMPTY_SNAPSHOT, pulsesFor, type GraphSnapshot, type Pulse, type WatchedMessage } from "../continuityGraph";

const REFETCH_DEBOUNCE_MS = 750;
const MAX_LIVE_PULSES = 40;
/** A pulse's animation runs 1.4 s; it is removed on this timer, not on SVG `endEvent`,
 *  which WebKit does not reliably deliver through React. */
const PULSE_LIFETIME_MS = 1500;

/** Snapshot on open; on every `continuity-changed`, pulses NOW (against the snapshot in
 *  hand) and a debounced refetch. Nothing runs while the view is closed — the Rust watcher
 *  is the only thing alive then. */
export function useContinuityGraph(projectId: string | null, active: boolean) {
  const [snap, setSnap] = useState<GraphSnapshot>(EMPTY_SNAPSHOT);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const dropPulse = useCallback((id: string) => setPulses((p) => p.filter((x) => x.id !== id)), []);

  useEffect(() => {
    if (!active || !projectId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reapers = new Set<ReturnType<typeof setTimeout>>();
    // A snapshot from the previous project must not draw under this one's id.
    setSnap(EMPTY_SNAPSHOT);
    const fetchNow = () =>
      invoke<GraphSnapshot>("continuity_graph", { projectId })
        .then((s) => {
          if (alive) setSnap(s);
        })
        .catch(() => {
          /* keep the last good snapshot */
        });
    void fetchNow();
    const un = listen<{ messages: WatchedMessage[] }>("continuity-changed", ({ payload }) => {
      if (!alive) return;
      const fresh = pulsesFor(payload.messages, snapRef.current);
      if (fresh.length) {
        setPulses((p) => [...p, ...fresh].slice(-MAX_LIVE_PULSES));
        for (const f of fresh) {
          const t = setTimeout(() => {
            reapers.delete(t);
            if (alive) dropPulse(f.id);
          }, PULSE_LIFETIME_MS);
          reapers.add(t);
        }
      }
      clearTimeout(timer);
      timer = setTimeout(fetchNow, REFETCH_DEBOUNCE_MS);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      for (const t of reapers) clearTimeout(t);
      void un.then((f) => f());
      setPulses([]);
    };
  }, [projectId, active, dropPulse]);

  return { snap, pulses, dropPulse };
}
