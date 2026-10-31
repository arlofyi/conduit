/** User-facing copy for connection and pairing outcomes. Pure, so the wording the screens
 * show is pinned by tests rather than scattered through JSX. */

import type { ConnError, ConnState } from "../bridge/connection";

/** Pair failure reasons sent by the desktop (`pairResult.reason`). */
export function pairFailText(reason: string): string {
  switch (reason) {
    case "declined":
      return "Declined on your computer";
    case "expired":
      return "No answer in 2 minutes";
    case "off":
      return "Mobile access is off on that computer";
    case "replaced":
      return "Another request replaced this one";
    default:
      return "Couldn't pair";
  }
}

/** One sentence for a connection error. `macName` fills in when the error lacks one. */
export function connErrorText(e: ConnError, macName = "your computer"): string {
  switch (e.kind) {
    case "revoked":
      return `${e.macName || macName} removed this phone. Pair again to reconnect.`;
    case "protocol":
      // The Mac speaks a newer protocol than this app: the app is the stale side.
      return e.direction === "updateApp" ? "Update the app" : `Update Conduit on ${e.macName || macName}`;
    case "pairFailed":
      return pairFailText(e.reason);
    case "notPaired":
      return `This phone isn't paired with ${e.macName || macName}.`;
    case "unavailable":
      return `${e.macName || macName} isn't accepting connections right now — mobile access may be off.`;
    case "closed":
      return `Couldn't reach ${macName}. Check that Tailscale is on.`;
  }
}

/** Why a scanned code was refused (`parseQr` reasons). */
export function qrErrorText(reason: "notConduit" | "version" | "invalid"): string {
  switch (reason) {
    case "notConduit":
      return "That isn't a Conduit pairing code.";
    case "version":
      return "That code is from a newer Conduit. Update the app.";
    case "invalid":
      return "That pairing code can't be used. Show a new one on your computer.";
  }
}

export type ConnTone ="ok" | "busy" | "bad";

/** Status line for the current Mac's connection. */
export function connStatus(c: ConnState, macName: string): { tone: ConnTone; text: string } {
  switch (c.phase) {
    case "ready":
      return { tone: "ok", text: `Connected · ${macName}` };
    case "failed":
      return { tone: "bad", text: c.error ? connErrorText(c.error, macName) : `Can't reach ${macName}` };
    case "idle":
      return { tone: "bad", text: "Not connected" };
    default:
      // Retrying after the Mac refused: keep saying why rather than a bare "connecting".
      if (c.error?.kind === "unavailable") return { tone: "bad", text: connErrorText(c.error, macName) };
      return { tone: "busy", text: `Connecting to ${macName}…` };
  }
}
