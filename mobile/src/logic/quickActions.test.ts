import { quickActionMsgs, quickActionsFor } from "./quickActions";

describe("quick actions", () => {
  it("offers Stop only while a turn is running", () => {
    expect(quickActionsFor(true, "claude").map((a) => a.id)).toEqual(["stop", "compact", "clear"]);
    expect(quickActionsFor(false, "claude").map((a) => a.id)).toEqual(["compact", "clear"]);
  });

  it("offers Compact and Clear only to Claude; Stop to every agent", () => {
    expect(quickActionsFor(true, "hermes").map((a) => a.id)).toEqual(["stop"]);
    expect(quickActionsFor(false, "codex").map((a) => a.id)).toEqual([]);
    expect(quickActionsFor(true, "").map((a) => a.id)).toEqual(["stop"]);
  });

  it("asks before Clear, which throws the conversation away", () => {
    const clear = quickActionsFor(false, "claude").find((a) => a.id === "clear");
    expect(clear?.confirm).toBeTruthy();
    expect(quickActionsFor(false, "claude").find((a) => a.id === "compact")?.confirm).toBeUndefined();
  });

  it("maps each action to the frames the bridge accepts", () => {
    expect(quickActionMsgs("stop", "s1")).toEqual([{ type: "interrupt", sessionId: "s1" }]);
    // slash commands are submitted like a typed prompt: bracketed paste, then Enter
    expect(quickActionMsgs("compact", "s1")).toEqual([
      { type: "input", session_id: "s1", data: "\u001b[200~/compact\u001b[201~\r" },
    ]);
    expect(quickActionMsgs("clear", "s1")).toEqual([
      { type: "input", session_id: "s1", data: "\u001b[200~/clear\u001b[201~\r" },
    ]);
  });
});
