import { attachMsg, authMsg, discoverMsg, inputMsg, interruptMsg, listMsg, pairMsg } from "./protocol";

describe("wire spellings", () => {
  it("wire_spellings_pinned", () => {
    expect(authMsg("tok")).toEqual({ type: "auth", token: "tok" });
    expect(pairMsg({ secret: "s", deviceName: "iPhone", nonce: "ab" })).toEqual({
      type: "pair",
      secret: "s",
      deviceName: "iPhone",
      nonce: "ab",
    });
    expect(pairMsg({ request: true, deviceName: "iPhone", nonce: "ab" })).toEqual({
      type: "pair",
      request: true,
      deviceName: "iPhone",
      nonce: "ab",
    });
    expect(discoverMsg()).toEqual({ type: "discover" });
    expect(listMsg()).toEqual({ type: "list" });
    expect(attachMsg("s1")).toEqual({ type: "attach", session_id: "s1" });
    expect(inputMsg("s1", "hi\r")).toEqual({ type: "input", session_id: "s1", data: "hi\r" });
    expect(interruptMsg("s1")).toEqual({ type: "interrupt", sessionId: "s1" });
    expect(Object.keys(pairMsg({ secret: "s", deviceName: "d", nonce: "n" }))).not.toContain("request");
    expect(Object.keys(pairMsg({ request: true, deviceName: "d", nonce: "n" }))).not.toContain("secret");
  });
});
