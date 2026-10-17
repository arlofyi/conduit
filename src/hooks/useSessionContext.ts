import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";

/**
 * Keeps `sessionContext` fed for every project's sessions, including global canvas cards.
 *
 * The number lives in each session's Claude transcript, which is a file on disk — so this
 * is a read, not a subscription, and the interesting question is only *when* to read.
 * Three moments cover it:
 *
 * - **On a turn ending** (`stop`): the point at which the fill actually changes, and the
 *   moment someone is most likely to look.
 * - **While a turn runs**, on a slow interval, so a long turn's meter creeps up instead of
 *   jumping at the end. Only for sessions that are actually `running` — an idle session's
 *   transcript cannot change under us.
 * - **Once when the project's sessions appear**, which is also what restores every meter
 *   after an app restart. Nothing is persisted precisely because this read is cheap and the
 *   file is the truth.
 */
const RUNNING_POLL_MS = 15_000;

export function useSessionContext(): void {
  const projects = useStore((s) => s.projects);
  // Session ids, as a stable string so the effects below re-run when
  // the membership changes rather than on every store write.
  const ids = projects.flatMap((p) => p.sessions.map((s) => s.id));
  const idsKey = ids.join(",");

  // Read once whenever session membership changes — covers app start and new sessions.
  useEffect(() => {
    if (!idsKey) return;
    const { refreshSessionContext } = useStore.getState();
    for (const id of idsKey.split(",")) void refreshSessionContext(id);
  }, [idsKey]);

  // A turn ended: re-read that session. Scoped to the hook stream rather than a timer so an
  // idle app does no work at all.
  const idsRef = useRef(idsKey);
  idsRef.current = idsKey;
  useEffect(() => {
    const unlisten = listen<{ session: string; event: string }>("hook", ({ payload }) => {
      if (payload.event !== "stop" && payload.event !== "precompact") return;
      // `precompact` matters as much as `stop`: a compaction is the one event that makes
      // the meter go DOWN, and a stale full meter is exactly when someone acts on it.
      void useStore.getState().refreshSessionContext(payload.session);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("agycontext", ({ payload }) => {
      void useStore.getState().refreshSessionContext(payload);
    });
    return () => { void unlisten.then((f) => f()); };
  }, []);

  // Creep the meter up during a long turn.
  useEffect(() => {
    if (!idsKey) return;
    const t = setInterval(() => {
      const st = useStore.getState();
      for (const id of idsRef.current.split(",")) {
        const reading = st.sessionContext[id];
        const staleAfter = reading?.source === "agy-status-line" ? 110_000 : 29 * 60_000;
        if (st.live[id]?.status === "running" || (reading?.observedAt && Date.now() - reading.observedAt > staleAfter)) {
          void st.refreshSessionContext(id);
        }
      }
    }, RUNNING_POLL_MS);
    return () => clearInterval(t);
  }, [idsKey]);
}
