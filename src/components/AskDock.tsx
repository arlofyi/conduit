import { useMemo } from "react";
import { useStore, findSession } from "../store";
import { effectiveCenterMode } from "../centerViews";
import { AskCard } from "./AskCard";

/** When the Continuity view is not on screen, a captured question still has to be visible:
 *  the oldest one docks bottom-right with a count of the rest. */
export function AskDock() {
  // Select the raw map and sort in a memo: a selector returning a fresh array loops in
  // Zustand v5. The visibility selector returns a primitive, so it is safe as-is.
  const askMap = useStore((s) => s.asks);
  const asks = useMemo(() => Object.values(askMap).sort((a, b) => a.createdMs - b.createdMs), [askMap]);
  const viewVisible = useStore(
    (s) => !!s.selectedProjectId && effectiveCenterMode(s.centerMode[s.selectedProjectId], s) === "continuity",
  );
  const canvasOpen = useStore((s) => s.canvasOpen);
  const projects = useStore((s) => s.projects);
  // The overlay is suppressed while the canvas is open, so a stored "continuity" mode
  // under the canvas is not "on screen".
  if ((viewVisible && !canvasOpen) || asks.length === 0) return null;
  const first = asks[0];
  const name = findSession(projects, first.session)?.session.name ?? "A session";
  return (
    <div className="ask-dock">
      <AskCard key={first.id} ask={first} sessionName={name} />
      {asks.length > 1 && <div className="ask-dock-more">+{asks.length - 1} more waiting</div>}
    </div>
  );
}
