/**
 * The composer's "+" sheet: ways to steer a session that are not a message. Each maps to the
 * exact wire frames the bridge already accepts, so this table is the whole feature.
 */
import { inputMsg, interruptMsg, promptInput, type ClientMsg } from "../bridge/protocol";
import { chatOnPhone } from "./agents";

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
  /** a Claude Code slash command: meaningless to any other agent */
  claudeOnly: boolean;
  /** asked first, because it cannot be undone from the phone */
  confirm?: { title: string; message: string; action: string };
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    id: "stop",
    title: "Stop",
    detail: "Interrupt the current turn (Esc on the Mac)",
    symbol: "stop.circle",
    destructive: true,
    runningOnly: true,
    claudeOnly: false,
  },
  {
    id: "compact",
    title: "Compact",
    detail: "/compact: summarise the conversation to free context",
    symbol: "arrow.down.right.and.arrow.up.left",
    destructive: false,
    runningOnly: false,
    claudeOnly: true,
  },
  {
    id: "clear",
    title: "Clear",
    detail: "/clear: start a fresh conversation in this session",
    symbol: "eraser",
    destructive: true,
    runningOnly: false,
    claudeOnly: true,
    confirm: {
      title: "Clear this conversation?",
      message: "The session starts over with an empty context. The old conversation stays on your Mac.",
      action: "Clear",
    },
  },
];

/** The actions to show: Stop only while something is running; slash commands only for Claude. */
export function quickActionsFor(running: boolean, agent: string): QuickAction[] {
  const claude = chatOnPhone(agent);
  return QUICK_ACTIONS.filter((a) => (running || !a.runningOnly) && (claude || !a.claudeOnly));
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
