import type { SavedMac } from "../data/types";
import {
  handshaking,
  HELLO_TIMEOUT_MS,
  initialConn,
  step,
  type ConnEvent,
  type ConnState,
  type Effect,
} from "./connection";
import { attachMsg, inputMsg, interruptMsg, listMsg, promptInput, type ClientMsg, type ServerMsg } from "./protocol";

export interface BridgeOptions {
  /** ws:// URLs tried in order, advancing on every reconnect */
  addresses: string[];
  /** the saved Mac to authenticate as; null = loopback (no auth) or a pairing connection */
  mac: SavedMac | null;
  /** single-shot connection used to pair; the UI sends the `pair` frame once state is "pairing" */
  pairing?: boolean;
}

export interface BridgeHandlers {
  onMessage: (m: ServerMsg) => void;
  onState?: (s: ConnState) => void;
  /** forgetMac / saveToken; reconnects are handled internally */
  onEffect?: (e: Effect) => void;
}

/**
 * Owns the WebSocket and the reconnect timer; every decision is made by the pure reducer
 * in connection.ts. No token is ever put in the URL, and no Origin header is set (RN's
 * WebSocket sends none, and the desktop 403s any upgrade that carries one).
 */
export class BridgeClient {
  private ws: WebSocket | null = null;
  private state: ConnState = initialConn;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** connect + hello + auth deadline for the current socket */
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(
    opts: BridgeOptions,
    private readonly handlers: BridgeHandlers,
  ) {
    this.apply({ t: "start", mac: opts.mac, addresses: opts.addresses, pairing: opts.pairing });
    this.connect();
  }

  get connState(): ConnState {
    return this.state;
  }

  private apply(ev: ConnEvent) {
    const r = step(this.state, ev);
    const changed = r.state !== this.state;
    this.state = r.state;
    for (const m of r.send) this.send(m);
    for (const e of r.effects) {
      if (e.k === "reconnect") this.scheduleReconnect(e.delayMs);
      else this.handlers.onEffect?.(e);
    }
    if (!handshaking(this.state)) this.clearHelloTimer();
    // A failed connection is terminal: drop the socket so the desktop sees it go.
    if (changed && this.state.phase === "failed") this.dropSocket();
    if (changed) this.handlers.onState?.(this.state);
  }

  private clearHelloTimer() {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  /** Detach and close the current socket; its own onclose is ignored afterwards. */
  private dropSocket() {
    this.clearHelloTimer();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already closing
    }
  }

  private connect() {
    if (this.closedByUser) return;
    const url = this.state.addresses[this.state.addressIndex];
    if (!url) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.apply({ t: "close" });
      return;
    }
    this.ws = ws;
    this.clearHelloTimer();
    // A host that never answers (a dead tailnet route) must not hold the address list.
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (this.ws !== ws || !handshaking(this.state)) return;
      this.dropSocket();
      this.apply({ t: "close" });
    }, HELLO_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws === ws) this.apply({ t: "open" });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data) as ServerMsg;
      } catch {
        return; // malformed frame
      }
      this.apply({ t: "frame", msg });
      this.handlers.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearHelloTimer();
      this.apply({ t: "close" });
    };
    ws.onerror = () => {
      /* onclose fires next */
    };
  }

  private scheduleReconnect(delayMs: number) {
    if (this.closedByUser) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closedByUser) return;
      this.apply({ t: "dial" });
      this.connect();
    }, delayMs);
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  list() {
    this.send(listMsg());
  }

  attach(sessionId: string) {
    this.send(attachMsg(sessionId));
  }

  interrupt(sessionId: string) {
    this.send(interruptMsg(sessionId));
  }

  /** Send a prompt: the text as a bracketed paste, then Enter, into the live PTY. */
  prompt(sessionId: string, text: string) {
    this.send(inputMsg(sessionId, promptInput(text)));
  }

  /** The app went to the background: close the socket and do not redial until `resume`. */
  suspend() {
    if (this.closedByUser) return;
    this.apply({ t: "suspend" });
    if (!this.state.suspended) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dropSocket();
  }

  /** The app is back in front: redial through the normal reconnect path, if suspended. */
  resume() {
    if (this.closedByUser) return;
    this.apply({ t: "resume" });
  }

  close() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dropSocket();
  }
}
