import { isLoopbackMac, loopbackMac, parseManualAddress } from "./macs";

describe("loopbackMac", () => {
  it("is_a_uniform_saved_mac_without_a_token", () => {
    const m = loopbackMac({ port: 8460, macName: "Dev", conduitVersion: "0.5" }, 42);
    expect(m).toEqual({
      deviceId: "loopback-8460",
      token: "",
      macName: "Dev",
      dnsName: "localhost",
      ip: "127.0.0.1",
      port: 8460,
      pairedAt: 42,
    });
    expect(isLoopbackMac(m)).toBe(true);
    expect(isLoopbackMac({ ...m, token: "t" })).toBe(false);
  });
});

describe("parseManualAddress", () => {
  it("dns_name", () => {
    expect(parseManualAddress(" Studio.tail1.ts.net. ", "8460")).toEqual({
      ok: true,
      endpoint: { macName: "Studio", dnsName: "studio.tail1.ts.net", ip: "", port: 8460 },
    });
  });
  it("ipv4", () => {
    expect(parseManualAddress("100.64.0.2", "8455")).toEqual({
      ok: true,
      endpoint: { macName: "100.64.0.2", dnsName: "", ip: "100.64.0.2", port: 8455 },
    });
  });
  it("rejects_bad_port_and_host", () => {
    expect(parseManualAddress("studio", "80").ok).toBe(false);
    expect(parseManualAddress("studio", "84x").ok).toBe(false);
    expect(parseManualAddress("", "8455").ok).toBe(false);
    expect(parseManualAddress("ws://studio", "8455").ok).toBe(false);
    expect(parseManualAddress("300.1.1.1", "8455").ok).toBe(false);
  });
});
