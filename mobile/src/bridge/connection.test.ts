import type { SavedMac } from "../data/types";
import { handshaking, initialConn, isLoopbackAddress, step, type ConnEvent, type ConnState } from "./connection";
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

  it("post_ready_non_auth_error_keeps_ready_and_forgets_nothing", () => {
    const r = run(initialConn, [
      start(),
      { t: "open" },
      { t: "frame", msg: hello() },
      { t: "frame", msg: { type: "authOk", deviceId: "dev1" } },
      { t: "frame", msg: { type: "error", message: "no such session" } },
      { t: "frame", msg: { type: "error", message: "unauthorized" } },
    ]);
    expect(r.state.phase).toBe("ready");
    expect(r.state.error).toBeUndefined();
    expect(r.effects).toEqual([]);
  });

  it("no_token_mac_is_ready_only_on_loopback", () => {
    const loop: SavedMac = { ...mac, deviceId: "loopback-8455", token: "", dnsName: "localhost", ip: "127.0.0.1" };
    const ok = run(initialConn, [
      start(loop, ["ws://localhost:8455", "ws://127.0.0.1:8455"]),
      { t: "open" },
      { t: "frame", msg: hello() },
    ]);
    expect(ok.state.phase).toBe("ready");
    expect(ok.send).toEqual([]);

    const remote = run(initialConn, [start({ ...mac, token: "" }), { t: "open" }, { t: "frame", msg: hello() }]);
    expect(remote.state.phase).toBe("failed");
    expect(remote.state.error).toEqual({ kind: "notPaired", macName: "Studio" });
    expect(remote.send).toEqual([]);

    const noMac = run(initialConn, [start(null, ["ws://studio.ts.net:8455"]), { t: "open" }, { t: "frame", msg: hello() }]);
    expect(noMac.state.phase).toBe("failed");
  });

  it("is_loopback_address", () => {
    expect(isLoopbackAddress("ws://127.0.0.1:8455")).toBe(true);
    expect(isLoopbackAddress("ws://localhost:8460")).toBe(true);
    expect(isLoopbackAddress("ws://[::1]:8460")).toBe(true);
    expect(isLoopbackAddress("ws://studio.ts.net:8455")).toBe(false);
    expect(isLoopbackAddress("ws://127.0.0.1.evil.ts.net:8455")).toBe(false);
    expect(isLoopbackAddress("ws://100.1.2.3:8455")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("handshake_deadline_covers_connect_hello_and_auth", () => {
    const s0 = run(initialConn, [start()]).state;
    expect(handshaking(s0)).toBe(true);
    const s1 = run(s0, [{ t: "open" }]).state;
    expect(handshaking(s1)).toBe(true);
    const s2 = run(s1, [{ t: "frame", msg: hello() }]).state;
    expect(s2.phase).toBe("authing");
    expect(handshaking(s2)).toBe(true);
    const s3 = run(s2, [{ t: "frame", msg: { type: "authOk", deviceId: "dev1" } }]).state;
    expect(handshaking(s3)).toBe(false);
    // a pairing socket waits on a human after hello: no deadline
    const p = run(initialConn, [
      { t: "start", mac: null, addresses: ADDRS, pairing: true },
      { t: "open" },
      { t: "frame", msg: hello() },
    ]).state;
    expect(handshaking(p)).toBe(false);
  });

  it("unavailable_auth_retries_with_backoff_and_never_forgets", () => {
    const authing = run(initialConn, [start(), { t: "open" }, { t: "frame", msg: hello() }]).state;
    const r = run(authing, [{ t: "frame", msg: { type: "error", message: "unavailable" } }]);
    expect(r.state.phase).toBe("failed");
    expect(r.state.error).toEqual({ kind: "unavailable", macName: "Studio" });
    expect(r.effects).toEqual([{ k: "reconnect", addressIndex: 0, delayMs: 500 }]);
    // the desktop's close after the reply is ignored (the retry is already scheduled)
    expect(step(r.state, { t: "close" }).effects).toEqual([]);
    // the scheduled retry starts a fresh handshake, error still shown until ready
    const d = run(r.state, [{ t: "dial" }, { t: "open" }, { t: "frame", msg: hello() }]);
    expect(d.state.phase).toBe("authing");
    expect(d.state.error?.kind).toBe("unavailable");
    const again = step(d.state, { t: "frame", msg: { type: "error", message: "unavailable" } });
    expect(again.effects).toEqual([{ k: "reconnect", addressIndex: 0, delayMs: 1000 }]);
    const ok = run(d.state, [{ t: "frame", msg: { type: "authOk", deviceId: "dev1" } }]);
    expect(ok.state.phase).toBe("ready");
    expect(ok.state.error).toBeUndefined();
    expect(ok.state.backoffMs).toBe(500);
  });

  it("dial_does_not_revive_other_failures", () => {
    const revoked = run(initialConn, [
      start(),
      { t: "open" },
      { t: "frame", msg: hello() },
      { t: "frame", msg: { type: "error", message: "unauthorized" } },
    ]).state;
    expect(step(revoked, { t: "dial" }).state.phase).toBe("failed");
  });

  it("pairing_falls_through_addresses_before_hello_then_fails", () => {
    const pairStart: ConnEvent = { t: "start", mac: null, addresses: ADDRS, pairing: true };
    const a = run(initialConn, [pairStart, { t: "close" }]);
    expect(a.state.phase).toBe("connecting");
    expect(a.state.addressIndex).toBe(1);
    expect(a.effects).toEqual([{ k: "reconnect", addressIndex: 1, delayMs: 0 }]);
    const b = run(a.state, [{ t: "close" }, { t: "close" }]);
    expect(b.state.phase).toBe("failed");
    expect(b.state.error).toEqual({ kind: "closed" });
    // once the socket reached pairing, a close is final
    const c = run(initialConn, [pairStart, { t: "open" }, { t: "frame", msg: hello() }, { t: "close" }]);
    expect(c.state.phase).toBe("failed");
    expect(c.effects).toEqual([]);
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
