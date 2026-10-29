import { describe, expect, it } from "vitest";
import { lastSeenLabel, qrSvg, secondsLeft, tailscaleRow, type TailscaleState } from "./mobilePairing";

describe("tailscaleRow", () => {
  it("not installed offers install", () => {
    expect(tailscaleRow({ state: "notInstalled" })).toEqual({
      label: "Tailscale is not installed",
      action: "install",
    });
  });
  it("stopped and needsLogin offer open", () => {
    expect(tailscaleRow({ state: "stopped" })).toEqual({ label: "Tailscale is off on this Mac", action: "open" });
    expect(tailscaleRow({ state: "needsLogin" })).toEqual({ label: "Sign in to Tailscale", action: "open" });
  });
  it("running shows tailnet and name, no action", () => {
    const s: TailscaleState = {
      state: "running",
      tailnet: "me.ts.net",
      selfName: "mac",
      dnsName: "mac.me.ts.net",
      ipv4: "100.1.2.3",
      ipv6: null,
      userId: 1,
    };
    expect(tailscaleRow(s)).toEqual({
      label: "Connected · me.ts.net · this Mac is mac.me.ts.net",
      action: null,
    });
  });
  it("unknown carries the reason", () => {
    expect(tailscaleRow({ state: "unknown", reason: "boom" })).toEqual({
      label: "Couldn't read Tailscale: boom",
      action: "open",
    });
  });
});

describe("qrSvg", () => {
  it("returns a deterministic svg", () => {
    const a = qrSvg('{"v":1}');
    expect(a.startsWith("<svg")).toBe(true);
    expect(qrSvg('{"v":1}')).toBe(a);
    expect(qrSvg('{"v":2}')).not.toBe(a);
  });
});

describe("lastSeenLabel", () => {
  it("formats", () => {
    expect(lastSeenLabel(null, 1000)).toBe("never");
    expect(lastSeenLabel(990, 1000)).toBe("just now");
    expect(lastSeenLabel(1000 - 300, 1000)).toBe("5 min ago");
    expect(lastSeenLabel(1000 - 7200, 1000)).toBe("2 h ago");
  });
});

describe("secondsLeft", () => {
  it("counts down and clamps at 0", () => {
    expect(secondsLeft(100, 70)).toBe(30);
    expect(secondsLeft(100, 100)).toBe(0);
    expect(secondsLeft(100, 500)).toBe(0);
  });
});
