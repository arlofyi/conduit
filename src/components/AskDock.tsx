import { useMemo } from "react";
import { useStore, findSession } from "../store";
import { effectiveCenterMode } from "../centerViews";
import { AskCard } from "./AskCard";

/** A captured question must always be visible somewhere. When the Continuity view is not
 *  on screen, the oldest ask docks bottom-right with a count of the rest. When it IS on
 *  screen, the graph draws only asks of sessions it renders as nodes, so the dock shows
 *  the remainder (another project's sessions, or ones missing from the snapshot). */
export function AskDock() {
  // Select the raw map and sort in a memo: a selector returning a fresh array loops in
  // Zustand v5. The visibility selector returns a primitive, so it is safe as-is.
  const askMap = useStore((s) => s.asks);
  const viewVisible = useStore(
    (s) => !!s.selectedProjectId && effectiveCenterMode(s.centerMode[s.selectedProjectId], s) === "continuity",
  );
  const canvasOpen = useStore((s) => s.canvasOpen);
  const rendered = useStore((s) => s.continuityRendered);
  const projects = useStore((s) => s.projects);
  // The overlay is suppressed while the canvas is open, so a stored "continuity" mode
  // under the canvas is not "on screen".
  const graphShowing = viewVisible && !canvasOpen;
  const asks = useMemo(
    () =>
      Object.values(askMap)
        .filter((a) => !graphShowing || !rendered[a.session])
        .sort((a, b) => a.createdMs - b.createdMs),
    [askMap, graphShowing, rendered],
  );
  if (asks.length === 0) return null;
  const first = asks[0];
  const name = findSession(projects, first.session)?.session.name ?? "A session";
  return (
    <div className="ask-dock">
      <AskCard key={first.id} ask={first} sessionName={name} />
      {asks.length > 1 && <div className="ask-dock-more">+{asks.length - 1} more waiting</div>}
    </div>
  );
}
