import type { SavedMac } from "../data/types";
import { initialConn, step, type ConnEvent, type ConnState } from "./connection";
import type { ServerMsg } from "./protocol";

const mac: SavedMac = {
  deviceId: "dev1",
  token: "tok",
  macName: "Studio",
  dnsName: "studio.ts.net",
  ip: "100.1.2.3",
  port: 8455,
  pairedAt: 1,
};
const ADDRS = ["ws://studio.ts.net:8455", "ws://100.1.2.3:8455", "ws://127.0.0.1:8455"];
const hello = (v = 1): ServerMsg => ({ type: "hello", macName: "Studio", conduitVersion: "0.1", protocolVersion: v });

function run(s: ConnState, evs: ConnEvent[]) {
  let state = s;
  const send: unknown[] = [];
  const effects: unknown[] = [];
  for (const e of evs) {
    const r = step(state, e);
    state = r.state;
    send.push(...r.send);
    effects.push(...r.effects);
  }
  return { state, send, effects };
}
const start = (m: SavedMac | null = mac, addresses = ADDRS): ConnEvent => ({ t: "start", mac: m, addresses });

describe("connection reducer", () => {
  it("hello_then_auth_then_ready", () => {
    const r = run(initialConn, [
      start(),
      { t: "open" },
      { t: "frame", msg: hello() },
    ]);
    expect(r.state.phase).toBe("authing");
    expect(r.send).toEqual([{ type: "auth", token: "tok" }]);
    const r2 = run(r.state, [{ t: "frame", msg: { type: "authOk", deviceId: "dev1" } }]);
    expect(r2.state.phase).toBe("ready");
  });

  it("unauthorized_auth_forgets_mac", () => {
    const r = run(initialConn, [
      start(),
      { t: "open" },
      { t: "frame", msg: hello() },
      { t: "frame", msg: { type: "error", message: "unauthorized" } },
    ]);
    expect(r.state.phase).toBe("failed");
    expect(r.state.error).toEqual({ kind: "revoked", macName: "Studio" });
    expect(r.effects).toEqual([{ k: "forgetMac", deviceId: "dev1" }]);
    // the close that follows must not reconnect
    const c = step(r.state, { t: "close" });
    expect(c.effects).toEqual([]);
    expect(c.state.phase).toBe("failed");
  });

  it("protocol_mismatch_fails_with_direction", () => {
    const newer = run(initialConn, [start(), { t: "open" }, { t: "frame", msg: hello(2) }]);
    expect(newer.state.phase).toBe("failed");
    expect(newer.state.error).toEqual({ kind: "protocol", direction: "updateApp", macName: "Studio" });
    expect(newer.send).toEqual([]);
    const older = run(initialConn, [start(), { t: "open" }, { t: "frame", msg: hello(0) }]);
    expect(older.state.error).toEqual({ kind: "protocol", direction: "updateMac", macName: "Studio" });
  });

  it("falls_through_addresses_in_order", () => {
    let s = run(initialConn, [start()]).state;
    const tried: number[] = [s.addressIndex];
    for (let i = 0; i < 4; i++) {
      const r = step(s, { t: "close" });
      s = r.state;
      const eff = r.effects[0];
      if (eff.k !== "reconnect") throw new Error("expected reconnect");
      tried.push(eff.addressIndex);
    }
    expect(tried).toEqual([0, 1, 2, 0, 1]);
  });

  it("backoff_caps_at_8s_and_resets_on_ready", () => {
    let s = run(initialConn, [start()]).state;
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = step(s, { t: "close" });
      s = r.state;
      const eff = r.effects[0];
      if (eff.k === "reconnect") delays.push(eff.delayMs);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    s = run(s, [{ t: "open" }, { t: "frame", msg: hello() }, { t: "frame", msg: { type: "authOk", deviceId: "dev1" } }]).state;
    expect(s.phase).toBe("ready");
    const r = step(s, { t: "close" });
    expect(r.effects[0]).toMatchObject({ k: "reconnect", delayMs: 500 });
  });

  it("loopback_without_mac_is_ready_after_hello", () => {
    const r = run(initialConn, [
      start(null, ["ws://127.0.0.1:8455"]),
      { t: "open" },
      { t: "frame", msg: hello() },
    ]);
    expect(r.state.phase).toBe("ready");
    expect(r.send).toEqual([]);
  });

  it("pairing_success_saves_token_without_authok", () => {
    const r = run(initialConn, [
      { t: "start", mac: null, addresses: ADDRS, pairing: true },
      { t: "open" },
      { t: "frame", msg: hello() },
      { t: "frame", msg: { type: "pairPending", requestId: "r" } },
      { t: "frame", msg: { type: "pairResult", ok: true, token: "T", deviceId: "D" } },
    ]);
    expect(r.state.phase).toBe("ready");
    expect(r.effects).toEqual([{ k: "saveToken", deviceId: "D", token: "T" }]);
  });

  it("pairing_failure_and_close_do_not_reconnect", () => {
    const r = run(initialConn, [
      { t: "start", mac: null, addresses: ADDRS, pairing: true },
      { t: "open" },
      { t: "frame", msg: hello() },
      { t: "frame", msg: { type: "pairResult", ok: false, reason: "declined" } },
      { t: "close" },
    ]);
    expect(r.state.error).toEqual({ kind: "pairFailed", reason: "declined" });
    expect(r.effects).toEqual([]);
  });
});
