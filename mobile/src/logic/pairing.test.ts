import { createHash, randomBytes } from "crypto";
import { addressesFor, confirmCode, makeNonce, parseQr } from "./pairing";
import type { SavedMac } from "../data/types";

const sha256Hex = async (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const SECRET = "a".repeat(64);
const good = { v: 1, macName: "Studio", dnsName: "studio.tail1.ts.net", ip: "100.64.0.2", port: 8455, secret: SECRET };

describe("confirmCode", () => {
  it("confirm_code_matches_rust_vector", async () => {
    expect(await confirmCode(sha256Hex, "secret-abc", "nonce-123")).toBe("8754");
    expect(await confirmCode(sha256Hex, "req-1", "nonce-xyz")).toBe("0995");
  });
});

describe("makeNonce", () => {
  it("nonce_is_32_hex", () => {
    const n = makeNonce((len) => new Uint8Array(randomBytes(len)));
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("parseQr", () => {
  it("rejects_bad_qr_wrong_version", () => {
    expect(parseQr(JSON.stringify({ ...good, v: 2 }))).toEqual({ ok: false, reason: "version" });
  });
  it("rejects_non_conduit_text", () => {
    expect(parseQr("https://example.com")).toEqual({ ok: false, reason: "notConduit" });
    expect(parseQr(JSON.stringify({ hello: 1 }))).toEqual({ ok: false, reason: "notConduit" });
  });
  it("rejects_bad_qr_missing_field", () => {
    const { ip: _ip, ...rest } = good;
    expect(parseQr(JSON.stringify(rest))).toEqual({ ok: false, reason: "invalid" });
  });
  it("rejects_bad_qr_bad_secret", () => {
    for (const secret of ["short", "G".repeat(64), "A".repeat(64), "a".repeat(65)]) {
      expect(parseQr(JSON.stringify({ ...good, secret }))).toEqual({ ok: false, reason: "invalid" });
    }
  });
  it("rejects_bad_qr_port_out_of_range", () => {
    for (const port of [8454, 8475, 0, "8455", 8455.5]) {
      expect(parseQr(JSON.stringify({ ...good, port }))).toEqual({ ok: false, reason: "invalid" });
    }
  });
  it("accepts_real_qr_shape", () => {
    expect(parseQr(JSON.stringify(good))).toEqual({ ok: true, qr: good });
    expect(parseQr(JSON.stringify({ ...good, port: 8474 })).ok).toBe(true);
  });
});

describe("addressesFor", () => {
  const mac: SavedMac = { deviceId: "d", token: "t", macName: "m", dnsName: "studio.ts.net", ip: "100.64.0.2", port: 8460, pairedAt: 1 };
  it("addresses_dns_then_ip_then_loopback_in_sim", () => {
    expect(addressesFor(mac, { simulator: false })).toEqual(["ws://studio.ts.net:8460", "ws://100.64.0.2:8460"]);
    expect(addressesFor(mac, { simulator: true })).toEqual([
      "ws://studio.ts.net:8460",
      "ws://100.64.0.2:8460",
      "ws://127.0.0.1:8460",
    ]);
  });
  it("skips_empty_hosts", () => {
    expect(addressesFor({ ...mac, dnsName: "" }, { simulator: false })).toEqual(["ws://100.64.0.2:8460"]);
  });
});
