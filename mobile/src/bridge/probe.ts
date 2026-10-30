/** Simulator/dev only: find every Conduit answering on loopback. The founder's installed
 * Conduit answers there too, so this LISTS what it finds and never picks one — the user (or
 * the e2e test) chooses the isolated dev build explicitly. */

import type { ServerMsg } from "./protocol";

export const BRIDGE_PORT_MIN = 8455;
export const BRIDGE_PORT_MAX = 8474;
export const PROBE_TIMEOUT_MS = 600;
const PROBE_PARALLEL = 4;

export interface LoopbackFound {
  port: number;
  macName: string;
  conduitVersion: string;
}

/** The slice of WebSocket this needs, so tests can inject a fake. */
export interface ProbeSocket {
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}
export type SocketFactory = (url: string) => ProbeSocket;

/** Open, wait for `hello` (up to `timeoutMs`), close. Null when nothing Conduit-shaped answers. */
export function probePort(
  port: number,
  make: SocketFactory,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<LoopbackFound | null> {
  return new Promise((resolve) => {
    let done = false;
    let ws: ProbeSocket | null = null;
    const finish = (v: LoopbackFound | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // already closed
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      ws = make(`ws://127.0.0.1:${port}`);
    } catch {
      finish(null);
      return;
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data) as ServerMsg;
      } catch {
        return finish(null);
      }
      if (m.type === "hello" && typeof m.macName === "string") {
        finish({ port, macName: m.macName, conduitVersion: String(m.conduitVersion ?? "") });
      }
    };
    ws.onclose = () => finish(null);
    ws.onerror = () => finish(null);
  });
}

/** Probe the whole bridge range a few ports at a time; results in port order. */
export async function probeLoopback(make: SocketFactory, timeoutMs = PROBE_TIMEOUT_MS): Promise<LoopbackFound[]> {
  const ports: number[] = [];
  for (let p = BRIDGE_PORT_MIN; p <= BRIDGE_PORT_MAX; p++) ports.push(p);
  const found: LoopbackFound[] = [];
  for (let i = 0; i < ports.length; i += PROBE_PARALLEL) {
    const batch = await Promise.all(ports.slice(i, i + PROBE_PARALLEL).map((p) => probePort(p, make, timeoutMs)));
    for (const f of batch) if (f) found.push(f);
  }
  return found;
}
