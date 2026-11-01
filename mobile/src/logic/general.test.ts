import type { WireProjectsView, WireRootChatEvent } from "../bridge/protocol";
import { ALL_PROFILES } from "./chatList";
import {
  EMPTY_FEED,
  applyFeed,
  applyToList,
  chatOf,
  chatsForProfile,
  createProfileId,
  defaultScope,
  editableScope,
  projectCover,
  sameScope,
  scopeGroups,
  scopeSummary,
  setAllProfiles,
  toggleProfile,
  toggleProject,
  type RootChat,
  type RootFeed,
  EMPTY_CHAT_INFO,
  FALLBACK_OPTIONS,
  agentLabel,
  chatBadge,
  defaultSettings,
  emptyChatInfo,
  insertSkill,
  modelName,
  optionsOf,
  settingsPatch,
  skillSuggestions,
  toggleMcp,
  NEW_CHAT_SCOPE,
  EMPTY_CHAT_INFO_UNATTACHED,
  attachedItems,
  attachedSummary,
  detach,
  isUnattached,
  needsAgentChoice,
  preferredAgent,
  startAgents,
  startSettings,
} from "./general";

const view: WireProjectsView = {
  profiles: [
    { id: null, name: "Default" },
    { id: "work", name: "Work" },
  ],
  activeProfileId: "work",
  projects: [
    { id: "p1", name: "Zeta", profileId: "work", color: null, sessions: [] },
    { id: "p2", name: "Alpha", profileId: "work", color: null, sessions: [] },
    { id: "p3", name: "Home", profileId: null, color: null, sessions: [] },
    { id: "p4", name: "Orphan", profileId: "deleted", color: null, sessions: [] },
  ],
};

const chat = (id: string, profileId: string | null, createdAt: number, running = false): RootChat => ({
  id,
  title: id,
  profileId,
  scope: null,
  createdAt,
  running,
});

type EvBody = WireRootChatEvent extends infer E ? (E extends unknown ? Omit<E, "type"> : never) : never;
const ev = (e: EvBody): { t: "event"; ev: WireRootChatEvent } => ({
  t: "event",
  ev: { type: "rootChatEvent", ...e } as WireRootChatEvent,
});

describe("default scope + listing", () => {
  it("defaults_to_the_selected_profile_or_everything", () => {
    expect(defaultScope("work")).toEqual({ allProfiles: false, profiles: ["work"], projects: [] });
    expect(defaultScope(null)).toEqual({ allProfiles: false, profiles: [null], projects: [] });
    expect(defaultScope(ALL_PROFILES)).toEqual({ allProfiles: true, profiles: [], projects: [] });
  });

  it("lists_a_new_chat_under_the_selection_or_the_active_profile", () => {
    expect(createProfileId("work", view)).toBe("work");
    expect(createProfileId(null, view)).toBeNull();
    expect(createProfileId(ALL_PROFILES, view)).toBe("work");
    expect(createProfileId(ALL_PROFILES, null)).toBeNull();
  });

  it("filters_by_profile_newest_first", () => {
    const chats = [chat("a", "work", 1), chat("b", null, 3), chat("c", "work", 2), chat("d", "gone", 4)];
    expect(chatsForProfile(chats, "work", view).map((c) => c.id)).toEqual(["c", "a"]);
    // a profile deleted on the computer reads as Default
    expect(chatsForProfile(chats, null, view).map((c) => c.id)).toEqual(["d", "b"]);
    expect(chatsForProfile(chats, ALL_PROFILES, view).map((c) => c.id)).toEqual(["d", "b", "c", "a"]);
  });
});

describe("scope summary", () => {
  it("names_the_scope", () => {
    expect(scopeSummary(null, view)).toBe("All projects");
    expect(scopeSummary({ allProfiles: true, profiles: ["work"], projects: [] }, view)).toBe("All projects");
    expect(scopeSummary({ allProfiles: false, profiles: ["work"], projects: [] }, view)).toBe("Work profile");
    expect(scopeSummary({ allProfiles: false, profiles: [null], projects: [] }, view)).toBe("Default profile");
    expect(scopeSummary({ allProfiles: false, profiles: [], projects: ["p3"] }, view)).toBe("Home");
    expect(scopeSummary({ allProfiles: false, profiles: [null, "work"], projects: ["p1"] }, view)).toBe("2 profiles, 1 project");
    expect(scopeSummary({ allProfiles: false, profiles: [], projects: ["p1", "p2"] }, view)).toBe("2 projects");
    expect(scopeSummary({ allProfiles: false, profiles: [], projects: [] }, view)).toBe("No projects attached");
  });
});

describe("scope picker", () => {
  it("toggles", () => {
    let s = editableScope(null);
    expect(s.allProfiles).toBe(true);
    s = setAllProfiles(s, false);
    s = toggleProfile(s, null);
    s = toggleProject(s, "p1");
    expect(s).toEqual({ allProfiles: false, profiles: [null], projects: ["p1"] });
    s = toggleProfile(toggleProject(s, "p1"), null);
    expect(s).toEqual({ allProfiles: false, profiles: [], projects: [] });
  });

  it("knows_how_a_project_is_covered", () => {
    const s = { allProfiles: false, profiles: ["work"], projects: ["p3"] };
    expect(projectCover(s, "p1", "work", view)).toBe("profile");
    expect(projectCover(s, "p3", null, view)).toBe("project");
    expect(projectCover({ ...s, projects: [] }, "p3", null, view)).toBeNull();
    expect(projectCover({ ...s, allProfiles: true }, "p3", null, view)).toBe("profile");
    // a project of a deleted profile belongs to Default
    expect(projectCover({ allProfiles: false, profiles: [null], projects: [] }, "p4", "deleted", view)).toBe("profile");
  });

  it("groups_projects_by_profile_sorted", () => {
    const g = scopeGroups(view);
    expect(g.map((x) => [x.profileId, x.projects.map((p) => p.name)])).toEqual([
      [null, ["Home", "Orphan"]],
      ["work", ["Alpha", "Zeta"]],
    ]);
  });

  it("compares_scopes_ignoring_order", () => {
    expect(sameScope({ allProfiles: false, profiles: ["a", null], projects: [] }, { allProfiles: false, profiles: [null, "a"], projects: [] })).toBe(true);
    expect(sameScope(null, null)).toBe(true);
    expect(sameScope(null, defaultScope(ALL_PROFILES))).toBe(false);
  });
});

describe("feed", () => {
  const loaded = (): RootFeed =>
    applyFeed(EMPTY_FEED, { t: "history", items: [{ kind: "bubble", role: "user", text: "hi" }], running: false });

  it("history_replaces", () => {
    const s = loaded();
    expect(s.loaded).toBe(true);
    expect(s.feed).toHaveLength(1);
  });

  it("own_send_is_shown_once", () => {
    let s = applyFeed(loaded(), { t: "send", text: "  what's open?  " });
    expect(s.running).toBe(true);
    expect(s.feed).toHaveLength(2);
    s = applyFeed(s, ev({ event: "user", chatId: "c", text: "what's open?" }));
    expect(s.feed).toHaveLength(2);
    expect(s.echo).toEqual([]);
  });

  it("a_turn_from_the_computer_appears", () => {
    let s = applyFeed(loaded(), ev({ event: "user", chatId: "c", text: "from desk" }));
    expect(s.feed.at(-1)).toMatchObject({ kind: "bubble", role: "user", text: "from desk" });
    s = applyFeed(s, ev({ event: "item", chatId: "c", item: { kind: "bubble", role: "assistant", text: "ok" } }));
    expect(s.feed.at(-1)).toMatchObject({ kind: "bubble", role: "assistant", text: "ok" });
    s = applyFeed(s, ev({ event: "done", chatId: "c", isError: false, result: "ok", costUsd: 0.01, numTurns: 1 }));
    expect(s.running).toBe(false);
    expect(s.feed).toHaveLength(3);
  });

  it("errors_and_failed_turns_say_so", () => {
    let s = applyFeed(loaded(), { t: "send", text: "x" });
    s = applyFeed(s, ev({ event: "error", chatId: "c", message: "a turn is already running for this chat" }));
    expect(s.running).toBe(false);
    expect(s.echo).toEqual([]);
    expect(s.feed.at(-1)).toMatchObject({ kind: "notice", tone: "bad", text: "a turn is already running for this chat" });
    s = applyFeed(s, ev({ event: "done", chatId: "c", isError: true, result: "boom" }));
    expect(s.feed.at(-1)).toMatchObject({ kind: "notice", text: "The turn failed", detail: "boom" });
  });

  it("stop_swallows_the_expected_failure", () => {
    let s = applyFeed(loaded(), { t: "send", text: "x" });
    s = applyFeed(s, { t: "stop" });
    expect(s.running).toBe(false);
    expect(s.feed.at(-1)).toMatchObject({ kind: "divider", label: "Stopped by you" });
    const n = s.feed.length;
    s = applyFeed(s, ev({ event: "error", chatId: "c", message: "claude terminated" }));
    expect(s.feed).toHaveLength(n);
    expect(s.stopping).toBe(false);
    // stop when idle changes nothing
    expect(applyFeed(s, { t: "stop" })).toBe(s);
  });

  it("list_running_follows_turns", () => {
    const chats = [chat("c", null, 1)];
    const on = applyToList(chats, { type: "rootChatEvent", event: "user", chatId: "c", text: "x" });
    expect(on?.[0].running).toBe(true);
    const off = applyToList(on, { type: "rootChatEvent", event: "done", chatId: "c", isError: false });
    expect(off?.[0].running).toBe(false);
    expect(applyToList(off, { type: "rootChatEvent", event: "error", chatId: "c", message: "" })).toBe(off);
    expect(applyToList(null, { type: "rootChatEvent", event: "user", chatId: "c", text: "" })).toBeNull();
  });

  it("reads_a_chat_defensively", () => {
    expect(chatOf({ id: "c", title: "", createdAt: 5, scope: { allProfiles: false, profiles: ["w", "w"] } })).toEqual({
      id: "c",
      title: "New Chat",
      profileId: null,
      scope: { allProfiles: false, profiles: ["w"], projects: [] },
      createdAt: 5,
      running: false,
      agent: "claude",
      model: null,
      effort: null,
      research: false,
      mcps: [],
    });
    expect(chatOf({ id: "c", agent: "antigravity", model: "g", effort: "", research: true, mcps: ["a", "a", 3] })).toMatchObject({
      agent: "antigravity",
      model: "g",
      effort: null,
      research: true,
      mcps: ["a"],
    });
    expect(chatOf({ title: "x" })).toBeNull();
  });
});

describe("chat options", () => {
  const frame = {
    type: "rootChatOptions",
    requestId: "o",
    agents: [
      { id: "claude", label: "Claude", models: [{ id: "opus", label: "Opus 4.6" }, { id: "" }], efforts: ["low", "high", "high"] },
      { id: "antigravity", label: "Antigravity", models: [{ id: "gemini" }], efforts: [] },
      { id: "claude", label: "dup" },
      { label: "no id" },
    ],
    skills: [{ name: "/review", description: "Review a diff" }, { name: "plan" }, {}],
    mcps: [{ name: "github" }, { name: "github" }, { name: "" }],
  };
  const opts = optionsOf(frame)!;

  it("reads the options frame defensively", () => {
    expect(opts.agents.map((a) => a.id)).toEqual(["claude", "antigravity"]);
    expect(opts.agents[0].models).toEqual([{ id: "opus", label: "Opus 4.6" }]);
    expect(opts.agents[0].efforts).toEqual(["low", "high"]);
    expect(opts.agents[1].models).toEqual([{ id: "gemini", label: "gemini" }]);
    expect(opts.skills).toEqual([
      { name: "review", description: "Review a diff" },
      { name: "plan", description: "" },
    ]);
    expect(opts.mcps).toEqual([{ name: "github" }]);
    expect(opts.live).toBe(true);
    expect(optionsOf({ agents: [] })).toBeNull();
    expect(optionsOf(null)).toBeNull();
  });

  it("defaults to Claude, and to Claude alone on an older desktop", () => {
    expect(defaultSettings(opts)).toEqual({ agent: "claude", model: null, effort: null, research: false, mcps: [] });
    expect(FALLBACK_OPTIONS.agents.map((a) => a.id)).toEqual(["claude"]);
    expect(defaultSettings(optionsOf({ agents: [{ id: "antigravity" }] })!).agent).toBe("antigravity");
  });

  it("toggles an MCP server on and off", () => {
    const s = toggleMcp({ agent: "claude", model: "opus", effort: "high", research: true, mcps: [] }, "github");
    expect(s.mcps).toEqual(["github"]);
    expect(toggleMcp(s, "github").mcps).toEqual([]);
  });

  it("a settings patch names only the changed fields, '' for back to default", () => {
    const before = { agent: "claude", model: "opus", effort: "high", research: false, mcps: ["a", "b"] };
    expect(settingsPatch(before, { ...before, mcps: ["b", "a"] })).toBeNull();
    expect(settingsPatch(before, { ...before, model: null, research: true })).toEqual({ model: "", research: true });
    expect(settingsPatch(before, { ...before, agent: "antigravity", effort: "low", mcps: ["a"] })).toEqual({ effort: "low", mcps: ["a"] });
  });

  it("the header badge names agent, model, effort and research", () => {
    const chat = chatOf({ id: "c", agent: "claude", model: "opus", effort: "high", research: true })!;
    expect(chatBadge(chat, opts)).toBe("Claude \u00b7 Opus 4.6 \u00b7 high effort \u00b7 Deep research");
    expect(chatBadge(chatOf({ id: "c", agent: "antigravity", model: "x" })!, null)).toBe("Antigravity \u00b7 x");
    expect(chatBadge(chatOf({ id: "c" })!, null)).toBe("Claude");
    expect(modelName(opts, "claude", null)).toBe("Default model");
    expect(agentLabel(opts, "codex")).toBe("codex");
  });

  it("an Antigravity chat never promises proposals", () => {
    expect(emptyChatInfo("claude")).toBe(EMPTY_CHAT_INFO);
    expect(emptyChatInfo(undefined)).toBe(EMPTY_CHAT_INFO);
    expect(emptyChatInfo("antigravity")).not.toMatch(/approv|propos/i);
  });
});

describe("new chat: agent only, nothing attached", () => {
  const two = optionsOf({ agents: [{ id: "claude", label: "Claude" }, { id: "antigravity", label: "Antigravity" }] })!;
  const one = optionsOf({ agents: [{ id: "antigravity" }] })!;

  it("a new chat sees nothing", () => {
    expect(NEW_CHAT_SCOPE).toEqual({ allProfiles: false, profiles: [], projects: [] });
    expect(isUnattached(NEW_CHAT_SCOPE)).toBe(true);
    // null (a chat from before scopes) is everything, never "unattached"
    expect(isUnattached(null)).toBe(false);
    expect(isUnattached({ allProfiles: true, profiles: [], projects: [] })).toBe(false);
    expect(emptyChatInfo("claude", NEW_CHAT_SCOPE)).toBe(EMPTY_CHAT_INFO_UNATTACHED);
    expect(emptyChatInfo("claude", { allProfiles: false, profiles: ["work"], projects: [] })).toBe(EMPTY_CHAT_INFO);
  });

  it("the chooser appears only when there is a choice; Claude when options never came", () => {
    expect(needsAgentChoice(two)).toBe(true);
    expect(needsAgentChoice(one)).toBe(false);
    expect(needsAgentChoice(null)).toBe(false);
    expect(needsAgentChoice(FALLBACK_OPTIONS)).toBe(false);
    expect(startAgents(null).map((a) => a.id)).toEqual(["claude"]);
  });

  it("pre-selects the last-picked agent while it is still offered", () => {
    expect(preferredAgent(two, "antigravity")).toBe("antigravity");
    expect(preferredAgent(two, null)).toBe("claude");
    expect(preferredAgent(two, "codex")).toBe("claude");
    expect(preferredAgent(one, "claude")).toBe("antigravity");
    expect(preferredAgent(null, "antigravity")).toBe("claude");
  });

  it("an older desktop gets no options in the create frame", () => {
    expect(startSettings(two, "antigravity")).toEqual({ agent: "antigravity" });
    expect(startSettings(FALLBACK_OPTIONS, "claude")).toBeUndefined();
    expect(startSettings(null, "claude")).toBeUndefined();
  });
});

describe("attached profiles and projects", () => {
  it("summarizes what is attached at a glance", () => {
    expect(attachedSummary(NEW_CHAT_SCOPE, view)).toBe("No projects attached");
    expect(attachedSummary(null, view)).toBe("All projects");
    expect(attachedSummary({ allProfiles: false, profiles: ["work"], projects: [] }, view)).toBe("Work · 2 projects");
    // a project on a deleted profile counts as Default
    expect(attachedSummary({ allProfiles: false, profiles: [null], projects: [] }, view)).toBe("Default · 2 projects");
    expect(attachedSummary({ allProfiles: false, profiles: [], projects: ["p3"] }, view)).toBe("Home");
    expect(attachedSummary({ allProfiles: false, profiles: [], projects: ["p1", "p3"] }, view)).toBe("2 projects");
    expect(attachedSummary({ allProfiles: false, profiles: ["work"], projects: ["p3"] }, view)).toBe("Work · 3 projects");
    expect(attachedSummary({ allProfiles: false, profiles: [null, "work"], projects: [] }, view)).toBe("2 profiles · 4 projects");
  });

  it("lists chips and detaches one at a time", () => {
    const s = { allProfiles: false, profiles: ["work"], projects: ["p3", "gone"] };
    const items = attachedItems(s, view);
    expect(items.map((i) => i.label)).toEqual(["Work profile", "Home", "Removed project"]);
    expect(detach(s, items[0])).toEqual({ allProfiles: false, profiles: [], projects: ["p3", "gone"] });
    expect(detach(s, items[1])).toEqual({ allProfiles: false, profiles: ["work"], projects: ["gone"] });
    expect(attachedItems(NEW_CHAT_SCOPE, view)).toEqual([]);
    const all = attachedItems(null, view);
    expect(all.map((i) => i.kind)).toEqual(["all"]);
    expect(detach(null, all[0])).toEqual(NEW_CHAT_SCOPE);
  });
});

describe("skill suggestions", () => {
  const skills = [
    { name: "review", description: "" },
    { name: "plan", description: "" },
    { name: "pr-review", description: "" },
  ];
  it("only at the very start, while the first word is typed", () => {
    expect(skillSuggestions("/", skills).map((k) => k.name)).toEqual(["review", "plan", "pr-review"]);
    expect(skillSuggestions("/rev", skills).map((k) => k.name)).toEqual(["review", "pr-review"]);
    expect(skillSuggestions("/REV", skills).map((k) => k.name)).toEqual(["review", "pr-review"]);
    expect(skillSuggestions("/review ", skills)).toEqual([]);
    expect(skillSuggestions("hi /rev", skills)).toEqual([]);
    expect(skillSuggestions(" /rev", skills)).toEqual([]);
    expect(skillSuggestions("", skills)).toEqual([]);
  });
  it("inserting leaves the command and a space", () => {
    expect(insertSkill("review")).toBe("/review ");
    expect(insertSkill("/review")).toBe("/review ");
  });
});
