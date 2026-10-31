// Pure helpers for Settings → Mobile and the pair prompt. No store / Tauri imports, so vitest
// (node env) can load it.
import qrcode from "qrcode-generator";

/** Mirrors `tailscale::TailscaleState` (serde tag "state", camelCase). */
export type TailscaleState =
  | { state: "notInstalled" }
  | { state: "stopped" }
  | { state: "needsLogin" }
  | {
      state: "running";
      tailnet: string;
      selfName: string;
      dnsName: string;
      ipv4: string | null;
      ipv6: string | null;
      userId: number;
    }
  | { state: "unknown"; reason: string };

export function tailscaleRow(s: TailscaleState): { label: string; action: "install" | "open" | null } {
  switch (s.state) {
    case "notInstalled":
      return { label: "Tailscale is not installed", action: "install" };
    case "stopped":
      return { label: "Tailscale is off on this computer", action: "open" };
    case "needsLogin":
      return { label: "Sign in to Tailscale", action: "open" };
    case "running":
      return { label: `Connected · ${s.tailnet} · this computer is ${s.dnsName}`, action: null };
    case "unknown":
      return { label: `Couldn't read Tailscale: ${s.reason}`, action: "open" };
  }
}

/** Mirrors `pairing::QrPayload`. */
export interface QrPayload {
  v: number;
  macName: string;
  dnsName: string;
  ip: string;
  port: number;
  secret: string;
}

/** Mirrors `pairing::PairRequestView`; `expiresAt` is unix SECONDS. */
export interface PairRequest {
  id: string;
  deviceName: string;
  code: string;
  login: string | null;
  peer: string;
  via: "secret" | "request";
  expiresAt: number;
}

/** Mirrors `mobile_devices::DeviceView`; timestamps are unix seconds. */
export interface MobileDevice {
  id: string;
  name: string;
  tailscaleLogin: string | null;
  createdAt: number;
  lastSeen: number | null;
}

export interface MobileSettings {
  enabled: boolean;
  port: number | null;
  devices: MobileDevice[];
}

export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.floor(expiresAt - now));
}

/** "never" / "just now" / "5 min ago" … for a unix-seconds timestamp. */
export function lastSeenLabel(lastSeen: number | null, now: number): string {
  if (lastSeen == null) return "never";
  const d = Math.max(0, now - lastSeen);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}
