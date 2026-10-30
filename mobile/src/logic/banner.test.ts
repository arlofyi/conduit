import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import { DEFAULT_PREFS } from "../data/prefs";
import { bannerFromPending, bannerFromStatus, bannersFromView, type Signals } from "./banner";

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

const ALL_ON = { notifyQuestion: true, notifyPermission: true, notifyFinished: true };

/** Feed a sequence of views through, returning every banner raised. */
function run(views: WireProjectsView[], openId: string | null, prefs = ALL_ON) {
  let signals: Signals = {};
  const out = [];
  for (const v of views) {
    const r = bannersFromView(signals, v, openId, prefs);
    signals = r.signals;
    out.push(...r.banners);
  }
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
    expect(b[0]).toMatchObject({ openable: false, text: "Private session — open it on your Mac" });
  });

  it("needs outranks finished when one poll carries both", () => {
    const r1 = sess({ id: "r", name: "r", status: "running" });
    const r2 = sess({ id: "r", name: "r", status: "done" });
    const b = run([view(r1, idle), view(r2, asks)], null);
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
    held: true,
  };
  const permItem = { kind: "permission" as const, id: "perm-1", sessionId: "a", private: false as const, toolName: "Bash", summary: "touch a.txt", createdMs: 1, held: true };

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
    // not by the session's needs flag (the first was answered on the Mac before any poll)
    const needing = bannersFromView({}, view(asks), null, ALL_ON).signals;
    const second = bannerFromPending(needing, view(asks), { ...askItem, id: "ask-2" }, null, ALL_ON);
    expect(second.banner).toMatchObject({ sessionId: "a", kind: "question", text: "Asks: Ship it?" });
    const third = bannerFromPending(second.signals, view(asks), { ...permItem, id: "perm-9" }, null, ALL_ON);
    expect(third.banner).toMatchObject({ kind: "permission" });
    // silo: announced, never its text, cannot be opened
    const siloIdle = sess({ id: "s", name: "secret", silo: true });
    const sig = bannersFromView({}, view(siloIdle), null, ALL_ON).signals;
    const b = bannerFromPending(sig, view(siloIdle), { kind: "ask", id: "ask-2", sessionId: "s", private: true }, null, ALL_ON).banner;
    expect(b).toMatchObject({ openable: false, text: "Private session — open it on your Mac" });
  });
});
