import { safeLink } from "./links";

describe("safeLink", () => {
  it("allows http, https and mailto, and names the host", () => {
    expect(safeLink("https://docs.expo.dev/versions/v56.0.0/")).toEqual({
      ok: true,
      url: "https://docs.expo.dev/versions/v56.0.0/",
      host: "docs.expo.dev",
    });
    expect(safeLink("HTTP://Example.COM:8080/x?y#z")).toMatchObject({ ok: true, host: "example.com" });
    expect(safeLink("mailto:someone@Example.org?subject=hi")).toMatchObject({ ok: true, host: "example.org" });
  });

  it("shows the real host, not a userinfo disguise", () => {
    expect(safeLink("https://apple.com@evil.example/login")).toMatchObject({ ok: true, host: "evil.example" });
  });

  it("refuses every other scheme and anything malformed", () => {
    for (const u of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "tel:+15555555555",
      "sms:123",
      "conduit://open",
      "prefs:root=General",
      "/relative/path",
      "relative",
      "https:no-slashes",
      "https://",
      "https://exa mple.com",
      "https://example.com/\u0000",
      "mailto:nobody",
      "mailto:@example.com",
      "",
      undefined,
      null,
    ]) {
      expect(safeLink(u as string)).toEqual({ ok: false });
    }
  });
});
