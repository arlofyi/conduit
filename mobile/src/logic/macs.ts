/** Pure builders for the Macs the phone talks to. */

import type { LoopbackFound } from "../bridge/probe";
import type { SavedMac } from "../data/types";

/** Where a pairing connection goes before a token exists. */
export interface PairEndpoint {
  macName: string;
  dnsName: string;
  ip: string;
  port: number;
}

/** A loopback Conduit (Simulator/dev) saved like any Mac, minus the token: the reducer
 * reaches `ready` for a token-less Mac only on a loopback host. */
export function loopbackMac(f: LoopbackFound, now: number): SavedMac {
  return {
    deviceId: `loopback-${f.port}`,
    token: "",
    macName: f.macName,
    dnsName: "localhost",
    ip: "127.0.0.1",
    port: f.port,
    pairedAt: now,
  };
}

export const isLoopbackMac = (m: SavedMac): boolean => m.token === "" && m.deviceId.startsWith("loopback-");

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** "Enter address": a MagicDNS name or an IPv4, plus a port in the bridge range. */
export function parseManualAddress(
  hostIn: string,
  portIn: string,
): { ok: true; endpoint: PairEndpoint } | { ok: false; error: string } {
  const host = hostIn.trim().replace(/\.$/, "");
  const portText = portIn.trim();
  if (!/^\d+$/.test(portText)) return { ok: false, error: "Enter the port shown on your computer (8455–8474)." };
  const port = Number(portText);
  if (port < 8455 || port > 8474) return { ok: false, error: "Enter the port shown on your computer (8455–8474)." };
  const v4 = IPV4.exec(host);
  if (v4) {
    if (v4.slice(1).some((x) => Number(x) > 255)) return { ok: false, error: "That isn't a valid address." };
    return { ok: true, endpoint: { macName: host, dnsName: "", ip: host, port } };
  }
  if (!host || host.length > 253 || !HOST.test(host)) return { ok: false, error: "That isn't a valid address." };
  return { ok: true, endpoint: { macName: host.split(".")[0], dnsName: host.toLowerCase(), ip: "", port } };
}
