import { rootChatCreateMsg, rootChatOptionsMsg, rootChatSettingsMsg, rootChatHistoryMsg, rootChatScopeMsg, rootChatSendMsg, rootChatsMsg, rootChatStopMsg, answerMsg, fsAckMsg, fsDownloadMsg, fsListMsg, fsReadMsg, fsWriteMsg, approveMsg, attachMsg, authMsg, discoverMsg, inputMsg, interruptMsg, listMsg, pairMsg, promptInput, type ServerMsg } from "./protocol";

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

describe("file browser frames", () => {
  it("fs_spellings_match_bridge_rs", () => {
    // Same JSON the Rust test in bridge.rs parses (camelCase, lowercase type).
    expect(fsListMsg("s", "r", "")).toEqual({ type: "fslist", sessionId: "s", requestId: "r", path: "" });
    expect(fsReadMsg("s", "r", "a")).toEqual({ type: "fsread", sessionId: "s", requestId: "r", path: "a" });
    expect(fsReadMsg("s", "r", "a", true)).toEqual({ type: "fsread", sessionId: "s", requestId: "r", path: "a", confirm: true });
    expect(fsWriteMsg("s", "r", "a", "x", { mtimeMs: 1.5, size: 1 })).toEqual({
      type: "fswrite",
      sessionId: "s",
      requestId: "r",
      path: "a",
      content: "x",
      baseMtimeMs: 1.5,
      baseSize: 1,
    });
    expect(fsDownloadMsg("s", "r", "a", true)).toEqual({ type: "fsdownload", sessionId: "s", requestId: "r", path: "a", confirm: true });
    expect(fsAckMsg("r")).toEqual({ type: "fsack", requestId: "r" });
  });
});

describe("general chat frames", () => {
  it("root_chat_spellings_match_bridge_rs", () => {
    // Same JSON bridge.rs `parse_client_msg` tests parse (lowercase type, camelCase fields).
    expect(rootChatsMsg()).toEqual({ type: "rootchats" });
    const scope = { allProfiles: false, profiles: [null, "work"], projects: ["p1"] };
    expect(rootChatCreateMsg("r", null, scope)).toEqual({ type: "rootchatcreate", requestId: "r", profileId: null, scope });
    expect(rootChatHistoryMsg("c")).toEqual({ type: "rootchathistory", chatId: "c" });
    expect(rootChatSendMsg("c", "hi")).toEqual({ type: "rootchatsend", chatId: "c", text: "hi" });
    expect(rootChatStopMsg("c")).toEqual({ type: "rootchatstop", chatId: "c" });
    expect(rootChatScopeMsg("c", null)).toEqual({ type: "rootchatscope", chatId: "c", scope: null });
    expect(JSON.stringify(rootChatScopeMsg("c", scope))).toBe(
      '{"type":"rootchatscope","chatId":"c","scope":{"allProfiles":false,"profiles":[null,"work"],"projects":["p1"]}}',
    );
  });

  it("root_chat_options_frames_match_the_contract", () => {
    const scope = { allProfiles: true, profiles: [], projects: [] };
    expect(rootChatCreateMsg("r", "work", scope, { agent: "antigravity", model: undefined, effort: "high", research: true, mcps: ["github"] })).toEqual({
      type: "rootchatcreate",
      requestId: "r",
      profileId: "work",
      scope,
      agent: "antigravity",
      effort: "high",
      research: true,
      mcps: ["github"],
    });
    expect(rootChatSettingsMsg("c", "q", { model: "", research: false })).toEqual({
      type: "rootchatsettings",
      chatId: "c",
      requestId: "q",
      model: "",
      research: false,
    });
    expect(rootChatOptionsMsg("o")).toEqual({ type: "rootchatoptions", requestId: "o" });
  });
});

describe("session controls + usage frames (2026-11-01 spec)", () => {
  it("sessionset carries only the keys being changed", () => {
    const { sessionSetMsg, sessionOptionsMsg, usageMsg } = jest.requireActual("./protocol") as typeof import("./protocol");
    expect(sessionSetMsg("s1", "r1", { effort: "high" })).toEqual({ type: "sessionset", sessionId: "s1", requestId: "r1", effort: "high" });
    expect(sessionSetMsg("s1", "r2", { keepRunning: false, name: "x" })).toEqual({
      type: "sessionset",
      sessionId: "s1",
      requestId: "r2",
      name: "x",
      keepRunning: false,
    });
    expect(sessionOptionsMsg("s1", "r3")).toEqual({ type: "sessionoptions", sessionId: "s1", requestId: "r3" });
    expect(usageMsg("r4")).toEqual({ type: "usage", requestId: "r4" });
  });
});
