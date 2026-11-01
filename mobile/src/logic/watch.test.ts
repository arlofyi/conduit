import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import { emptyPending, pendingReducer } from "./pending";
import {
  chatPreview,
  CHAT_FAILED,
  desiredNotifications,
  diffNotifications,
  handoverSettled,
  HANDBACK_MAX_MS,
  initialWatch,
  nextWakeAt,
  openTargetOf,
  permissionBody,
  PRIVATE_FAILED,
  PRIVATE_FINISHED,
  PRIVATE_NEEDS,
  PRIVATE_STOPPED,
  shouldStopWatching,
  shouldWatch,
  UNREACHABLE_BODY,
  UNREACHABLE_MS,
  watchAddresses,
  watchBaseline,
  baselineSignals,
  watchItemOf,
  watchSessionsOf,
  watchStep,
  type WatchEvent,
  type WatchItem,
  type WatchPrefs,
  type WatchState,
} from "./watch";
import { FINISH_SETTLE_MS } from "./banner";

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

const projects = (...sessions: WireViewSession[]): WatchEvent => ({ t: "projects", sessions: watchSessionsOf(view(...sessions)), now: 0 });
const projectsAt = (now: number, ...sessions: WireViewSession[]): WatchEvent => ({ t: "projects", sessions: watchSessionsOf(view(...sessions)), now });
/** time enough for a finish seen at 0 to settle */
const settleTick: WatchEvent = { t: "tick", now: FINISH_SETTLE_MS };
const RUNNING = { needs: null, status: "running" as const, running: true, stopped: false, live: true };

const ALL: WatchPrefs = {
  notifyQuestion: true,
  notifyPermission: true,
  notifyFinished: true,
  notifyFailed: true,
  notifyStopped: true,
  notifyUnreachable: true,
};
const NONE: WatchPrefs = {
  notifyQuestion: false,
  notifyPermission: false,
  notifyFinished: false,
  notifyFailed: false,
  notifyStopped: false,
  notifyUnreachable: false,
};

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
    s = run(initialWatch([], { a: RUNNING }), projects(sess({ id: "a", silo: true, status: "done" })), settleTick);
    expect(desiredNotifications(s, ALL)[0]).toMatchObject({ key: "done:a", body: PRIVATE_FINISHED, target: null });
  });

  it("finished_follows_the_banner_rule_and_clears_when_it_runs_again", () => {
    // first sight is not a transition
    let s = run(initialWatch([], {}), projects(sess({ id: "a", status: "done" })));
    expect(keys(s)).toEqual([]);
    s = run(s, projects(sess({ id: "a", status: "running" })), projects(sess({ id: "a", status: "done" })), settleTick);
    expect(desiredNotifications(s, ALL)[0]).toMatchObject({ key: "done:a", channel: "finished", body: "Finished" });
    // a later identical view keeps it; running again drops it
    s = run(s, projects(sess({ id: "a", status: "idle" })));
    expect(keys(s)).toEqual(["done:a"]);
    s = run(s, projects(sess({ id: "a", status: "running" })));
    expect(keys(s)).toEqual([]);
  });

  it("the_baseline_from_the_app_catches_a_turn_that_ended_during_the_hand_over", () => {
    const s = run(initialWatch([], { a: RUNNING }), projects(sess({ id: "a", status: "done" })), settleTick);
    expect(keys(s)).toEqual(["done:a"]);
  });

  it("a_view_only_needs_alert_is_for_agents_that_hold_nothing", () => {
    let s = run(
      initialWatch([], { a: RUNNING }),
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
      initialWatch([], { a: RUNNING }),
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
      initialWatch([], { c: RUNNING }),
      projects(sess({ id: "a" }), sess({ id: "b" }), sess({ id: "c", status: "done" })),
      { t: "added", item: ask("1", "a") },
      { t: "added", item: perm("2", "b") },
      settleTick,
    );
    expect(keys(s)).toEqual(["item:1", "item:2", "done:c"]);
    expect(keys(s, { ...ALL, notifyQuestion: false })).toEqual(["item:2", "done:c"]);
    expect(keys(s, { ...ALL, notifyPermission: false, notifyFinished: false })).toEqual(["item:1"]);
  });

  it("a_session_gone_from_the_view_drops_its_alerts", () => {
    let s = run(initialWatch([], { a: RUNNING }), projects(sess({ id: "a", status: "done" })), settleTick);
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
    expect(shouldWatch({ ...base, prefs: NONE })).toBe(false);
    // any one switch is enough, the new kinds included
    expect(shouldWatch({ ...base, prefs: { ...NONE, notifyFailed: true } })).toBe(true);
    expect(shouldWatch({ ...base, prefs: { ...NONE, notifyUnreachable: true } })).toBe(true);
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
    expect(b.signals).toEqual({ a: { needs: null, status: "running", running: true, stopped: false, failed: null, live: true } });
  });

  it("a_finish_the_app_was_settling_goes_across_with_its_age", () => {
    // the app saw the turn end 5 s before it handed over (app clock: 1_000_000)
    const app = { a: { needs: null, status: "done" as const, running: true, stopped: false, failed: null, live: true, finishAt: 995_000 } };
    const b = watchBaseline(view(sess({ id: "a", status: "done" }), sess({ id: "r", status: "running" })), emptyPending, {
      ...app,
      r: { ...RUNNING, finishAt: 990_000 },
    }, 1_000_000);
    expect(b.signals.a.finishAgoMs).toBe(5_000);
    // only a quiet session carries one
    expect(b.signals.r.finishAgoMs).toBeUndefined();
    // the watcher's clock starts elsewhere: the age, not the instant, is what lands
    const signals = baselineSignals(JSON.parse(JSON.stringify(b.signals)), 100_000);
    expect(signals.a.finishAt).toBe(95_000);
    expect(signals.r.finishAt).toBeUndefined();
    let s = run(initialWatch([], signals), projectsAt(100_000, sess({ id: "a", status: "done" })));
    s = run(s, { t: "tick", now: 95_000 + FINISH_SETTLE_MS - 1 });
    expect(keys(s)).toEqual([]);
    expect(nextWakeAt(s)).toBe(95_000 + FINISH_SETTLE_MS);
    s = run(s, { t: "tick", now: 95_000 + FINISH_SETTLE_MS });
    expect(keys(s)).toEqual(["done:a"]);
  });

  it("a_baseline_age_on_a_session_no_longer_quiet_is_dropped", () => {
    const signals = baselineSignals({ a: { needs: "question", status: "needsInput", finishAgoMs: 3_000 } }, 50_000);
    expect(signals.a.finishAt).toBeUndefined();
    expect(watchBaseline(view(sess({ id: "a", status: "done" })), emptyPending).signals.a.finishAgoMs).toBeUndefined();
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

  it("announces a failed turn (`error`, no `done`) as failed, and clears it on the next message", () => {
    const failed = run(projects(), { t: "chats", chats: [{ id: "c2", title: "Agy" }] }, { t: "chatEvent", event: "error", chatId: "c2", result: "boom" });
    expect(desiredNotifications(failed, ALL)).toEqual([expect.objectContaining({ key: "chat:c2", title: "Agy", body: "The reply failed" })]);
    expect(desiredNotifications(watchStep(failed, { t: "chatEvent", event: "user", chatId: "c2" }), ALL)).toEqual([]);
  });

  it("previews: trimmed, capped, and an error says so", () => {
    expect(chatPreview("x".repeat(200))).toHaveLength(140);
    expect(chatPreview(null)).toBe("Replied");
    expect(chatPreview("ok", true)).toBe("The reply failed");
  });
});

describe("finished settles (one notification per finished piece of work, not per bubble)", () => {
  const run2 = (...evs: WatchEvent[]) => evs.reduce(watchStep, initialWatch([], { a: RUNNING }));

  it("a_finish_waits_FINISH_SETTLE_MS_then_posts_once", () => {
    let s = run2(projectsAt(1000, sess({ id: "a", status: "done" })));
    expect(keys(s)).toEqual([]);
    expect(nextWakeAt(s)).toBe(1000 + FINISH_SETTLE_MS);
    s = watchStep(s, { t: "tick", now: 1000 + FINISH_SETTLE_MS - 1 });
    expect(keys(s)).toEqual([]);
    s = watchStep(s, { t: "tick", now: 1000 + FINISH_SETTLE_MS });
    expect(keys(s)).toEqual(["done:a"]);
    expect(nextWakeAt(s)).toBeNull();
    // later frames and ticks keep the one notification (same signature: never re-posted)
    const d = diffNotifications({}, desiredNotifications(s, ALL));
    s = run(s, projectsAt(60_000, sess({ id: "a", status: "done" })), { t: "tick", now: 90_000 });
    expect(diffNotifications(d.posted, desiredNotifications(s, ALL)).post).toEqual([]);
  });

  it("running_again_inside_the_window_cancels_it_so_a_flapping_turn_posts_nothing", () => {
    // agy: idle at every step / permission menu, running again a second later
    let s = run2(
      projectsAt(0, sess({ id: "a", status: "idle" })),
      projectsAt(1_000, sess({ id: "a", status: "running" })),
      projectsAt(5_000, sess({ id: "a", status: "idle" })),
      projectsAt(6_000, sess({ id: "a", status: "running" })),
      projectsAt(10_000, sess({ id: "a", status: "done" })),
      projectsAt(12_000, sess({ id: "a", status: "running" })),
      { t: "tick", now: 40_000 },
    );
    expect(keys(s)).toEqual([]);
    // the real end: quiet for the whole window
    s = run(s, projectsAt(50_000, sess({ id: "a", status: "done" })), { t: "tick", now: 50_000 + FINISH_SETTLE_MS });
    expect(keys(s)).toEqual(["done:a"]);
  });

  it("the_window_counts_from_the_first_quiet_frame_not_the_last", () => {
    const s = run2(
      projectsAt(0, sess({ id: "a", status: "done" })),
      projectsAt(10_000, sess({ id: "a", status: "idle" })),
      projectsAt(FINISH_SETTLE_MS, sess({ id: "a", status: "idle" })),
    );
    expect(keys(s)).toEqual(["done:a"]);
  });

  it("a_held_question_or_permission_is_not_a_finish", () => {
    // agy at its permission menu reads `idle`; its card arrives as a held item
    let s = run2(projectsAt(0, sess({ id: "a", status: "idle" })), { t: "added", item: perm("p1", "a") }, settleTick);
    expect(keys(s)).toEqual(["item:p1"]);
    // the view arriving after the item does not restart the settle either
    s = run(s, projectsAt(1_000, sess({ id: "a", status: "idle" })), { t: "tick", now: 1_000 + FINISH_SETTLE_MS });
    expect(keys(s)).toEqual(["item:p1"]);
  });

  it("a_finish_does_not_settle_while_the_link_is_down", () => {
    let s = run2(projectsAt(0, sess({ id: "a", status: "done" })), { t: "link", phase: "retrying", now: 1_000 }, settleTick);
    expect(keys(s)).toEqual([]);
    // back up: the next frame still quiet settles it at once
    s = run(s, { t: "link", phase: "watching", now: 30_000 }, projectsAt(30_000, sess({ id: "a", status: "done" })));
    expect(keys(s)).toEqual(["done:a"]);
  });

  it("general_chat_bubbles_never_notify_only_the_turn_end", () => {
    let s = run2(projects(sess({ id: "a" })), { t: "chats", chats: [{ id: "c1", title: "T" }] });
    for (let i = 0; i < 5; i++) s = watchStep(s, { t: "chatEvent", event: "item", chatId: "c1" });
    expect(keys(s)).toEqual([]);
    s = watchStep(s, { t: "chatEvent", event: "done", chatId: "c1", result: "ok" });
    expect(keys(s)).toEqual(["chat:c1"]);
  });
});

describe("failed, stopped and unreachable", () => {
  it("a_turn_that_ends_on_an_error_is_failed_not_finished", () => {
    let s = run(initialWatch([], { a: RUNNING }), projects(sess({ id: "a", status: "done", failed: "rate_limit" })), settleTick);
    expect(desiredNotifications(s, ALL)).toEqual([
      expect.objectContaining({ key: "failed:a", channel: "needs", body: "Stopped on an error: rate limit", title: "name-a" }),
    ]);
    expect(keys(s, { ...ALL, notifyFailed: false })).toEqual([]);
    // a new turn clears it
    s = run(s, projects(sess({ id: "a", status: "running" })));
    expect(keys(s)).toEqual([]);
  });

  it("a_failure_already_in_place_is_not_news_and_a_private_one_says_nothing", () => {
    expect(keys(run(initialWatch([], {}), projects(sess({ id: "a", status: "done", failed: "x" }))))).toEqual([]);
    const s = run(initialWatch([], { a: RUNNING }), projects(sess({ id: "a", silo: true, status: "done", failed: "error" })));
    expect(desiredNotifications(s, ALL)[0]).toMatchObject({ key: "failed:a", body: PRIVATE_FAILED, target: null, subtitle: null });
  });

  it("a_live_session_that_is_stopped_posts_stopped_and_clears_when_started", () => {
    let s = run(
      initialWatch([], { a: RUNNING }),
      // stop_session saves the idle status a moment before the stopped flag: two frames
      projects(sess({ id: "a", status: "idle", running: false, stopped: false })),
      projects(sess({ id: "a", status: "idle", running: false, stopped: true })),
      settleTick,
    );
    expect(desiredNotifications(s, ALL)).toEqual([expect.objectContaining({ key: "stopped:a", channel: "status", body: "Stopped" })]);
    expect(keys(s, { ...ALL, notifyStopped: false })).toEqual([]);
    s = run(s, projects(sess({ id: "a", status: "idle", running: true, stopped: false })));
    expect(keys(s)).toEqual([]);
  });

  it("a_session_never_live_is_not_announced_as_stopped_and_private_wording_holds", () => {
    const parked = run(
      initialWatch([], {}),
      projects(sess({ id: "a", running: false, stopped: false })),
      projects(sess({ id: "a", running: false, stopped: true })),
    );
    expect(keys(parked)).toEqual([]);
    const priv = run(initialWatch([], { a: RUNNING }), projects(sess({ id: "a", silo: true, running: false, stopped: true })));
    expect(desiredNotifications(priv, ALL)[0]).toMatchObject({ key: "stopped:a", body: PRIVATE_STOPPED, target: null });
  });

  it("unreachable_after_UNREACHABLE_MS_down_with_a_tunnel_once_and_cleared_on_reconnect", () => {
    let s = run(initialWatch([], {}), projects(), { t: "link", phase: "retrying", now: 0 });
    expect(nextWakeAt(s)).toBe(UNREACHABLE_MS);
    s = watchStep(s, { t: "tick", now: UNREACHABLE_MS - 1 });
    expect(keys(s)).toEqual([]);
    // further drops do not restart the clock
    s = run(s, { t: "link", phase: "connecting", now: UNREACHABLE_MS - 1 }, { t: "tick", now: UNREACHABLE_MS });
    expect(desiredNotifications(s, ALL)).toEqual([
      { key: "unreachable", channel: "status", title: "Conduit", subtitle: null, body: UNREACHABLE_BODY, target: null },
    ]);
    expect(nextWakeAt(s)).toBeNull();
    expect(keys(s, { ...ALL, notifyUnreachable: false })).toEqual([]);
    // Tailscale switched off on the phone: unreachable by design, nothing to say
    expect(keys(watchStep(s, { t: "network", tunnel: false }))).toEqual([]);
    s = watchStep(s, { t: "link", phase: "watching", now: UNREACHABLE_MS + 5 });
    expect(keys(s)).toEqual([]);
  });

  it("a_failed_general_chat_reply_follows_the_failed_switch", () => {
    const s = run(initialWatch([], {}), projects(), { t: "chatEvent", event: "error", chatId: "c" });
    expect(desiredNotifications(s, { ...ALL, notifyFinished: false })[0]).toMatchObject({ key: "chat:c", body: CHAT_FAILED });
    expect(keys(s, { ...ALL, notifyFailed: false })).toEqual([]);
  });
});
