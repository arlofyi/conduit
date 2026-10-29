import { quickActionMsgs, quickActionsFor } from "./quickActions";

describe("quick actions", () => {
  it("offers Stop only while a turn is running", () => {
    expect(quickActionsFor(true).map((a) => a.id)).toEqual(["stop", "compact", "clear"]);
    expect(quickActionsFor(false).map((a) => a.id)).toEqual(["compact", "clear"]);
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
