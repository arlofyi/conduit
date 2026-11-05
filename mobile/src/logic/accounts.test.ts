import type { WireProjectsView } from "../bridge/protocol";
import { mapProjectsView } from "../bridge/live";
import { accountOptions, accountsFor, currentAccountRef, suggestedAccount } from "./accounts";
import type { UsageRow } from "./usage";

const view: WireProjectsView = mapProjectsView({
  profiles: [],
  activeProfileId: null,
  projects: [
    { id: "p1", name: "Conduit", profileId: null, color: null, sessions: [{ id: "s1", name: "S", agent: "claude", accountRef: "rB", accountLabel: "Personal" }], defaultAccounts: { claude: "rA" } },
    { id: "p2", name: "Other", profileId: null, color: null, sessions: [] },
  ],
  accounts: {
    list: [
      { ref: "rA", label: "Arlo", agents: ["claude"], usage: { claude: "uA" } },
      { ref: "rB", label: "Personal", agents: ["claude", "antigravity"], usage: { claude: "uB", antigravity: "uBg" } },
      { ref: 3, label: "broken" },
    ],
    defaultUsage: { claude: "uEnv" },
  },
});

const row = (key: string, week: number): UsageRow => ({
  key,
  agent: "claude",
  label: key,
  plan: null,
  windows: [
    { kind: "fiveHour", label: "5-hour", used: 0, resetsAt: null },
    { kind: "weekly", label: "Weekly", used: week, resetsAt: Date.now() + 86_400_000 },
  ],
  money: null,
  models: [],
  updatedAt: null,
  source: null,
});

describe("accounts on the phone", () => {
  it("maps the wire list defensively and carries session pins", () => {
    expect(view.accounts?.list.map((a) => a.label)).toEqual(["Arlo", "Personal"]);
    expect(view.projects[0].sessions[0].accountRef).toBe("rB");
    expect(view.projects[0].sessions[0].accountLabel).toBe("Personal");
    expect(currentAccountRef(view.projects[0].sessions[0])).toBe("rB");
    expect(currentAccountRef(view.projects[1].sessions[0])).toBe("");
  });
  it("lists only accounts tagged for the agent", () => {
    expect(accountsFor(view, "antigravity").map((a) => a.label)).toEqual(["Personal"]);
    expect(accountsFor(view, "codex")).toEqual([]);
    expect(accountOptions(view, "p1", "codex", null)).toEqual([]);
  });
  it("names the default it resolves to, and pairs each option with its usage", () => {
    const opts = accountOptions(view, "p1", "claude", [row("uA", 1), row("uB", 0.2)]);
    expect(opts.map((o) => o.label)).toEqual(["Default · Arlo", "Arlo", "Personal"]);
    expect(opts[0].availability.state).toBe("blocked");
    expect(opts[2].availability.state).toBe("ok");
    // A project with no default uses the computer's own login row.
    const other = accountOptions(view, "p2", "claude", [row("uEnv", 0.95)]);
    expect(other[0].label).toBe("Default");
    expect(other[0].availability.state).toBe("low");
  });
  it("suggests a usable account only when the default is spent", () => {
    expect(suggestedAccount(accountOptions(view, "p1", "claude", [row("uA", 1), row("uB", 0.2)]))).toBe("rB");
    expect(suggestedAccount(accountOptions(view, "p1", "claude", [row("uA", 0.5), row("uB", 0.2)]))).toBe("");
    expect(suggestedAccount(accountOptions(view, "p1", "claude", [row("uA", 1), row("uB", 1)]))).toBe("");
    // Unknown usage is never a reason to move.
    expect(suggestedAccount(accountOptions(view, "p1", "claude", null))).toBe("");
  });
});
