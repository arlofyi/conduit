import {
  canRunNow,
  composerSuggestions,
  effortLevel,
  effortName,
  filterCommands,
  insertCommand,
  parseSessionOptions,
  renameValue,
  slashQuery,
  slashSuggestions,
  type CommandOption,
} from "./sessionOptions";

const CMDS: CommandOption[] = [
  { name: "compact", description: "Summarise the conversation", kind: "builtin" },
  { name: "clear", description: "Start fresh", kind: "builtin" },
  { name: "review", description: "Review a pull request", kind: "builtin" },
  { name: "deploy", description: "Ship to staging", kind: "command" },
  { name: "code-review", description: "Careful review of a diff", kind: "skill" },
];

describe("parseSessionOptions", () => {
  it("reads the frame defensively", () => {
    const o = parseSessionOptions({
      type: "sessionOptions",
      requestId: "r",
      sessionId: "s1",
      agent: "claude",
      model: "claude-opus-4-1",
      effort: "high",
      keepRunning: true,
      modelLive: true,
      models: [{ id: "opus", label: "Opus" }, "sonnet", { label: "no id" }],
      efforts: ["low", "medium", "high", 4],
      commands: [
        { name: "/compact", description: "x", kind: "builtin" },
        { name: "compact", description: "dup" },
        { name: "two words" },
        { name: "pdf", kind: "skill" },
        { name: "odd", kind: "weird" },
      ],
      mcps: [{ name: "github", source: "user", enabled: false }, { source: "x" }, { name: "fs" }],
    })!;
    expect(o.models).toEqual([{ id: "opus", label: "Opus" }, { id: "sonnet", label: "sonnet" }]);
    expect(o.efforts).toEqual(["low", "medium", "high"]);
    expect(o.commands).toEqual([
      { name: "compact", description: "x", kind: "builtin" },
      { name: "pdf", description: "", kind: "skill" },
      { name: "odd", description: "", kind: "builtin" },
    ]);
    expect(o.mcps).toEqual([{ name: "github", source: "user", enabled: false }, { name: "fs", source: "", enabled: true }]);
    expect(o.modelLive).toBe(true);
  });
  it("older/odd frames degrade", () => {
    expect(parseSessionOptions({ type: "sessionOptions" })).toBeNull();
    const o = parseSessionOptions({ type: "sessionOptions", sessionId: "s" })!;
    expect(o).toMatchObject({ model: null, effort: null, keepRunning: false, modelLive: false, models: [], commands: [] });
    expect(o.autoApprove).toBe(false);
    expect(o.autoApproveSupported).toBe(false);
  });
  it("reads auto-approve and whether the agent supports it", () => {
    const o = parseSessionOptions({ type: "sessionOptions", sessionId: "s", autoApprove: true, autoApproveSupported: true })!;
    expect(o.autoApprove).toBe(true);
    expect(o.autoApproveSupported).toBe(true);
    expect(parseSessionOptions({ type: "sessionOptions", sessionId: "s", autoApprove: "yes" })!.autoApprove).toBe(false);
  });
});

describe("slash completion", () => {
  it("slashQuery only for a bare /token", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/com")).toBe("com");
    expect(slashQuery("/compact now")).toBeNull();
    expect(slashQuery("hi /x")).toBeNull();
  });
  it("ranks prefix, then substring, then description", () => {
    expect(filterCommands(CMDS, "re").map((c) => c.name)).toEqual(["review", "code-review", "clear"]);
    expect(filterCommands(CMDS, "staging").map((c) => c.name)).toEqual(["deploy"]);
    expect(filterCommands(CMDS, "").length).toBe(5);
    expect(filterCommands(CMDS, "/comp").map((c) => c.name)).toEqual(["compact"]);
  });
  it("suggestions hide once the command is typed in full or an argument starts", () => {
    expect(slashSuggestions("/c", CMDS).map((c) => c.name)).toEqual(["compact", "clear", "code-review"]);
    expect(slashSuggestions("/compact", CMDS)).toEqual([]);
    expect(slashSuggestions("/compact ", CMDS)).toEqual([]);
    expect(slashSuggestions("hello", CMDS)).toEqual([]);
    expect(slashSuggestions("/", [], 6)).toEqual([]);
    expect(slashSuggestions("/", CMDS, 2)).toHaveLength(2);
  });
  it("insertCommand replaces a partial token, prefixes other text", () => {
    expect(insertCommand("", "compact")).toBe("/compact ");
    expect(insertCommand("/co", "compact")).toBe("/compact ");
    expect(insertCommand("  fix the bug", "/review")).toBe("/review fix the bug");
  });
  it("Run now only for no-argument built-ins", () => {
    expect(canRunNow(CMDS[0])).toBe(true);
    expect(canRunNow(CMDS[3])).toBe(false);
    expect(canRunNow({ name: "model", description: "", kind: "builtin" })).toBe(false);
  });
});

describe("effort", () => {
  it("places the effort in the agent's own list, else the common ladder", () => {
    expect(effortLevel("high", ["low", "medium", "high"])).toEqual({ filled: 5, steps: 5 });
    expect(effortLevel("low", ["low", "medium", "high"])).toEqual({ filled: 2, steps: 5 });
    expect(effortLevel("medium", [])).toEqual({ filled: 3, steps: 5 });
    expect(effortLevel("max", [])).toEqual({ filled: 5, steps: 5 });
    expect(effortLevel("weird", [])).toEqual({ filled: 3, steps: 5 });
    expect(effortLevel(null, [])).toBeNull();
  });
  it("names it", () => {
    expect(effortName("xhigh")).toBe("Extra high");
    expect(effortName("medium")).toBe("Medium");
  });
});

describe("renameValue", () => {
  it("trims, caps at 40, refuses blank or unchanged", () => {
    expect(renameValue("  new name ", "old")).toBe("new name");
    expect(renameValue("", "old")).toBeNull();
    expect(renameValue("old", "old")).toBeNull();
    expect(renameValue("x".repeat(50), "old")).toHaveLength(40);
  });
});

describe("composerSuggestions", () => {
  it("rows complete the token", () => {
    expect(composerSuggestions("/dep", CMDS)).toEqual([{ key: "deploy", label: "/deploy", detail: "custom · Ship to staging", insert: "/deploy " }]);
    expect(composerSuggestions("hi", CMDS)).toEqual([]);
  });
});
