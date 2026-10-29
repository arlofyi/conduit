import type { WireProjectsView, WireViewProject, WireViewSession } from "../bridge/protocol";
import {
  ALL_PROFILES,
  agentInitials,
  buildRows,
  chatUnread,
  chipsFor,
  nextUnread,
  offlineText,
  previewFor,
  profileName,
  resolveFilter,
  sameRow,
  profileSheet,
  profileSummary,
  resolveProfile,
  relativeTime,
  needsCount,
} from "./chatList";
import { listTime } from "./time";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function sess(over: Partial<WireViewSession> & { id: string }): WireViewSession {
  return {
    name: over.id,
    agent: "claude",
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
    ...over,
  };
}

function proj(id: string, profileId: string | null, sessions: WireViewSession[]): WireViewProject {
  return { id, name: id.toUpperCase(), profileId, color: null, sessions };
}

const VIEW: WireProjectsView = {
  profiles: [
    { id: null, name: "Default" },
    { id: "work", name: "Work" },
  ],
  activeProfileId: null,
  projects: [
    proj("conduit", null, [
      sess({ id: "idle-new", updatedAt: NOW - 1 * MIN }),
      sess({ id: "run-old", status: "running", running: true, updatedAt: NOW - 30 * MIN, activity: "Editing x.ts" }),
      sess({ id: "need", status: "needsInput", updatedAt: NOW - 50 * MIN, needs: { kind: "input", text: null } }),
      sess({ id: "run-new", status: "running", running: true, updatedAt: NOW - 2 * MIN }),
      sess({ id: "idle-null" }),
    ]),
    proj("arlo", null, [
      sess({ id: "ask", status: "running", updatedAt: NOW - 5 * MIN, needs: { kind: "ask", text: "Ship it?" } }),
    ]),
    proj("client", "work", [sess({ id: "c1", updatedAt: NOW })]),
    proj("empty", null, []),
  ],
};

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("buildRows", () => {
  it("needs_first_then_most_recent", () => {
    const rows = buildRows(VIEW, { profileId: null, filter: "conduit", unread: {}, now: NOW });
    // running no longer outranks a more recent idle row: recency decides after needs
    expect(ids(rows)).toEqual(["need", "idle-new", "run-new", "run-old", "idle-null"]);
  });

  it("is one flat list across projects under All", () => {
    const rows = buildRows(VIEW, { profileId: null, filter: "all", unread: {}, now: NOW });
    expect(ids(rows)).toEqual(["ask", "need", "idle-new", "run-new", "run-old", "idle-null"]);
    expect(rows[2]).toMatchObject({ projectName: "CONDUIT", color: "#b989b1" });
  });

  it("filters Needs you and Running", () => {
    expect(ids(buildRows(VIEW, { profileId: null, filter: "needs", unread: {}, now: NOW }))).toEqual(["ask", "need"]);
    // a running session that needs you is a Needs you row, not a Running one
    expect(ids(buildRows(VIEW, { profileId: null, filter: "running", unread: {}, now: NOW }))).toEqual([
      "run-new",
      "run-old",
    ]);
  });

  it("sorts by the later of the status change and the last message", () => {
    const v: WireProjectsView = {
      ...VIEW,
      projects: [
        proj("p", null, [
          sess({ id: "old-status-new-msg", updatedAt: NOW - 60 * MIN, lastMessage: { role: "assistant", text: "hi", at: new Date(NOW - MIN).toISOString() } }),
          sess({ id: "mid", updatedAt: NOW - 10 * MIN }),
        ]),
      ],
    };
    expect(ids(buildRows(v, { profileId: null, filter: "all", unread: {}, now: NOW }))).toEqual(["old-status-new-msg", "mid"]);
  });

  it("profile_filter_and_all_profiles", () => {
    const work = buildRows(VIEW, { profileId: "work", filter: "all", unread: {}, now: NOW });
    expect(ids(work)).toEqual(["c1"]);
    const all = buildRows(VIEW, { profileId: ALL_PROFILES, filter: "all", unread: {}, now: NOW });
    expect(all).toHaveLength(7);
    // a project chip from another profile shows nothing rather than leaking across
    expect(buildRows(VIEW, { profileId: "work", filter: "conduit", unread: {}, now: NOW })).toEqual([]);
  });

  it("builds the row anatomy", () => {
    const [row] = buildRows(VIEW, { profileId: null, filter: "arlo", unread: { ask: 2 }, now: NOW });
    expect(row).toMatchObject({
      id: "ask",
      projectId: "arlo",
      projectName: "ARLO",
      title: "ask",
      agent: "claude",
      initials: "CL",
      dot: "needs",
      glyph: "needsInput",
      needs: true,
      time: listTime(NOW - 5 * MIN, NOW),
      unread: 2,
      openable: true,
      preview: { tone: "needs", prefix: "Asks:", text: "Ship it?" },
    });
  });

  it("rings like the desktop: a live idle session rings, a never-started one does not", () => {
    const rows = buildRows(VIEW, { profileId: null, filter: "conduit", unread: {}, now: NOW });
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by("run-new").glyph).toBe("running");
    expect(by("idle-null").glyph).toBeUndefined();
    const live = buildRows(
      { ...VIEW, projects: [proj("p", null, [sess({ id: "l", running: true }), sess({ id: "d", status: "done" })])] },
      { profileId: null, filter: "all", unread: {}, now: NOW },
    );
    expect(live.map((r) => r.glyph)).toEqual(["idle", "done"]);
  });

  it("silo_row_not_openable_no_preview", () => {
    const v: WireProjectsView = {
      ...VIEW,
      projects: [proj("p", null, [sess({ id: "s", silo: true, status: "running", activity: "Editing secret.ts" })])],
    };
    const row = buildRows(v, { profileId: null, filter: "all", unread: {}, now: NOW })[0];
    expect(row.openable).toBe(false);
    expect(row.preview).toEqual({ tone: "private", prefix: null, text: "Private session" });
    expect(JSON.stringify(row)).not.toContain("secret");
  });
});

describe("chipsFor", () => {
  it("needs_chip_count", () => {
    const chips = chipsFor(VIEW, null);
    expect(chips[0]).toEqual({ key: "all", label: "All", color: null });
    expect(chips[1]).toEqual({ key: "needs", label: "Needs you 2", color: null, needs: true });
    expect(chips[2]).toEqual({ key: "running", label: "Running 2", color: null });
    // one per project with sessions in the profile; "empty" has none
    expect(chips.slice(3).map((c) => c.key)).toEqual(["conduit", "arlo"]);
    expect(chipsFor(VIEW, ALL_PROFILES).slice(3).map((c) => c.key)).toEqual(["conduit", "arlo", "client"]);
  });

  it("hides a count chip with nothing to count", () => {
    expect(chipsFor(VIEW, "work").map((c) => c.key)).toEqual(["all", "client"]);
  });

  it("needsCount feeds the tab badge", () => {
    expect(needsCount(VIEW, null)).toBe(2);
    expect(needsCount(VIEW, "work")).toBe(0);
    expect(needsCount(null, null)).toBe(0);
  });
});

describe("profileSheet", () => {
  it("lists each profile plus All profiles with counts", () => {
    expect(profileSheet(VIEW)).toEqual([
      // projects WITH sessions, as the chips count them ("empty" is not one)
      { id: null, name: "Default", projects: 2, needs: 2 },
      { id: "work", name: "Work", projects: 1, needs: 0 },
      { id: ALL_PROFILES, name: "All profiles", projects: 3, needs: 2 },
    ]);
  });
});

describe("previewFor", () => {
  it("covers each state", () => {
    expect(previewFor(sess({ id: "a", needs: { kind: "ask", text: null } }))).toEqual({
      tone: "needs",
      prefix: null,
      text: "Asks you a question",
    });
    expect(previewFor(sess({ id: "a", status: "needsInput", needs: { kind: "input", text: null } }))).toEqual({
      tone: "needs",
      prefix: null,
      text: "Needs your input",
    });
    expect(previewFor(sess({ id: "a", status: "running", activity: "Editing x.ts" }))).toEqual({
      tone: "running",
      prefix: null,
      text: "Editing x.ts…",
    });
    expect(previewFor(sess({ id: "a", status: "running" })).text).toBe("working…");
    expect(previewFor(sess({ id: "a", status: "done" })).text).toBe("Finished");
    expect(previewFor(sess({ id: "a", stopped: true })).text).toBe("Stopped");
    expect(previewFor(sess({ id: "a", branch: "feat/x" })).text).toBe("feat/x");
    expect(previewFor(sess({ id: "a" })).text).toBe("No messages yet");
  });

  it("previewLine: the last message, 'You:' for the user's own", () => {
    const at = new Date(NOW).toISOString();
    expect(previewFor(sess({ id: "a", lastMessage: { role: "assistant", text: "pong", at } }))).toEqual({
      tone: "plain",
      prefix: null,
      text: "pong",
    });
    expect(previewFor(sess({ id: "a", status: "done", lastMessage: { role: "user", text: "ping", at } }))).toEqual({
      tone: "plain",
      prefix: "You:",
      text: "ping",
    });
    // what needs you, and what it is doing now, outrank the last message
    const lm = { role: "assistant" as const, text: "old", at };
    expect(previewFor(sess({ id: "a", status: "running", lastMessage: lm })).tone).toBe("running");
    expect(previewFor(sess({ id: "a", needs: { kind: "ask", text: "Ok?" }, lastMessage: lm })).text).toBe("Ok?");
    expect(previewFor(sess({ id: "a", silo: true, lastMessage: lm })).text).toBe("Private session");
  });

  it("silo_needs_preview_points_to_the_mac", () => {
    const s = sess({ id: "a", silo: true, status: "needsInput", needs: { kind: "input", text: null } });
    expect(previewFor(s)).toEqual({ tone: "private", prefix: null, text: "Private session — open it on your Mac" });
    // still a needs row (counted in Needs you), dimmed and not openable
    const v: WireProjectsView = { ...VIEW, projects: [proj("p", null, [s])] };
    const row = buildRows(v, { profileId: null, filter: "needs", unread: {}, now: NOW })[0];
    expect(row.needs).toBe(true);
    expect(row.openable).toBe(false);
    expect(chipsFor(v, null)[1].label).toBe("Needs you 1");
    // a silo session that needs nothing keeps the plain copy
    expect(previewFor(sess({ id: "b", silo: true })).text).toBe("Private session");
  });
});

describe("relativeTime", () => {
  it("relative_time_buckets", () => {
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime(NOW - 30_000, NOW)).toBe("now");
    expect(relativeTime(NOW + 5_000, NOW)).toBe("now"); // clock skew
    expect(relativeTime(NOW - 2 * MIN, NOW)).toBe("2 min");
    expect(relativeTime(NOW - 59 * MIN, NOW)).toBe("59 min");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3 h");
    expect(relativeTime(NOW - 30 * HOUR, NOW)).toBe("Yesterday");
    expect(relativeTime(NOW - 4 * 24 * HOUR, NOW)).toBe("4 d");
    expect(relativeTime(NOW - 40 * 24 * HOUR, NOW)).toBe("5 w");
  });
});

describe("agentInitials", () => {
  it("covers all seven desktop agents (src/agents.ts) and falls back to ?", () => {
    expect(agentInitials("claude")).toBe("CL");
    expect(agentInitials("codex")).toBe("CX");
    expect(agentInitials("gemini")).toBe("GE");
    expect(agentInitials("opencode")).toBe("OC");
    expect(agentInitials("antigravity")).toBe("AG");
    expect(agentInitials("commandcode")).toBe("CC");
    expect(agentInitials("hermes")).toBe("HE");
    expect(agentInitials("gpt9")).toBe("?");
  });
});

describe("nextUnread", () => {
  const one = (s: WireViewSession): WireProjectsView => ({ ...VIEW, projects: [proj("p", null, [s])] });

  it("counts a session newly needing you or finishing, but not the open chat", () => {
    const before = one(sess({ id: "s", status: "running" }));
    const needs = one(sess({ id: "s", status: "needsInput", needs: { kind: "input", text: null } }));
    expect(nextUnread({}, before, needs, null)).toEqual({ s: 1 });
    expect(nextUnread({}, before, needs, "s")).toEqual({});
    const done = one(sess({ id: "s", status: "done" }));
    expect(nextUnread({ s: 1 }, before, done, null)).toEqual({ s: 2 });
  });

  it("does not count the first view, an unchanged state, or a silo session", () => {
    const needs = one(sess({ id: "s", status: "needsInput", needs: { kind: "input", text: null } }));
    expect(nextUnread({}, null, needs, null)).toEqual({});
    expect(nextUnread({}, needs, needs, null)).toEqual({});
    const r = one(sess({ id: "s", status: "running", silo: true }));
    const d = one(sess({ id: "s", status: "done", silo: true }));
    expect(nextUnread({}, r, d, null)).toEqual({});
  });

  it("returns the same object when no count changed (no re-render)", () => {
    const v = one(sess({ id: "s", status: "running" }));
    const u = { s: 2 };
    expect(nextUnread(u, v, v, null)).toBe(u);
    const empty = {};
    expect(nextUnread(empty, null, v, null)).toBe(empty);
  });

  it("drops counts for sessions that no longer exist", () => {
    const v = one(sess({ id: "s" }));
    expect(nextUnread({ gone: 3, s: 1 }, v, v, null)).toEqual({ s: 1 });
  });
});

describe("offlineText", () => {
  it("names the Mac and when it was last seen", () => {
    expect(offlineText("Home Mac", NOW - 3 * MIN, NOW)).toBe("Home Mac offline · last seen 3 min ago");
    expect(offlineText("Home Mac", NOW - 10_000, NOW)).toBe("Home Mac offline · last seen just now");
    expect(offlineText("Home Mac", NOW - 30 * HOUR, NOW)).toBe("Home Mac offline · last seen yesterday");
    expect(offlineText("Home Mac", null, NOW)).toBe("Home Mac offline");
  });
});

describe("chatUnread", () => {
  it("counts chat frames for the attached session only while its chat is closed", () => {
    expect(chatUnread({}, "s", null)).toEqual({ s: 1 });
    expect(chatUnread({ s: 1 }, "s", "other")).toEqual({ s: 2 });
    expect(chatUnread({}, "s", "s")).toEqual({});
    expect(chatUnread({}, null, null)).toEqual({});
  });
});

describe("profile labels", () => {
  it("names the selection and falls back to Default for a deleted profile", () => {
    expect(profileName(VIEW, "work")).toBe("Work");
    expect(profileName(VIEW, null)).toBe("Default");
    expect(profileName(VIEW, "gone")).toBe("Default");
    expect(profileName(VIEW, ALL_PROFILES)).toBe("All profiles");
  });
  it("resolves a deleted profile to Default", () => {
    expect(resolveProfile(VIEW, "gone")).toBeNull();
    expect(resolveProfile(VIEW, "work")).toBe("work");
    expect(resolveProfile(VIEW, ALL_PROFILES)).toBe(ALL_PROFILES);
  });
  it("pluralizes the sheet summary", () => {
    expect(profileSummary({ id: null, name: "D", projects: 1, needs: 1 })).toEqual({
      projects: "1 project",
      needs: "1 needs you",
    });
    expect(profileSummary({ id: null, name: "D", projects: 2, needs: 0 })).toEqual({
      projects: "2 projects",
      needs: null,
    });
    expect(profileSummary({ id: null, name: "D", projects: 0, needs: 3 }).needs).toBe("3 need you");
  });
});

describe("render stability", () => {
  it("sameRow compares rows by value, including the preview", () => {
    const rows = () => buildRows(VIEW, { profileId: null, filter: "conduit", unread: {}, now: NOW });
    const a = rows();
    const b = rows();
    expect(a[0]).not.toBe(b[0]);
    expect(sameRow(a[0], b[0])).toBe(true);
    expect(sameRow(a[0], { ...b[0], unread: 1 })).toBe(false);
    expect(sameRow(a[0], { ...b[0], preview: { ...b[0].preview, text: "x" } })).toBe(false);
  });

  it("resolveFilter falls back to all when the filter matches no chip", () => {
    const chips = chipsFor(VIEW, null);
    expect(resolveFilter(chips, "conduit")).toBe("conduit");
    expect(resolveFilter(chips, "needs")).toBe("needs");
    expect(resolveFilter(chips, "client")).toBe("all"); // another profile's project
    expect(resolveFilter(chips, "deleted")).toBe("all");
    expect(resolveFilter([], "needs")).toBe("all");
  });
});
