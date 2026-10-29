import { PHONE_KINDS, appendWire, mapChatItem, mapHistory, mapProjects, statusPatch } from "./live";
import type { WireChatItem, WireProject } from "./protocol";

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

describe("mapProjects", () => {
  it("maps wire projects to UI projects with running→status", () => {
    const wire: WireProject[] = [
      {
        id: "p1",
        name: "Conduit",
        path: "/repo",
        sessions: [
          { id: "s1", name: "auth", branch: "feat/x", agent: "claude", running: true },
          { id: "s2", name: "idle-one", branch: null, agent: "codex", running: false },
        ],
      },
    ];
    const out = mapProjects(wire);
    expect(out[0]).toMatchObject({ id: "p1", name: "Conduit", path: "/repo" });
    expect(out[0].agents[0]).toMatchObject({ id: "s1", name: "auth", branch: "feat/x", kind: "claude", status: "running" });
    expect(out[0].agents[1]).toMatchObject({ id: "s2", branch: "", kind: "codex", status: "idle" });
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
