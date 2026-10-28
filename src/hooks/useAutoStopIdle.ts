import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { idleStopTargets } from "../sessionLifecycle";

/** How often finished sessions are checked. A minute of slack on a 5-minute rule. */
const CHECK_EVERY_MS = 30_000;

/**
 * Settings → Sessions "Stop sessions after the agent finishes": once an agent has been
 * done (or idle) for the configured minutes, stop its session through the same path as
 * the Stop button -- processes ended, conversation and scrollback kept, a click or key in
 * the pane resumes it. The decision is `idleStopTargets` (pure, tested); this only feeds
 * it the store and what is on screen.
 *
 * A finished TURN is not a finished agent: one that started a background command (a dev
 * server, a watcher, a CI watch it will be woken by) reports `done` and waits. Before
 * stopping anything this asks Rust (`busy_sessions`) which candidates still have a shell
 * running under the agent, and leaves those alone. Sessions pinned "keep running" are
 * never candidates.
 */
export function useAutoStopIdle() {
  useEffect(() => {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      const st = useStore.getState();
      const prefs = st.sessionLifecycle;
      if (!prefs.autoStopIdle) return;
      const targets = idleStopTargets({
        now: Date.now(),
        sessions: st.projects.flatMap((p) =>
          p.sessions.map((s) => ({ ...s, projectId: p.id })),
        ),
        live: st.live,
        visible: visibleSessions(st),
        pinned: new Set(Object.keys(st.keepRunning)),
        prefs,
      });
      if (!targets.length) return;
      inFlight = true;
      try {
        // If the check itself fails, stop nothing: a wrong "idle" kills work, a wrong
        // "busy" only costs memory until the next tick.
        const busy = new Set(
          await invoke<string[]>("busy_sessions", {
            sessionIds: targets.map((t) => t.sessionId),
          }),
        );
        const now = useStore.getState();
        for (const t of targets) {
          if (busy.has(t.sessionId)) continue;
          // Re-read: the agent may have started again while the check ran.
          const status = now.live[t.sessionId]?.status;
          if (status === "running" || now.keepRunning[t.sessionId]) continue;
          void now.stopSession(t.projectId, t.sessionId);
        }
      } catch {
        /* see above -- stop nothing */
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(() => void tick(), CHECK_EVERY_MS);
    return () => window.clearInterval(id);
  }, []);
}

/** The sessions currently on screen: the active tab of every pane in the selected
 *  project's layout, or every card on the board while it is open. None while the root
 *  chat covers the workspace. */
function visibleSessions(st: ReturnType<typeof useStore.getState>): Set<string> {
  const out = new Set<string>();
  if (st.selectedRootChatId) return out;
  if (st.canvasOpen) {
    for (const n of st.canvas.nodes) out.add(n.ref);
    return out;
  }
  const layout = st.selectedProjectId ? st.layouts[st.selectedProjectId] : undefined;
  for (const g of layout?.groups ?? []) {
    if (g.activeRef) out.add(g.activeRef);
  }
  return out;
}
