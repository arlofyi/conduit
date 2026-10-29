import { PHONE_KINDS, appendWire, mapChatItem, mapHistory, mapProjectsView, sameView, statusPatch } from "./live";
import type { WireChatItem } from "./protocol";

describe("mapChatItem", () => {
  it("maps a user bubble", () => {
    const w: WireChatItem = { kind: "bubble", role: "user", text: "hi" };
    expect(mapChatItem(w)).toMatchObject({ kind: "bubble", role: "user", text: "hi" });
  });
  it("maps a tool event, defaulting unknown kinds to generic", () => {
    expect(mapChatItem({ kind: "event", event: "bash", label: "ran", mono: "npm test" })).toMatchObject({
      kind: "event",
      event: "bash",
      label: "ran",
      mono: "npm test",
    });
    expect(mapChatItem({ kind: "event", event: "weird", label: "did" })).toMatchObject({ event: "generic" });
  });
  it("keeps toolUseId on events and maps a result item", () => {
    expect(mapChatItem({ kind: "event", event: "read", label: "read", toolUseId: "T1" })).toMatchObject({
      toolUseId: "T1",
    });
    expect(
      mapChatItem({ kind: "result", toolUseId: "T1", isError: true, errorText: "boom", diff: null }),
    ).toMatchObject({ kind: "result", toolUseId: "T1", isError: true, errorText: "boom", diff: null });
  });
  it("appendWire keeps a late result in the feed", () => {
    const feed = appendWire(appendWire([], { kind: "event", event: "bash", label: "ran", toolUseId: "T" }), {
      kind: "result",
      toolUseId: "T",
      isError: false,
      errorText: null,
      diff: null,
    });
    expect(feed.map((i) => i.kind)).toEqual(["event", "result"]);
  });
  it("carries the line's time and omits it when absent", () => {
    expect(mapChatItem({ kind: "bubble", role: "user", text: "hi", at: "2026-10-29T20:11:42.123Z" })?.at).toBe(
      "2026-10-29T20:11:42.123Z",
    );
    expect(mapChatItem({ kind: "divider", label: "x", tone: "info" })).not.toHaveProperty("at");
  });
  it("assigns an id", () => {
    expect(mapChatItem({ kind: "bubble", role: "assistant", text: "yo" })?.id).toBeTruthy();
  });
});

const kinds: string[] = require("../../../src-tauri/src/transcript_item_kinds.json");
describe("phone item mapping", () => {
  it("handles every kind Rust can emit except usage", () => {
    expect([...PHONE_KINDS].sort()).toEqual(kinds.filter((k) => k !== "usage").sort());
  });
  it("mapChatItem drops usage and unknown kinds", () => {
    expect(mapChatItem({ kind: "usage" } as never)).toBeNull();
    expect(mapChatItem({ kind: "from-the-future" } as never)).toBeNull();
  });
  it("task becomes an ok notice with the summary as detail", () => {
    const n = mapChatItem({ kind: "task", taskId: "b1", status: "completed", summary: "exit 0" });
    expect(n).toMatchObject({ kind: "notice", tone: "ok", text: "Background task finished", detail: "exit 0" });
  });
  it("mapHistory folds command output into its command", () => {
    const out = mapHistory([
      { kind: "command", name: "/compact", args: "" },
      { kind: "command_output", text: "Compacted", stream: "stdout" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "command", name: "/compact", output: "Compacted" });
  });
});

describe("appendWire", () => {
  const cmd = { kind: "command", name: "/x", args: "" } as const;
  const out = (text: string) => ({ kind: "command_output", text, stream: "stdout" }) as const;
  it("folds command_output into the previous command", () => {
    const feed = appendWire(appendWire([], cmd), out("done"));
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "command", name: "/x", output: "done" });
  });
  it("a lone command_output becomes a nameless command", () => {
    expect(appendWire([], out("hi"))[0]).toMatchObject({ kind: "command", name: "", output: "hi" });
  });
  it("leaves the feed unchanged for a null-mapped item", () => {
    const feed = appendWire([], cmd);
    expect(appendWire(feed, { kind: "usage" } as never)).toBe(feed);
  });
  it("does not overwrite an already-folded output", () => {
    const feed = appendWire(appendWire(appendWire([], cmd), out("one")), out("two"));
    expect(feed).toHaveLength(2);
    expect(feed[0]).toMatchObject({ output: "one" });
    expect(feed[1]).toMatchObject({ name: "", output: "two" });
  });
});

describe("task status table", () => {
  const t = (status: string) => mapChatItem({ kind: "task", taskId: null, status, summary: "s" });
  it("maps failed, stopped and unknown", () => {
    expect(t("failed")).toMatchObject({ tone: "bad", text: "Background task failed" });
    expect(t("stopped")).toMatchObject({ tone: "info", text: "Background task stopped" });
    expect(t("wat")).toMatchObject({ tone: "info", text: "Background task update" });
  });
});

describe("mapProjectsView", () => {
  const session = {
    id: "s1",
    name: "auth",
    agent: "claude",
    branch: "feat/x",
    model: "opus",
    stopped: false,
    running: true,
    silo: false,
    status: "running",
    activity: "Editing x.ts",
    updatedAt: 1700000000000,
    needs: { kind: "ask", text: "Ship it?" },
    lastMessage: { role: "assistant", text: "Done: tests pass.", at: "2026-10-29T20:11:42.123Z" },
  };
  const frame = {
    type: "projects",
    profiles: [{ id: null, name: "Default" }, { id: "w", name: "Work" }],
    activeProfileId: "w",
    projects: [{ id: "p1", name: "Conduit", profileId: "w", color: "#123456", sessions: [session] }],
  };

  it("carries the typed view through without the frame tag", () => {
    const v = mapProjectsView(frame);
    expect(v).not.toHaveProperty("type");
    expect(v.activeProfileId).toBe("w");
    expect(v.profiles).toEqual(frame.profiles);
    expect(v.projects[0]).toEqual({ ...frame.projects[0], sessions: [session] });
  });

  it("never lets a silo session carry activity or question text", () => {
    const v = mapProjectsView({
      ...frame,
      projects: [{ ...frame.projects[0], sessions: [{ ...session, silo: true }] }],
    });
    expect(v.projects[0].sessions[0]).toMatchObject({
      silo: true,
      activity: null,
      needs: { kind: "input", text: null },
      lastMessage: null,
    });
  });

  it("reads lastMessage defensively (Task 8a shape)", () => {
    const one = (lastMessage: unknown) =>
      mapProjectsView({ ...frame, projects: [{ ...frame.projects[0], sessions: [{ ...session, lastMessage }] }] })
        .projects[0].sessions[0].lastMessage;
    expect(one({ role: "user", text: "hi", at: null })).toEqual({ role: "user", text: "hi", at: null });
    expect(one({ role: "system", text: "x", at: null })).toBeNull();
    expect(one({ role: "user", text: 3 })).toBeNull();
    expect(one(undefined)).toBeNull();
  });

  it("degrades a malformed frame instead of throwing", () => {
    const v = mapProjectsView({
      projects: [{ id: "p", sessions: [{ id: "s", status: "weird", updatedAt: 0 }, { name: "no id" }] }, { name: "x" }],
    });
    expect(v.profiles).toEqual([{ id: null, name: "Default" }]);
    expect(v.projects).toHaveLength(1);
    expect(v.projects[0].sessions).toEqual([
      {
        id: "s",
        name: "s",
        agent: "",
        branch: null,
        model: null,
        stopped: false,
        running: false,
        silo: false,
        status: "idle",
        activity: null,
        updatedAt: null,
        needs: null,
        lastMessage: null,
      },
    ]);
  });
});

describe("statusPatch", () => {
  it("prompt → running and clears activity", () => {
    expect(statusPatch("prompt", {})).toMatchObject({ status: "running", clearActivity: true });
  });
  it("pretool → running with activity label", () => {
    expect(statusPatch("pretool", { tool_name: "Edit", tool_input: { file_path: "src/x.ts" } })).toMatchObject({
      status: "running",
      activity: "Editing x.ts",
    });
  });
  it("todos → progress, running when any in_progress", () => {
    const body = { tool_input: { todos: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }] } };
    expect(statusPatch("todos", body)).toMatchObject({ todos: { done: 1, total: 3 }, status: "running" });
  });
  it("stop → done, notification → needsInput, sessionend → idle", () => {
    expect(statusPatch("stop", {})).toMatchObject({ status: "done" });
    expect(statusPatch("notification", { message: "needs you" })).toMatchObject({ status: "needsInput" });
    expect(statusPatch("sessionend", {})).toMatchObject({ status: "idle" });
  });
  it("unknown verb → empty patch", () => {
    expect(statusPatch("mystery", {})).toEqual({});
  });
});

describe("sameView", () => {
  const frame = () => ({
    type: "projects",
    profiles: [{ id: null, name: "Default" }],
    activeProfileId: null,
    projects: [{ id: "p", name: "P", profileId: null, color: null, sessions: [{ id: "s", name: "S", status: "running" }] }],
  });

  it("is true for a deep-equal frame and false for any change", () => {
    const a = mapProjectsView(frame());
    expect(sameView(a, mapProjectsView(frame()))).toBe(true);
    const f = frame();
    f.projects[0].sessions[0].status = "done";
    expect(sameView(a, mapProjectsView(f))).toBe(false);
    expect(sameView(null, a)).toBe(false);
  });
});
