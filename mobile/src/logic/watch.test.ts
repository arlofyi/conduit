import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import { emptyPending, pendingReducer } from "./pending";
import {
  chatPreview,
  desiredNotifications,
  diffNotifications,
  handoverSettled,
  HANDBACK_MAX_MS,
  initialWatch,
  openTargetOf,
  permissionBody,
  PRIVATE_FINISHED,
  PRIVATE_NEEDS,
  shouldStopWatching,
  shouldWatch,
  watchAddresses,
  watchBaseline,
  watchItemOf,
  watchSessionsOf,
  watchStep,
  type WatchEvent,
  type WatchItem,
  type WatchPrefs,
  type WatchState,
} from "./watch";

function sess(over: Partial<WireViewSession> & { id: string }): WireViewSession {
  return {
    name: `name-${over.id}`,
    agent: "claude",
    branch: null,
    model: null,
    stopped: false,
    running: true,
    silo: false,
    status: "idle",
    activity: null,
    updatedAt: null,
    needs: null,
    lastMessage: null,
    ...over,
  };
}

const view = (...sessions: WireViewSession[]): WireProjectsView => ({
  profiles: [{ id: null, name: "Default" }],
  activeProfileId: null,
  projects: [{ id: "p", name: "conduit", profileId: null, color: null, sessions }],
});

const projects = (...sessions: WireViewSession[]): WatchEvent => ({ t: "projects", sessions: watchSessionsOf(view(...sessions)) });

const ALL: WatchPrefs = { notifyQuestion: true, notifyPermission: true, notifyFinished: true };

const ask = (id: string, sessionId: string, question = "Which db?"): WatchItem => ({
  id,
  sessionId,
  kind: "ask",
  private: false,
  question,
  toolName: "",
  summary: "",
});
const perm = (id: string, sessionId: string, toolName = "Bash", summary = "npm test"): WatchItem => ({
  id,
  sessionId,
  kind: "permission",
  private: false,
  question: "",
  toolName,
  summary,
});

const run = (s: WatchState, ...evs: WatchEvent[]) => evs.reduce(watchStep, s);
const keys = (s: WatchState, prefs = ALL) => desiredNotifications(s, prefs).map((n) => n.key);

describe("watch rules", () => {
  it("posts_nothing_until_names_are_known_then_announces_a_new_item", () => {
    let s = run(initialWatch([], {}), { t: "snapshot", items: [perm("1", "a")] });
    expect(keys(s)).toEqual([]);
    s = run(s, projects(sess({ id: "a", status: "needsInput" })));
    const [n] = desiredNotifications(s, ALL);
    expect(n).toMatchObject({
      key: "item:1",
      channel: "needs",
      title: "name-a",
      subtitle: "conduit",
      body: "Wants to run: npm test",
      target: { sessionId: "a", projectId: "p", name: "name-a", branch: null },
    });
  });

  it("an_item_the_app_already_showed_is_not_announced_again", () => {
    const s = run(initialWatch(["1"], {}), projects(sess({ id: "a" })), { t: "snapshot", items: [ask("1", "a"), ask("2", "a")] });
    expect(keys(s)).toEqual(["item:2"]);
  });

  it("resolved_or_missing_from_a_later_snapshot_cancels", () => {
    let s = run(initialWatch([], {}), projects(sess({ id: "a" })), { t: "added", item: ask("1", "a") }, { t: "added", item: ask("2", "a") });
    expect(keys(s)).toEqual(["item:1", "item:2"]);
    s = run(s, { t: "resolved", id: "1" });
    expect(keys(s)).toEqual(["item:2"]);
    s = run(s, { t: "snapshot", items: [] });
    expect(keys(s)).toEqual([]);
  });

  it("a_question_reads_as_the_question", () => {
    const s = run(initialWatch([], {}), projects(sess({ id: "a" })), { t: "added", item: ask("1", "a", " Postgres or SQLite? ") });
    expect(desiredNotifications(s, ALL)[0].body).toBe("Postgres or SQLite?");
    const blank = run(initialWatch([], {}), projects(sess({ id: "a" })), { t: "added", item: ask("1", "a", "") });
    expect(desiredNotifications(blank, ALL)[0].body).toBe("Asks you a question");
  });

  it("private_items_and_silo_sessions_say_nothing_and_open_nothing", () => {
    const priv: WatchItem = { id: "1", sessionId: "a", kind: "permission", private: true, question: "", toolName: "", summary: "" };
    let s = run(initialWatch([], {}), projects(sess({ id: "a", silo: true })), { t: "added", item: priv });
    expect(desiredNotifications(s, ALL)[0]).toMatchObject({ title: "Conduit", subtitle: null, body: PRIVATE_NEEDS, target: null });
    // a silo session's item, even one carrying detail, is redacted too
    s = run(initialWatch([], {}), projects(sess({ id: "a", silo: true })), { t: "added", item: perm("1", "a") });
    expect(desiredNotifications(s, ALL)[0].body).toBe(PRIVATE_NEEDS);
    s = run(initialWatch([], { a: { needs: null, status: "running" } }), projects(sess({ id: "a", silo: true, status: "done" })));
    expect(desiredNotifications(s, ALL)[0]).toMatchObject({ key: "done:a", body: PRIVATE_FINISHED, target: null });
  });

  it("finished_follows_the_banner_rule_and_clears_when_it_runs_again", () => {
    // first sight is not a transition
    let s = run(initialWatch([], {}), projects(sess({ id: "a", status: "done" })));
    expect(keys(s)).toEqual([]);
    s = run(s, projects(sess({ id: "a", status: "running" })), projects(sess({ id: "a", status: "done" })));
    expect(desiredNotifications(s, ALL)[0]).toMatchObject({ key: "done:a", channel: "finished", body: "Finished" });
    // a later identical view keeps it; running again drops it
    s = run(s, projects(sess({ id: "a", status: "idle" })));
    expect(keys(s)).toEqual(["done:a"]);
    s = run(s, projects(sess({ id: "a", status: "running" })));
    expect(keys(s)).toEqual([]);
  });

  it("the_baseline_from_the_app_catches_a_turn_that_ended_during_the_hand_over", () => {
    const s = run(initialWatch([], { a: { needs: null, status: "running" } }), projects(sess({ id: "a", status: "done" })));
    expect(keys(s)).toEqual(["done:a"]);
  });

  it("a_view_only_needs_alert_is_for_agents_that_hold_nothing", () => {
    let s = run(
      initialWatch([], { a: { needs: null, status: "running" } }),
      projects(sess({ id: "a", status: "needsInput", needs: { kind: "input", text: null } })),
    );
    expect(desiredNotifications(s, ALL)[0]).toMatchObject({ key: "needs:a", body: "Needs your input" });
    // a held item for that session replaces the generic alert
    s = run(s, { t: "added", item: perm("9", "a") });
    expect(keys(s)).toEqual(["item:9"]);
    // needs cleared: the alert goes
    s = run(s, { t: "resolved", id: "9" }, projects(sess({ id: "a", status: "running" })));
    expect(keys(s)).toEqual([]);
  });

  it("an_item_first_then_the_view_showing_it_raises_one_notification", () => {
    const s = run(
      initialWatch([], { a: { needs: null, status: "running" } }),
      projects(sess({ id: "a", status: "running" })),
      { t: "added", item: ask("1", "a") },
      projects(sess({ id: "a", status: "needsInput", needs: { kind: "ask", text: "Which db?" } })),
      { t: "resolved", id: "1" },
    );
    // answered on the computer before the view caught up: nothing left
    expect(keys(s)).toEqual([]);
  });

  it("switches_gate_each_kind", () => {
    const s = run(
      initialWatch([], { c: { needs: null, status: "running" } }),
      projects(sess({ id: "a" }), sess({ id: "b" }), sess({ id: "c", status: "done" })),
      { t: "added", item: ask("1", "a") },
      { t: "added", item: perm("2", "b") },
    );
    expect(keys(s)).toEqual(["item:1", "item:2", "done:c"]);
    expect(keys(s, { ...ALL, notifyQuestion: false })).toEqual(["item:2", "done:c"]);
    expect(keys(s, { ...ALL, notifyPermission: false, notifyFinished: false })).toEqual(["item:1"]);
  });

  it("a_session_gone_from_the_view_drops_its_alerts", () => {
    let s = run(initialWatch([], { a: { needs: null, status: "running" } }), projects(sess({ id: "a", status: "done" })));
    expect(keys(s)).toEqual(["done:a"]);
    s = run(s, projects());
    expect(keys(s)).toEqual([]);
  });

  it("diff_posts_new_and_changed_and_cancels_the_rest", () => {
    let s = run(initialWatch([], {}), projects(sess({ id: "a" })), { t: "added", item: ask("1", "a") });
    let d = diffNotifications({}, desiredNotifications(s, ALL));
    expect(d.post.map((n) => n.key)).toEqual(["item:1"]);
    // same content again: nothing to do
    const again = diffNotifications(d.posted, desiredNotifications(s, ALL));
    expect(again.post).toEqual([]);
    expect(again.cancel).toEqual([]);
    // renamed: re-posted in place
    s = run(s, projects(sess({ id: "a", name: "renamed" })));
    d = diffNotifications(d.posted, desiredNotifications(s, ALL));
    expect(d.post.map((n) => n.title)).toEqual(["renamed"]);
    d = diffNotifications(d.posted, desiredNotifications(run(s, { t: "resolved", id: "1" }), ALL));
    expect(d.cancel).toEqual(["item:1"]);
  });
});

describe("permissionBody", () => {
  it("names_what_it_wants", () => {
    expect(permissionBody("Bash", "rm -rf build")).toBe("Wants to run: rm -rf build");
    expect(permissionBody("run_command", "ls")).toBe("Wants to run: ls");
    expect(permissionBody("Edit", "src/a.ts")).toBe("Wants to use Edit: src/a.ts");
    expect(permissionBody("WebFetch", "WebFetch")).toBe("Wants to use WebFetch");
    expect(permissionBody("", "")).toBe("Needs your permission");
  });
});

describe("hand-over", () => {
  const base = {
    available: true,
    prefs: ALL,
    token: "t",
    addresses: ["ws://a:1"],
    notificationsAllowed: true,
    asking: false,
  };
  it("watches_only_with_a_switch_a_token_and_permission", () => {
    expect(shouldWatch(base)).toBe(true);
    expect(shouldWatch({ ...base, available: false })).toBe(false);
    expect(shouldWatch({ ...base, prefs: { notifyQuestion: false, notifyPermission: false, notifyFinished: false } })).toBe(false);
    expect(shouldWatch({ ...base, token: null })).toBe(false);
    expect(shouldWatch({ ...base, addresses: [] })).toBe(false);
    expect(shouldWatch({ ...base, notificationsAllowed: false })).toBe(false);
    expect(shouldWatch({ ...base, asking: true })).toBe(false);
  });

  it("the_working_address_goes_first", () => {
    expect(watchAddresses("ws://ip:1", ["ws://dns:1", "ws://ip:1"])).toEqual(["ws://ip:1", "ws://dns:1"]);
    expect(watchAddresses(null, ["ws://dns:1"])).toEqual(["ws://dns:1"]);
  });

  it("the_baseline_is_what_the_app_saw", () => {
    let pending = pendingReducer(emptyPending, {
      t: "snapshot",
      items: [
        { kind: "ask", id: "1", sessionId: "a", private: false, toolUseId: "", questions: [], createdMs: 0 },
        { kind: "ask", id: "2", sessionId: "a", private: false, toolUseId: "", questions: [], createdMs: 0 },
      ],
      now: 0,
    });
    pending = pendingReducer(pending, { t: "resolved", id: "2", by: "desktop", now: 1 });
    const b = watchBaseline(view(sess({ id: "a", status: "running" })), pending);
    expect(b.seen).toEqual(["1"]);
    expect(b.signals).toEqual({ a: { needs: null, status: "running" } });
  });

  it("the_app_socket_waits_for_the_watcher_to_connect_or_fail_once", () => {
    expect(handoverSettled("connecting")).toBe(false);
    expect(handoverSettled("watching")).toBe(true);
    expect(handoverSettled("retrying")).toBe(true);
    expect(handoverSettled("stopped")).toBe(true);
  });

  it("back_in_front_the_watcher_stops_once_the_app_socket_is_ready", () => {
    const o = { foreground: true, wanted: true, running: true, connPhase: "connecting", sinceForegroundMs: 0 };
    expect(shouldStopWatching(o)).toBe(false);
    expect(shouldStopWatching({ ...o, connPhase: "ready" })).toBe(true);
    expect(shouldStopWatching({ ...o, connPhase: "failed" })).toBe(true);
    expect(shouldStopWatching({ ...o, sinceForegroundMs: HANDBACK_MAX_MS })).toBe(true);
    expect(shouldStopWatching({ ...o, running: false, connPhase: "ready" })).toBe(false);
    // in the background it runs while wanted
    expect(shouldStopWatching({ ...o, foreground: false })).toBe(false);
    expect(shouldStopWatching({ ...o, foreground: false, wanted: false })).toBe(true);
  });

  it("a_tap_target_needs_a_session_and_project", () => {
    expect(openTargetOf({ sessionId: "a", projectId: "p", name: "n", branch: "" })).toEqual({
      sessionId: "a",
      projectId: "p",
      name: "n",
      branch: null,
    });
    expect(openTargetOf({ sessionId: "", projectId: "p" })).toBeNull();
    expect(openTargetOf(null)).toBeNull();
  });

  it("pending_items_reduce_to_what_a_notification_can_say", () => {
    expect(watchItemOf({ kind: "permission", id: "1", sessionId: "a", private: true })).toMatchObject({ private: true, summary: "" });
    expect(
      watchItemOf({
        kind: "ask",
        id: "1",
        sessionId: "a",
        private: false,
        toolUseId: "t",
        questions: [{ question: "Q?", header: "", options: [], multiSelect: false }],
        createdMs: 0,
      }).question,
    ).toBe("Q?");
  });
});

describe("general chats", () => {
  const run = (...evs: WatchEvent[]): WatchState => evs.reduce(watchStep, initialWatch([], {}));

  it("announces a finished reply with the chat's title and a preview, opening that chat", () => {
    const s = run(projects(), { t: "chats", chats: [{ id: "c1", title: "Plan the week" }] }, { t: "chatEvent", event: "done", chatId: "c1", result: "Here is   the plan." });
    expect(desiredNotifications(s, ALL)).toEqual([
      {
        key: "chat:c1",
        channel: "finished",
        title: "Plan the week",
        subtitle: "Chats",
        body: "Here is the plan.",
        target: { sessionId: "chat:c1", projectId: "", name: "Plan the week", branch: null },
      },
    ]);
  });

  it("clears on the next message, respects the Finished switch, and names an unknown chat", () => {
    const done = run(projects(), { t: "chatEvent", event: "done", chatId: "c9" });
    expect(desiredNotifications(done, ALL)[0]).toMatchObject({ title: "Chat", body: "Replied" });
    expect(desiredNotifications(done, { ...ALL, notifyFinished: false })).toEqual([]);
    expect(desiredNotifications(watchStep(done, { t: "chatEvent", event: "user", chatId: "c9" }), ALL)).toEqual([]);
  });

  it("previews: trimmed, capped, and an error says so", () => {
    expect(chatPreview("x".repeat(200))).toHaveLength(140);
    expect(chatPreview(null)).toBe("Replied");
    expect(chatPreview("ok", true)).toBe("The reply failed");
  });
});
