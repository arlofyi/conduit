/** Ask ids this window handed back to the terminal: the automatic hand-off in App.tsx and
 *  the card's own "Answer in terminal" link. Shared so an `ask-resolved` with
 *  `how: "handoff"` can tell "this window moved it" (drop the card) from "the terminal
 *  answered it on its own" (say so). Forgotten when that `ask-resolved` arrives. */
export const handedOff = new Set<string>();
