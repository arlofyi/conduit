import { globalSelectedSessionId, type useStore } from "./store";
import { effectiveCenterMode } from "./centerViews";
import type { HandOffView } from "./asks";

/** Ask ids this window handed back to the terminal: the automatic hand-off in App.tsx and
 *  the card's own "Answer in terminal" link. Shared so an `ask-resolved` with
 *  `how: "handoff"` can tell "this window moved it" (drop the card) from "another side
 *  moved it" (say it moved). Forgotten when that `ask-resolved` arrives. */
export const handedOff = new Set<string>();

/** Where the user is looking, for the hand-off rule (`askShouldHandOff`). Shared by the
 *  ask hand-off in App.tsx and the permission dock, which hides — never resolves — a
 *  permission for the terminal already in front of the user. */
export function handOffView(s: ReturnType<typeof useStore.getState>): HandOffView {
  return {
    selectedSessionId: globalSelectedSessionId(s),
    continuityVisible:
      !!s.selectedProjectId && effectiveCenterMode(s.centerMode[s.selectedProjectId], s) === "continuity",
    windowFocused: s.windowFocused,
  };
}
