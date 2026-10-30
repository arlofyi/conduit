import { globalSelectedSessionId, type useStore } from "./store";
import { effectiveCenterMode } from "./centerViews";
import type { HandOffView } from "./asks";

/** Ask ids this window handed back to the terminal with the card's own "Answer in
 *  terminal" link. Shared so an `ask-resolved` with `how: "handoff"` can tell "this window
 *  moved it" (drop the card) from "another side moved it" (say it moved). Forgotten when
 *  that `ask-resolved` arrives. Nothing hands a question off automatically any more: the
 *  hook decides once, when Claude asks (hooks.rs `holder_for`). */
export const handedOff = new Set<string>();

/** Where the user is looking: the input to `focusedTerminal`, which App.tsx sends to Rust
 *  with the gate, and to the permission dock, which hides — never resolves — a permission
 *  for the terminal already in front of the user. */
export function handOffView(s: ReturnType<typeof useStore.getState>): HandOffView {
  return {
    selectedSessionId: globalSelectedSessionId(s),
    continuityVisible:
      !!s.selectedProjectId && effectiveCenterMode(s.centerMode[s.selectedProjectId], s) === "continuity",
    windowFocused: s.windowFocused,
  };
}
