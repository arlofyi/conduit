import { describe, expect, it } from "vitest";
import kinds from "../src-tauri/src/transcript_item_kinds.json";
import {
  RENDERED_KINDS,
  groupTools,
  imageSrc,
  taskLine,
  toolsSummary,
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
const ev = (kind: string, mono: string): Ev => ({ kind: "event", event: kind, label: LABELS[kind], mono });

describe("chatItems", () => {
  it("renders every kind Rust can emit except usage", () => {
    expect([...RENDERED_KINDS].sort()).toEqual(kinds.filter((k) => k !== "usage").sort());
  });

  it("groupTools merges a run of events across usage lines", () => {
    const rows = groupTools([
      { kind: "bubble", role: "user", text: "go" },
      ev("read", "a.rs"),
      { kind: "usage", model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      ev("edit", "b.rs"),
      { kind: "bubble", role: "assistant", text: "done" },
    ]);
    expect(rows.map((r) => r.type)).toEqual(["item", "tools", "item"]);
    expect(rows[1].type === "tools" && rows[1].events.length).toBe(2);
  });

  it("toolsSummary counts repeated kinds", () => {
    expect(toolsSummary([ev("search", "busy_sessions"), ev("read", "a"), ev("read", "b"), ev("edit", "c")])).toBe(
      "searched busy_sessions · read 2 files · edited c",
    );
  });

  it("toolsSummary uses times for non-file kinds", () => {
    expect(toolsSummary([ev("bash", "ls"), ev("bash", "pwd")])).toBe("ran 2 times");
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
