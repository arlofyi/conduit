import { describe, expect, it } from "vitest";
import { AGENTS, agentMeta } from "./agents";

describe("AGENTS", () => {
  it("lists Conduit Code with the flags its CLI really takes", () => {
    const a = agentMeta("conduitcode");
    expect(a).toMatchObject({
      id: "conduitcode",
      label: "Conduit Code",
      supportsWorktree: false,
      supportsMcp: false,
      supportsModelFlags: true,
    });
    expect(a.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(a.supportsEndpoint).toBeFalsy();
  });

  it("gives every agent its own id", () => {
    const ids = AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
