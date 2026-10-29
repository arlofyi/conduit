import type { SavedMac } from "../data/types";
import { authMsg, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from "./protocol";

/**
 * Pure connection state machine for the bridge socket. No timers, no sockets: BridgeClient
 * feeds it events and performs the `send` / `effects` it returns.
 */

export type Phase = "idle" | "connecting" | "hello" | "authing" | "ready" | "pairing" | "failed";

export type ConnError =
  /** the Mac removed this phone (auth answered `unauthorized`) */
  | { kind: "revoked"; macName?: string }
  /** protocol mismatch; `direction` says which side must be updated */
  | { kind: "protocol"; direction: "updateApp" | "updateMac"; macName: string }
  | { kind: "pairFailed"; reason: string }
  | { kind: "closed" };

export interface ConnState {
  phase: Phase;
  addressIndex: number;
  mac?: SavedMac;
  error?: ConnError;
  /** ws:// URLs to try, in order */
  addresses: string[];
  /** delay the NEXT reconnect will use */
  backoffMs: number;
  /** pairing connection: after hello, wait for the UI to send `pair` */
  pairing: boolean;
}

export type ConnEvent =
  | { t: "open" }
  | { t: "close" }
  | { t: "frame"; msg: ServerMsg }
  | { t: "start"; mac: SavedMac | null; addresses: string[]; pairing?: boolean };

export type Effect =
  | { k: "forgetMac"; deviceId: string }
  | { k: "saveToken"; deviceId: string; token: string }
  | { k: "reconnect"; addressIndex: number; delayMs: number };

export interface StepResult {
  state: ConnState;
  send: ClientMsg[];
  effects: Effect[];
}

export const BACKOFF_START_MS = 500;
export const BACKOFF_MAX_MS = 8000;

export const initialConn: ConnState = {
  phase: "idle",
  addressIndex: 0,
  addresses: [],
  backoffMs: BACKOFF_START_MS,
  pairing: false,
};

const out = (state: ConnState, send: ClientMsg[] = [], effects: Effect[] = []): StepResult => ({
  state,
  send,
  effects,
});

export function step(state: ConnState, ev: ConnEvent): StepResult {
  switch (ev.t) {
    case "start":
      return out({
        phase: "connecting",
        addressIndex: 0,
        mac: ev.mac ?? undefined,
        addresses: ev.addresses,
        backoffMs: BACKOFF_START_MS,
        pairing: !!ev.pairing,
      });

    case "open":
      return state.phase === "connecting" ? out({ ...state, phase: "hello" }) : out(state);

    case "close": {
      // Terminal states and an unstarted client never reconnect.
      if (state.phase === "idle" || state.phase === "failed") return out(state);
      if (state.pairing) {
        // A pairing socket is single-shot: the secret / request is spent.
        return out({ ...state, phase: "failed", error: { kind: "closed" } });
      }
      const n = Math.max(state.addresses.length, 1);
      const next = (state.addressIndex + 1) % n;
      const delayMs = state.backoffMs;
      return out(
        {
          ...state,
          phase: "connecting",
          addressIndex: next,
          backoffMs: Math.min(state.backoffMs * 2, BACKOFF_MAX_MS),
        },
        [],
        [{ k: "reconnect", addressIndex: next, delayMs }],
      );
    }

    case "frame":
      return onFrame(state, ev.msg);
  }
}

function onFrame(state: ConnState, msg: ServerMsg): StepResult {
  switch (msg.type) {
    case "hello": {
      if (state.phase !== "hello" && state.phase !== "connecting") return out(state);
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        return out({
          ...state,
          phase: "failed",
          error: {
            kind: "protocol",
            // A Mac speaking a newer protocol means this app is the stale side.
            direction: msg.protocolVersion > PROTOCOL_VERSION ? "updateApp" : "updateMac",
            macName: msg.macName,
          },
        });
      }
      if (state.pairing) return out({ ...state, phase: "pairing" });
      if (state.mac) return out({ ...state, phase: "authing" }, [authMsg(state.mac.token)]);
      // Loopback with no saved Mac: the desktop trusts loopback, no auth.
      return out({ ...state, phase: "ready", backoffMs: BACKOFF_START_MS });
    }

    case "authOk":
      if (state.phase !== "authing") return out(state);
      return out({ ...state, phase: "ready", backoffMs: BACKOFF_START_MS });

    case "error":
      if (state.phase === "authing" && msg.message === "unauthorized" && state.mac) {
        return out(
          { ...state, phase: "failed", error: { kind: "revoked", macName: state.mac.macName } },
          [],
          [{ k: "forgetMac", deviceId: state.mac.deviceId }],
        );
      }
      return out(state);

    case "pairResult":
      if (state.phase !== "pairing") return out(state);
      if (msg.ok) {
        // A successful pair authenticates the socket with no authOk.
        return out({ ...state, phase: "ready", backoffMs: BACKOFF_START_MS }, [], [
          { k: "saveToken", deviceId: msg.deviceId, token: msg.token },
        ]);
      }
      return out({ ...state, phase: "failed", error: { kind: "pairFailed", reason: msg.reason } });

    default:
      return out(state);
  }
}
