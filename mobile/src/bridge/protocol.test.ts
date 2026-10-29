import { attachMsg, authMsg, discoverMsg, inputMsg, interruptMsg, listMsg, pairMsg, promptInput } from "./protocol";

describe("promptInput", () => {
  it("prompt_enter_falls_outside_the_paste", () => {
    // Same bytes as the desktop's pty::paste_and_submit("ship it").
    expect(promptInput("ship it")).toBe("\u001b[200~ship it\u001b[201~\r");
    // A long line is the case that sat unsent with a bare text + "\r".
    const long = "x".repeat(800);
    expect(promptInput(long).endsWith("\u001b[201~\r")).toBe(true);
  });

  it("newlines_stay_inside_and_escape_cannot_close_early", () => {
    expect(promptInput("a\nb")).toBe("\u001b[200~a\nb\u001b[201~\r");
    expect(promptInput("safe\u001b[201~rm -rf /")).toBe("\u001b[200~safe[201~rm -rf /\u001b[201~\r");
  });
});

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
