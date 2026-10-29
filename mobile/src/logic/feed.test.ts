import type { ChatItem, EventItem, ResultItem } from "../data/types";
import {
  appendAssistantReply,
  appendPrompt,
  groupFeed,
  groupLabel,
  type Call,
  type FeedRow,
  pendingApproval,
  resolveApproval,
} from "./feed";

describe("appendPrompt", () => {
  it("appends a trimmed user bubble", () => {
    const out = appendPrompt([], "  hello  ", "u-1");
    expect(out).toEqual([{ kind: "bubble", id: "u-1", role: "user", text: "hello" }]);
  });
  it("ignores empty/whitespace prompts", () => {
    expect(appendPrompt([], "   ", "u-9")).toEqual([]);
  });
  it("does not mutate the input array", () => {
    const input: ChatItem[] = [];
    appendPrompt(input, "x", "u-2");
    expect(input).toEqual([]);
  });
});

describe("appendAssistantReply", () => {
  it("appends an assistant bubble", () => {
    expect(appendAssistantReply([], "on it", "a-1")).toEqual([
      { kind: "bubble", id: "a-1", role: "assistant", text: "on it" },
    ]);
  });
});

describe("resolveApproval", () => {
  const feed: ChatItem[] = [
    { kind: "bubble", id: "u", role: "user", text: "hi" },
    { kind: "approval", id: "ap-1", tool: "Bash", input: "rm -rf x" },
  ];
  it("marks the matching approval allowed/denied", () => {
    expect(resolveApproval(feed, "ap-1", "allow")[1]).toMatchObject({ resolved: "allow" });
    expect(resolveApproval(feed, "ap-1", "deny")[1]).toMatchObject({ resolved: "deny" });
  });
  it("leaves other items untouched", () => {
    expect(resolveApproval(feed, "ap-1", "allow")[0]).toEqual(feed[0]);
  });
  it("is a no-op for unknown ids", () => {
    expect(resolveApproval(feed, "nope", "allow")).toEqual(feed);
  });
});

describe("pendingApproval", () => {
  it("finds the first unresolved approval", () => {
    const feed: ChatItem[] = [
      { kind: "approval", id: "ap-1", tool: "Bash", input: "a", resolved: "allow" },
      { kind: "approval", id: "ap-2", tool: "Bash", input: "b" },
    ];
    expect(pendingApproval(feed)?.id).toBe("ap-2");
  });
  it("returns null when all are resolved", () => {
    const feed: ChatItem[] = [{ kind: "approval", id: "ap-1", tool: "Bash", input: "a", resolved: "deny" }];
    expect(pendingApproval(feed)).toBeNull();
  });
});

describe("groupFeed", () => {
  const ev = (kind: EventItem["event"], mono: string, toolUseId?: string, id?: string): EventItem => ({
    kind: "event",
    id: id ?? `e-${mono}`,
    event: kind,
    label: kind,
    mono,
    toolUseId,
  });
  const res = (toolUseId: string, over: Partial<ResultItem> = {}): ResultItem => ({
    kind: "result",
    id: `r-${toolUseId}`,
    toolUseId,
    isError: false,
    errorText: null,
    diff: null,
    ...over,
  });
  const asst = (text: string): ChatItem => ({ kind: "bubble", id: `b-${text}`, role: "assistant", text });
  const diff = { filePath: "a", added: 1, removed: 0, created: false, lines: [], more: 0 };
  const types = (rows: { type: string }[]) => rows.map((r) => r.type);
  const status = (r: FeedRow) => (r.type === "call" ? r.call.status : null);

  it("pairs_result_across_interleaved_items", () => {
    const rows = groupFeed([ev("read", "a", "A"), ev("read", "b", "B"), res("A"), res("B")]);
    expect(types(rows)).toEqual(["tools"]);
    const r = rows[0];
    expect(r.type === "tools" && r.calls.map((c) => c.status)).toEqual(["ok", "ok"]);
    const rows2 = groupFeed([ev("read", "a", "A"), asst("hi"), res("A")]);
    expect(types(rows2)).toEqual(["call", "item"]);
    expect(status(rows2[0])).toBe("ok");
  });

  it("last call without result is running", () => {
    const rows = groupFeed([ev("read", "a", "A"), res("A"), ev("read", "b", "B")]);
    expect(types(rows)).toEqual(["call", "call"]);
    expect(status(rows[1])).toBe("running");
  });

  it("earlier call without result is unknown", () => {
    const rows = groupFeed([ev("read", "b", "B"), asst("moved on"), ev("bash", "ls", "C")]);
    expect(status(rows[0])).toBe("unknown");
    expect(status(rows[2])).toBe("running");
  });

  it("parallel calls without results are all running", () => {
    const rows = groupFeed([ev("read", "a", "A"), ev("read", "b", "B"), ev("bash", "c", "C")]);
    expect(types(rows)).toEqual(["call", "call", "call"]);
    expect(rows.map(status)).toEqual(["running", "running", "running"]);
  });

  it("call without result followed by a bubble is unknown", () => {
    expect(status(groupFeed([ev("read", "a", "A"), asst("hi")])[0])).toBe("unknown");
  });

  it("two quiet calls fold, a failed call between them splits the run", () => {
    const rows = groupFeed([
      ev("read", "a", "A"),
      ev("bash", "x", "B"),
      ev("read", "c", "C"),
      res("A"),
      res("B", { isError: true, errorText: "boom" }),
      res("C"),
    ]);
    expect(types(rows)).toEqual(["call", "call", "call"]);
    const r = rows[1];
    expect(r.type === "call" && r.call.errorText).toBe("boom");
    expect(types(groupFeed([ev("read", "a", "A"), ev("read", "b", "B"), res("A"), res("B")]))).toEqual(["tools"]);
  });

  it("three quiet calls fold into tools", () => {
    const rows = groupFeed([
      ev("read", "a", "A"),
      ev("read", "b", "B"),
      ev("bash", "c", "C"),
      res("A"),
      res("B"),
      res("C"),
    ]);
    expect(types(rows)).toEqual(["tools"]);
    expect(rows[0].type === "tools" && rows[0].calls.length).toBe(3);
  });

  it("edit with diff stays standalone", () => {
    const rows = groupFeed([ev("edit", "a", "A"), ev("edit", "b", "B"), res("A", { diff }), res("B", { diff })]);
    expect(types(rows)).toEqual(["call", "call"]);
    expect(rows[0].type === "call" && rows[0].call.diff).toEqual(diff);
  });

  it("orphan result is dropped", () => {
    expect(types(groupFeed([res("ZZ"), asst("x")]))).toEqual(["item"]);
  });

  it("a result arriving later updates its call on the next grouping", () => {
    const before = [ev("bash", "ls", "A")];
    expect(status(groupFeed(before)[0])).toBe("running");
    expect(status(groupFeed([...before, res("A", { isError: true, errorText: "no" })])[0])).toBe("error");
  });

  it("keys: tools row by its first call's event id", () => {
    const rows = groupFeed([ev("read", "a", "A", "e1"), ev("read", "b", "B", "e2"), res("A"), res("B")]);
    expect(rows[0].type === "tools" && rows[0].id).toBe("tools-e1");
  });
});

describe("groupLabel", () => {
  const c = (kind: EventItem["event"]): Call => ({
    event: { kind: "event", id: kind, event: kind, label: kind },
    status: "ok",
    errorText: null,
    diff: null,
  });
  it("buckets", () => {
    expect(groupLabel([c("bash"), c("bash"), c("read")])).toBe("Ran 2 shell commands, read 1 file");
    expect(groupLabel([c("search")])).toBe("Searched 1 time");
    expect(groupLabel([c("generic"), c("subagent"), c("web")])).toBe("Called 2 tools, browsed 1 page");
  });
});
