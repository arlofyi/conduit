import { useEffect } from "react";
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
 */
export function useAutoStopIdle() {
  useEffect(() => {
    const tick = () => {
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
        prefs,
      });
      for (const t of targets) void st.stopSession(t.projectId, t.sessionId);
    };
    const id = window.setInterval(tick, CHECK_EVERY_MS);
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
