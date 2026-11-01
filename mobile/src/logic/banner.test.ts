import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import { DEFAULT_PREFS } from "../data/prefs";
import { bannerFromPending, bannerFromStatus, bannersFromView, dueBanners, failedText, FINISH_SETTLE_MS, type Signals } from "./banner";

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

const view = (...sessions: WireViewSession[]): WireProjectsView => ({
  profiles: [{ id: null, name: "Default" }],
  activeProfileId: null,
  projects: [{ id: "p", name: "conduit", profileId: null, color: null, sessions }],
});

const ALL_ON = { notifyQuestion: true, notifyPermission: true, notifyFinished: true, notifyFailed: true, notifyStopped: true };

/** Feed a sequence of views through (one per second), then let any finish settle; every banner raised. */
function run(views: WireProjectsView[], openId: string | null, prefs = ALL_ON) {
  let signals: Signals = {};
  const out = [];
  let now = 0;
  for (const v of views) {
    now += 1000;
    const r = bannersFromView(signals, v, openId, prefs, now);
    signals = r.signals;
    out.push(...r.banners);
  }
  out.push(...dueBanners(signals, views[views.length - 1] ?? null, openId, prefs, now + FINISH_SETTLE_MS).banners);
  return out;
}

const asks = sess({ id: "a", name: "publish", status: "needsInput", needs: { kind: "ask", text: "Ship it?" } });
const idle = sess({ id: "a", name: "publish" });

describe("banners", () => {
  it("banner_only_on_transition_and_not_for_open_chat", () => {
    // first view: everything already waiting is not "new"
    expect(run([view(asks)], null)).toEqual([]);
    // idle -> asks: one banner
    const b = run([view(idle), view(asks)], null);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      sessionId: "a",
      projectId: "p",
      name: "publish",
      title: "conduit · publish",
      text: "Asks: Ship it?",
      kind: "question",
      openable: true,
    });
    // still asking on the next poll: no repeat
    expect(run([view(idle), view(asks), view(asks)], null)).toHaveLength(1);
    // the chat on screen never banners
    expect(run([view(idle), view(asks)], "a")).toEqual([]);
    // leaves needs and comes back: banners again
    expect(run([view(idle), view(asks), view(idle), view(asks)], null)).toHaveLength(2);
  });

  it("a status frame and the next poll raise one banner, not two", () => {
    let signals: Signals = bannersFromView({}, view(idle), null, ALL_ON).signals;
    const s = bannerFromStatus(signals, view(idle), "a", "needsInput", null, ALL_ON);
    expect(s.banner).toMatchObject({ sessionId: "a", kind: "permission", text: "Needs your input" });
    signals = s.signals;
    const later = bannersFromView(signals, view(sess({ id: "a", name: "publish", status: "needsInput", needs: { kind: "input", text: null } })), null, ALL_ON);
    expect(later.banners).toEqual([]);
    // the open chat: signal updated, no banner
    expect(bannerFromStatus(bannersFromView({}, view(idle), null, ALL_ON).signals, view(idle), "a", "needsInput", "a", ALL_ON).banner).toBeNull();
    // a status the phone has no view entry for is ignored
    expect(bannerFromStatus({}, view(idle), "zz", "needsInput", null, ALL_ON).banner).toBeNull();
  });

  it("banner_respects_toggles", () => {
    const running = sess({ id: "a", name: "publish", status: "running" });
    const done = sess({ id: "a", name: "publish", status: "done" });
    const perm = sess({ id: "a", name: "publish", status: "needsInput", needs: { kind: "input", text: null } });
    // defaults: question on, permission on, finished off
    expect(run([view(idle), view(asks)], null, DEFAULT_PREFS)).toHaveLength(1);
    expect(run([view(idle), view(perm)], null, DEFAULT_PREFS)).toHaveLength(1);
    expect(run([view(running), view(done)], null, DEFAULT_PREFS)).toEqual([]);
    // finished on
    const fin = run([view(running), view(done)], null, ALL_ON);
    expect(fin).toHaveLength(1);
    expect(fin[0]).toMatchObject({ kind: "finished", text: "Finished" });
    // each toggle off silences only its own kind
    expect(run([view(idle), view(asks)], null, { ...ALL_ON, notifyQuestion: false })).toEqual([]);
    expect(run([view(idle), view(perm)], null, { ...ALL_ON, notifyQuestion: false })).toHaveLength(1);
    expect(run([view(idle), view(perm)], null, { ...ALL_ON, notifyPermission: false })).toEqual([]);
    expect(run([view(idle), view(asks)], null, { ...ALL_ON, notifyPermission: false })).toHaveLength(1);
  });

  it("a private session banners without its text and cannot be opened", () => {
    const siloIdle = sess({ id: "s", name: "secret", silo: true });
    const siloNeeds = sess({ id: "s", name: "secret", silo: true, status: "needsInput", needs: { kind: "input", text: null } });
    const b = run([view(siloIdle), view(siloNeeds)], null);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ openable: false, text: "Private session — open it on your computer" });
  });

  it("needs outranks finished when one poll carries both", () => {
    const r1 = sess({ id: "r", name: "r", status: "running" });
    const r2 = sess({ id: "r", name: "r", status: "done" });
    const b = run([view(r1, idle), view(r2, asks)], null);
    // the question at once; the finish once it has settled
    expect(b.map((x) => x.kind)).toEqual(["question", "finished"]);
  });
});

describe("banner from a pushed question or permission", () => {
  const askItem = {
    kind: "ask" as const,
    id: "ask-1",
    sessionId: "a",
    private: false as const,
    toolUseId: "tu1",
    questions: [{ question: "Ship it?", header: "", multiSelect: false, options: [] }],
    createdMs: 1,
  };
  const permItem = { kind: "permission" as const, id: "perm-1", sessionId: "a", private: false as const, toolName: "Bash", summary: "touch a.txt", createdMs: 1 };

  it("banner_fires_on_pending_added_and_the_next_poll_does_not_repeat_it", () => {
    const signals = bannersFromView({}, view(idle), null, ALL_ON).signals;
    const r = bannerFromPending(signals, view(idle), askItem, null, ALL_ON);
    expect(r.banner).toMatchObject({ sessionId: "a", kind: "question", text: "Asks: Ship it?", openable: true });
    // the poll that later shows it asking raises nothing more
    expect(bannersFromView(r.signals, view(asks), null, ALL_ON).banners).toEqual([]);
    // a permission says what it wants to run
    expect(bannerFromPending(signals, view(idle), permItem, null, ALL_ON).banner).toMatchObject({
      kind: "permission",
      text: "Allow Bash: touch a.txt",
    });
  });

  it("pending_banner_respects_toggles_open_chat_and_silo", () => {
    const signals = bannersFromView({}, view(idle), null, ALL_ON).signals;
    expect(bannerFromPending(signals, view(idle), askItem, null, { ...ALL_ON, notifyQuestion: false }).banner).toBeNull();
    expect(bannerFromPending(signals, view(idle), permItem, null, { ...ALL_ON, notifyPermission: false }).banner).toBeNull();
    expect(bannerFromPending(signals, view(idle), askItem, "a", ALL_ON).banner).toBeNull();
    // a NEW question in a session already needing you still banners: it is keyed by the item,
    // not by the session's needs flag (the first was answered on your computer before any poll)
    const needing = bannersFromView({}, view(asks), null, ALL_ON).signals;
    const second = bannerFromPending(needing, view(asks), { ...askItem, id: "ask-2" }, null, ALL_ON);
    expect(second.banner).toMatchObject({ sessionId: "a", kind: "question", text: "Asks: Ship it?" });
    const third = bannerFromPending(second.signals, view(asks), { ...permItem, id: "perm-9" }, null, ALL_ON);
    expect(third.banner).toMatchObject({ kind: "permission" });
    // silo: announced, never its text, cannot be opened
    const siloIdle = sess({ id: "s", name: "secret", silo: true });
    const sig = bannersFromView({}, view(siloIdle), null, ALL_ON).signals;
    const b = bannerFromPending(sig, view(siloIdle), { kind: "ask", id: "ask-2", sessionId: "s", private: true }, null, ALL_ON).banner;
    expect(b).toMatchObject({ openable: false, text: "Private session — open it on your computer" });
  });
});

describe("finished banners settle", () => {
  const running = sess({ id: "a", name: "publish", status: "running" });
  const done = sess({ id: "a", name: "publish", status: "done" });

  it("a_finish_is_raised_only_after_FINISH_SETTLE_MS_quiet_and_only_once", () => {
    let signals = bannersFromView({}, view(running), null, ALL_ON, 0).signals;
    const r = bannersFromView(signals, view(done), null, ALL_ON, 1000);
    expect(r.banners).toEqual([]);
    signals = r.signals;
    const early = dueBanners(signals, view(done), null, ALL_ON, 1000 + FINISH_SETTLE_MS - 1);
    expect(early.banners).toEqual([]);
    expect(early.signals).toBe(signals); // nothing settled: same object
    const due = dueBanners(signals, view(done), null, ALL_ON, 1000 + FINISH_SETTLE_MS);
    expect(due.banners).toEqual([expect.objectContaining({ kind: "finished", text: "Finished" })]);
    expect(dueBanners(due.signals, view(done), null, ALL_ON, 1_000_000).banners).toEqual([]);
  });

  it("running_again_or_a_question_cancels_a_settling_finish", () => {
    expect(run([view(running), view(done), view(running)], null)).toEqual([]);
    expect(run([view(running), view(done), view(running), view(done), view(running)], null)).toEqual([]);
    // a status frame (the streamed session) running again cancels too
    let signals = bannersFromView({}, view(running), null, ALL_ON, 0).signals;
    signals = bannersFromView(signals, view(done), null, ALL_ON, 1000).signals;
    signals = bannerFromStatus(signals, view(done), "a", "running", null, ALL_ON, 2000).signals;
    expect(dueBanners(signals, view(done), null, ALL_ON, 1_000_000).banners).toEqual([]);
    // so does a pushed permission
    let s2 = bannersFromView({}, view(running), null, ALL_ON, 0).signals;
    s2 = bannersFromView(s2, view(done), null, ALL_ON, 1000).signals;
    s2 = bannerFromPending(s2, view(done), { kind: "permission", id: "p", sessionId: "a", private: false, toolName: "Bash", summary: "x", createdMs: 1 }, null, ALL_ON).signals;
    expect(dueBanners(s2, view(done), null, ALL_ON, 1_000_000).banners).toEqual([]);
  });

  it("a_status_frame_done_settles_rather_than_raising", () => {
    const signals = bannersFromView({}, view(running), null, ALL_ON, 0).signals;
    const r = bannerFromStatus(signals, view(running), "a", "done", null, ALL_ON, 1000);
    expect(r.banner).toBeNull();
    expect(dueBanners(r.signals, view(done), null, ALL_ON, 1000 + FINISH_SETTLE_MS).banners).toHaveLength(1);
  });

  it("failed_and_stopped_banner_at_once_behind_their_switches", () => {
    const failed = sess({ id: "a", name: "publish", status: "done", failed: "overloaded" });
    expect(run([view(running), view(failed)], null)).toEqual([
      expect.objectContaining({ kind: "failed", text: "Stopped on an error: the API is overloaded" }),
    ]);
    expect(run([view(running), view(failed)], null, { ...ALL_ON, notifyFailed: false })).toEqual([]);
    const live = sess({ id: "a", name: "publish", running: true });
    const stopped = sess({ id: "a", name: "publish", running: false, stopped: true });
    expect(run([view(live), view(stopped)], null)).toEqual([expect.objectContaining({ kind: "stopped", text: "Stopped" })]);
    expect(run([view(live), view(stopped)], null, { ...ALL_ON, notifyStopped: false })).toEqual([]);
    // never seen live: not a stop worth saying
    expect(run([view(sess({ id: "a", running: false })), view(stopped)], null)).toEqual([]);
    const silo = run([view({ ...live, silo: true }), view({ ...stopped, silo: true })], null);
    expect(silo[0]).toMatchObject({ text: "Private session stopped", openable: false });
  });

  it("failedText_names_the_error", () => {
    expect(failedText("rate_limit")).toBe("Stopped on an error: rate limit");
    expect(failedText("some_new_kind")).toBe("Stopped on an error: some new kind");
    expect(failedText("unknown")).toBe("Stopped on an error");
    expect(failedText(null)).toBe("Stopped on an error");
  });
});
