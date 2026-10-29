import { initialConn, type ConnState } from "../bridge/connection";
import { connErrorText, connStatus, pairFailText, qrErrorText } from "./connCopy";

describe("qrErrorText", () => {
  it("every_reason_has_copy", () => {
    expect(qrErrorText("notConduit")).toMatch(/isn't a Conduit/);
    expect(qrErrorText("version")).toMatch(/Update the app/);
    expect(qrErrorText("invalid")).toMatch(/new one/);
  });
});

describe("pairFailText", () => {
  it("maps_every_desktop_reason", () => {
    expect(pairFailText("declined")).toBe("Declined on the Mac");
    expect(pairFailText("expired")).toBe("No answer in 2 minutes");
    expect(pairFailText("off")).toBe("Mobile access is off on that Mac");
    expect(pairFailText("replaced")).toBe("Another request replaced this one");
    expect(pairFailText("error")).toBe("Couldn't pair");
    expect(pairFailText("whatever")).toBe("Couldn't pair");
  });
});

describe("connErrorText", () => {
  it("protocol_copy_follows_direction", () => {
    expect(connErrorText({ kind: "protocol", direction: "updateApp", macName: "Studio" })).toBe("Update the app");
    expect(connErrorText({ kind: "protocol", direction: "updateMac", macName: "Studio" })).toBe(
      "Update Conduit on Studio",
    );
  });
  it("revoked_names_the_mac", () => {
    expect(connErrorText({ kind: "revoked", macName: "Studio" })).toBe(
      "Studio removed this phone. Pair again to reconnect.",
    );
    expect(connErrorText({ kind: "revoked" }, "Home")).toMatch(/^Home removed/);
  });
});

describe("connStatus", () => {
  const at = (phase: ConnState["phase"], error?: ConnState["error"]): ConnState => ({ ...initialConn, phase, error });
  it("phases", () => {
    expect(connStatus(at("ready"), "Studio")).toEqual({ tone: "ok", text: "Connected · Studio" });
    expect(connStatus(at("authing"), "Studio").tone).toBe("busy");
    const unavailable = "Studio isn't accepting connections right now — mobile access may be off.";
    expect(connErrorText({ kind: "unavailable", macName: "Studio" })).toBe(unavailable);
    expect(connStatus(at("connecting", { kind: "unavailable" }), "Studio")).toEqual({ tone: "bad", text: unavailable });
    expect(connStatus(at("failed", { kind: "closed" }), "Studio")).toEqual({
      tone: "bad",
      text: "Couldn't reach Studio. Check that Tailscale is on.",
    });
  });
});
