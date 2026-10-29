import { describe, expect, it } from "vitest";
import kinds from "../src-tauri/src/transcript_item_kinds.json";
import {
  RENDERED_KINDS,
  groupTools,
  imageSrc,
  taskLine,
  groupLabel,
  type Call,
  type TranscriptItem,
} from "./chatItems";

type Ev = Extract<TranscriptItem, { kind: "event" }>;

/** The label Rust emits for each event kind. */
const LABELS: Record<string, string> = {
  read: "read",
  bash: "ran",
  edit: "edited",
  search: "searched",
  web: "browsed",
  subagent: "subagent",
  generic: "used a tool",
};
const ev = (kind: string, mono: string, id: string | null = null): Ev => ({
  kind: "event",
  event: kind,
  label: LABELS[kind],
  mono,
  toolUseId: id,
});
const res = (id: string, over: Record<string, unknown> = {}): TranscriptItem =>
  ({ kind: "result", toolUseId: id, isError: false, errorText: null, diff: null, ...over }) as TranscriptItem;
const usage: TranscriptItem = { kind: "usage", model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
const asst = (text: string): TranscriptItem => ({ kind: "bubble", role: "assistant", text });
const diff = { filePath: "a", added: 1, removed: 0, created: false, lines: [], more: 0 };
const types = (rows: { type: string }[]) => rows.map((r) => r.type);

describe("chatItems", () => {
  it("renders every kind Rust can emit except usage", () => {
    expect([...RENDERED_KINDS].sort()).toEqual(kinds.filter((k) => k !== "usage").sort());
  });

  it("pairs_result_across_interleaved_items", () => {
    const rows = groupTools([ev("read", "a", "A"), usage, ev("read", "b", "B"), res("A"), res("B")]);
    expect(types(rows)).toEqual(["tools"]);
    const r = rows[0];
    expect(r.type === "tools" && r.calls.map((c) => c.status)).toEqual(["ok", "ok"]);
    const rows2 = groupTools([ev("read", "a", "A"), asst("hi"), res("A")]);
    expect(types(rows2)).toEqual(["call", "item"]);
    expect(rows2[0].type === "call" && rows2[0].call.status).toBe("ok");
  });

  const st = (r: { type: string }) => (r.type === "call" ? (r as unknown as { call: Call }).call.status : null);

  it("last call without result is running", () => {
    const rows = groupTools([ev("read", "a", "A"), res("A"), ev("read", "b", "B")]);
    expect(types(rows)).toEqual(["call", "call"]);
    expect(st(rows[1])).toBe("running");
  });

  it("earlier call without result is unknown", () => {
    const rows = groupTools([ev("read", "b", "B"), asst("x"), ev("bash", "ls", "C")]);
    expect(st(rows[0])).toBe("unknown");
    expect(st(rows[2])).toBe("running");
  });

  it("parallel calls without results are all running", () => {
    const rows = groupTools([ev("read", "a", "A"), ev("read", "b", "B"), ev("bash", "c", "C")]);
    expect(types(rows)).toEqual(["call", "call", "call"]);
    expect(rows.map(st)).toEqual(["running", "running", "running"]);
  });

  it("call without result followed by a bubble is unknown", () => {
    const rows = groupTools([ev("read", "a", "A"), asst("x")]);
    expect(st(rows[0])).toBe("unknown");
  });

  it("two quiet calls fold, a failed call between them splits the run", () => {
    const rows = groupTools([
      ev("read", "a", "A"),
      ev("bash", "x", "B"),
      ev("read", "c", "C"),
      res("A"),
      res("B", { isError: true, errorText: "boom" }),
      res("C"),
    ]);
    expect(types(rows)).toEqual(["call", "call", "call"]);
    expect(rows[1].type === "call" && rows[1].call.errorText).toBe("boom");
    expect(types(groupTools([ev("read", "a", "A"), ev("read", "b", "B"), res("A"), res("B")]))).toEqual(["tools"]);
  });

  it("three quiet calls fold into tools", () => {
    const rows = groupTools([ev("read", "a", "A"), ev("read", "b", "B"), ev("bash", "c", "C"), res("A"), res("B"), res("C")]);
    expect(types(rows)).toEqual(["tools"]);
    expect(rows[0].type === "tools" && rows[0].calls.length).toBe(3);
  });

  it("edit with diff stays standalone", () => {
    const rows = groupTools([ev("edit", "a", "A"), ev("edit", "b", "B"), res("A", { diff }), res("B", { diff })]);
    expect(types(rows)).toEqual(["call", "call"]);
    expect(rows[0].type === "call" && rows[0].call.diff).toEqual(diff);
  });

  it("orphan result is dropped", () => {
    expect(groupTools([res("ZZ"), asst("x")]).map((r) => r.type)).toEqual(["item"]);
  });

  it("keys: call by its event seq, tools by first call seq", () => {
    const rows = groupTools([
      { ...ev("read", "a", "A"), seq: 402 },
      { ...ev("read", "b", "B"), seq: 404 },
      res("A"),
      res("B"),
    ]);
    expect(rows[0].type === "tools" && rows[0].calls[0].event.seq).toBe(402);
  });

  it("groupLabel buckets", () => {
    const c = (kind: string): Call => ({ event: ev(kind, "x"), status: "ok", errorText: null, diff: null });
    expect(groupLabel([c("bash"), c("bash"), c("read")])).toBe("Ran 2 shell commands, read 1 file");
    expect(groupLabel([c("search")])).toBe("Searched 1 time");
    expect(groupLabel([c("generic"), c("subagent"), c("web")])).toBe("Called 2 tools, browsed 1 page");
  });

  it("taskLine maps statuses", () => {
    expect(taskLine("completed")).toEqual({ mark: "ok", text: "Background task finished" });
    expect(taskLine("stopped").mark).toBe("info");
    expect(taskLine("failed").mark).toBe("bad");
    expect(taskLine("weird").text).toBe("Background task update");
  });
});

describe("imageSrc", () => {
  it("accepts raster types", () => {
    expect(imageSrc({ mediaType: "image/png", data: "AAA" })).toBe("data:image/png;base64,AAA");
  });
  it.each(["text/html", "image/svg+xml", "image/png;foo"])("rejects %s", (mediaType) => {
    expect(imageSrc({ mediaType, data: "AAA" })).toBeNull();
  });
  it("rejects null data", () => {
    expect(imageSrc({ mediaType: "image/png", data: null })).toBeNull();
  });
});
