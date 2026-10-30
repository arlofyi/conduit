import { answerMsg, approveMsg, attachMsg, authMsg, discoverMsg, inputMsg, interruptMsg, listMsg, pairMsg, promptInput, type ServerMsg } from "./protocol";

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

describe("answer + approve wire shapes", () => {
  // Pinned by bridge.rs `answer_msg_parses_camel_case` / `approve_msg_parses_camel_case`.
  it("client_frames_match_the_bridge", () => {
    expect(answerMsg("ask-3", { "Ship it?": "Yes" })).toEqual({ type: "answer", askId: "ask-3", answers: { "Ship it?": "Yes" } });
    expect(approveMsg("perm-1", true)).toEqual({ type: "approve", id: "perm-1", allow: true });
    expect(approveMsg("perm-1", false)).toEqual({ type: "approve", id: "perm-1", allow: false });
  });

  // The exact server frames from task-2/task-3 reports; this only has to type-check and round-trip.
  it("server_frames_type_check", () => {
    const frames: ServerMsg[] = [
      {
        type: "pending",
        asks: [
          {
            kind: "ask",
            id: "ask-3",
            sessionId: "s1",
            toolUseId: "toolu_1",
            questions: [{ question: "Ship?", header: "Ship", multiSelect: false, options: [{ label: "Yes", description: "" }] }],
            createdMs: 1761800000000,
          },
          { kind: "ask", id: "ask-4", sessionId: "s2", private: true },
        ],
        permissions: [
          { kind: "permission", id: "perm-1", sessionId: "s1", toolName: "Bash", summary: "touch a.txt", createdMs: 1761800000000 },
          { kind: "permission", id: "perm-2", sessionId: "s2", private: true },
        ],
      },
      { type: "pendingAdded", item: { kind: "permission", id: "perm-3", sessionId: "s1", toolName: "Edit", summary: "a.ts", createdMs: 1 } },
      { type: "resolved", id: "ask-3", by: "phone" },
      { type: "answerResult", askId: "ask-3", ok: true },
      { type: "approveResult", id: "perm-1", ok: false },
    ];
    expect(JSON.parse(JSON.stringify(frames))).toEqual(frames);
  });
});
