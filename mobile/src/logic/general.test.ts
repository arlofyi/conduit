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
    expect(scopeSummary({ allProfiles: false, profiles: [], projects: [] }, view)).toBe("No projects");
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
    });
    expect(chatOf({ title: "x" })).toBeNull();
  });
});
