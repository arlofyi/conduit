/** Pure pairing helpers. Mirrors src-tauri/src/pairing.rs (`confirm_code`, `QrPayload`),
 * which is the authority. Hashing/randomness are injected so this runs under jest. */

import type { SavedMac } from "../data/types";

export interface QrPayload {
  v: 1;
  macName: string;
  dnsName: string;
  ip: string;
  port: number;
  secret: string;
}

export type QrResult =
  | { ok: true; qr: QrPayload }
  | { ok: false; reason: "notConduit" | "version" | "invalid" };

const PORT_MIN = 8455;
const PORT_MAX = 8474;
const SECRET_RE = /^[0-9a-f]{64}$/;

const HOST_RE = /^[a-z0-9.-]{1,253}$/i;

/** IPv4 in 100.64.0.0/10 (Tailscale CGNAT). */
function isTailnetIp(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const n = m.slice(1).map(Number);
  if (n.some((x) => x > 255)) return false;
  return n[0] === 100 && n[1] >= 64 && n[1] <= 127;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Validate a scanned QR. Anything that is not exactly a Conduit pairing payload is
 * rejected here and never reaches the bridge. */
export function parseQr(text: string): QrResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "notConduit" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "notConduit" };
  const o = raw as Record<string, unknown>;
  if (!("v" in o) || !("secret" in o)) return { ok: false, reason: "notConduit" };
  if (o.v !== 1) return { ok: false, reason: "version" };
  if (
    !str(o.macName) ||
    !str(o.dnsName) ||
    !HOST_RE.test(o.dnsName) ||
    !str(o.ip) ||
    !isTailnetIp(o.ip) ||
    typeof o.port !== "number" ||
    !Number.isInteger(o.port) ||
    o.port < PORT_MIN ||
    o.port > PORT_MAX ||
    typeof o.secret !== "string" ||
    !SECRET_RE.test(o.secret)
  ) {
    return { ok: false, reason: "invalid" };
  }
  return {
    ok: true,
    qr: { v: 1, macName: o.macName, dnsName: o.dnsName, ip: o.ip, port: o.port, secret: o.secret },
  };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** 16 random bytes as 32 lowercase hex. */
export function makeNonce(randomBytes: (n: number) => Uint8Array): string {
  const b = randomBytes(16);
  if (b.length < 16) throw new Error("randomBytes returned too few bytes");
  return hex(b.subarray(0, 16));
}

/** `sha256(utf8(input) || utf8(nonce))`, first two bytes big-endian, % 10000, zero padded.
 * `input` is the QR secret (QR path) or the requestId from pairPending (request path). */
export async function confirmCode(
  sha256Hex: (s: string) => Promise<string>,
  input: string,
  nonce: string,
): Promise<string> {
  const digest = await sha256Hex(input + nonce);
  return String(parseInt(digest.slice(0, 4), 16) % 10000).padStart(4, "0");
}

/** Hosts to try in order: dnsName, ip, then (Simulator/dev only) loopback. */
export function addressesFor(mac: SavedMac, opts: { simulator: boolean }): string[] {
  const hosts = [mac.dnsName, mac.ip];
  if (opts.simulator) hosts.push("127.0.0.1");
  return hosts.filter((h) => h.length > 0).map((h) => `ws://${h}:${mac.port}`);
}
