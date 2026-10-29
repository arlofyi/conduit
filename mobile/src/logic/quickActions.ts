/**
 * The composer's "+" sheet: ways to steer a session that are not a message. Each maps to the
 * exact wire frames the bridge already accepts, so this table is the whole feature.
 */
import { inputMsg, interruptMsg, promptInput, type ClientMsg } from "../bridge/protocol";

export type QuickActionId = "stop" | "compact" | "clear";

export interface QuickAction {
  id: QuickActionId;
  title: string;
  detail: string;
  /** SF Symbol for the row */
  symbol: "stop.circle" | "arrow.down.right.and.arrow.up.left" | "eraser";
  destructive: boolean;
  /** only offered while a turn is running */
  runningOnly: boolean;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    id: "stop",
    title: "Stop",
    detail: "Interrupt the current turn (Esc on the Mac)",
    symbol: "stop.circle",
    destructive: true,
    runningOnly: true,
  },
  {
    id: "compact",
    title: "Compact",
    detail: "/compact: summarise the conversation to free context",
    symbol: "arrow.down.right.and.arrow.up.left",
    destructive: false,
    runningOnly: false,
  },
  {
    id: "clear",
    title: "Clear",
    detail: "/clear: start a fresh conversation in this session",
    symbol: "eraser",
    destructive: true,
    runningOnly: false,
  },
];

/** The actions to show: Stop only while something is running. */
export function quickActionsFor(running: boolean): QuickAction[] {
  return QUICK_ACTIONS.filter((a) => running || !a.runningOnly);
}

/** Wire frames for one action. Slash commands go in as a submitted prompt, like typing them. */
export function quickActionMsgs(id: QuickActionId, sessionId: string): ClientMsg[] {
  switch (id) {
    case "stop":
      return [interruptMsg(sessionId)];
    case "compact":
      return [inputMsg(sessionId, promptInput("/compact"))];
    case "clear":
      return [inputMsg(sessionId, promptInput("/clear"))];
  }
}
