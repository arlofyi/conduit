import type { WirePendingItem, WireQuestion } from "../bridge/protocol";
import {
  answerSummary,
  buildAnswers,
  cardView,
  emptyPending,
  entryForToolUse,
  fromWire,
  openBySession,
  pendingReducer,
  PRIVATE_ANSWER_TEXT,
  REJECTED_ANSWER_TEXT,
  SETTLED_SHOW_MS,
  trailingEntries,
  WATCHING_TEXT,
  type PendingEvent,
  type PendingState,
} from "./pending";

const Q: WireQuestion = {
  question: "Ship it?",
  header: "Ship",
  multiSelect: false,
  options: [
    { label: "Yes (Recommended)", description: "go" },
    { label: "No", description: "" },
  ],
};
const MQ: WireQuestion = {
  question: "Which checks?",
  header: "Checks",
  multiSelect: true,
  options: [
    { label: "lint", description: "" },
    { label: "tests", description: "" },
    { label: "build", description: "" },
  ],
};

const ask = (id: string, toolUseId: string, sessionId = "s1"): WirePendingItem => ({
  kind: "ask",
  id,
  sessionId,
  toolUseId,
  questions: [Q],
  createdMs: 1000,
});
const perm = (id: string, sessionId = "s1"): WirePendingItem => ({
  kind: "permission",
  id,
  sessionId,
  toolName: "Bash",
  summary: "touch a.txt",
  createdMs: 2000,
});

function run(events: PendingEvent[], start: PendingState = emptyPending): PendingState {
  return events.reduce(pendingReducer, start);
}

describe("pending", () => {
  it("pending_reducer_add_resolve", () => {
    let s = run([{ t: "snapshot", items: [ask("ask-1", "tu1")].map(fromWire), now: 0 }]);
    expect(Object.keys(s.entries)).toEqual(["ask-1"]);
    s = run([{ t: "added", item: fromWire(perm("perm-1")) }], s);
    expect(s.order).toEqual(["ask-1", "perm-1"]);
    // adding the same id twice is a no-op
    expect(run([{ t: "added", item: fromWire(perm("perm-1")) }], s)).toBe(s);
    // resolved elsewhere: kept, settled, and says where
    s = run([{ t: "resolved", id: "ask-1", by: "desktop", now: 5 }], s);
    expect(cardView(s.entries["ask-1"])).toMatchObject({ mode: "done", text: "Answered on your Mac" });
    expect(openBySession(s)).toEqual({ s1: expect.objectContaining({ id: "perm-1" }) });
    // cancelled: dropped silently
    s = run([{ t: "resolved", id: "perm-1", by: "cancelled", now: 6 }], s);
    expect(s.entries["perm-1"]).toBeUndefined();
    expect(s.order).toEqual(["ask-1"]);
    // a resolved for an id never seen is ignored
    expect(run([{ t: "resolved", id: "zz", by: "phone", now: 7 }], s)).toBe(s);
    // a fresh snapshot (reconnect) drops what is no longer pending and was never settled here
    s = run([{ t: "added", item: fromWire(ask("ask-2", "tu2")) }, { t: "snapshot", items: [], now: 8 }], s);
    expect(s.entries["ask-2"]).toBeUndefined();
    expect(s.entries["ask-1"]).toBeDefined();
  });

  it("absent_kind_reads_as_ask", () => {
    const { kind: _k, ...bare } = ask("ask-9", "tu9") as Extract<WirePendingItem, { toolUseId: string }>;
    expect(fromWire(bare as WirePendingItem)).toMatchObject({ kind: "ask", id: "ask-9", private: false });
  });

  it("question_card_live_by_tool_use_id", () => {
    const s = run([{ t: "snapshot", items: [ask("ask-1", "tu1"), ask("ask-2", "tu2", "s2")].map(fromWire), now: 0 }]);
    const e = entryForToolUse(s, "s1", "tu1");
    expect(e?.item.id).toBe("ask-1");
    expect(cardView(e!)).toMatchObject({ mode: "live" });
    // another session's question never joins this chat's card
    expect(entryForToolUse(s, "s1", "tu2")).toBeNull();
    // a transcript question nobody is waiting on stays history
    expect(entryForToolUse(s, "s1", "tu-old")).toBeNull();
    // sending, then the answer lands
    let t = run([{ t: "sent", id: "ask-1", mine: { kind: "answer", summary: "Yes" } }], s);
    expect(cardView(t.entries["ask-1"])).toMatchObject({ mode: "sending" });
    t = run([{ t: "result", id: "ask-1", ok: true, now: 10 }, { t: "resolved", id: "ask-1", by: "phone", now: 11 }], t);
    expect(cardView(t.entries["ask-1"])).toMatchObject({ mode: "done", tone: "ok", text: "Answered", detail: "Yes" });
    // either order: resolved before the result
    const u = run([{ t: "sent", id: "ask-1", mine: { kind: "answer", summary: "Yes" } }, { t: "resolved", id: "ask-1", by: "phone", now: 11 }], s);
    expect(cardView(u.entries["ask-1"])).toMatchObject({ mode: "done", text: "Answered" });
  });

  it("trailing_cards_for_unjoined_asks_and_permissions", () => {
    const s = run([{ t: "snapshot", items: [ask("ask-1", "tu1"), ask("ask-2", "tu2"), perm("perm-1"), perm("perm-2", "s2")].map(fromWire), now: 0 }]);
    // tu1 already has a transcript card; tu2 does not yet; permissions are always standalone
    const ids = trailingEntries(s, "s1", new Set(["tu1"]), 0).map((e) => e.item.id);
    expect(ids).toEqual(["ask-2", "perm-1"]);
    // a settled trailing card stays a moment, then goes
    const r = run([{ t: "resolved", id: "perm-1", by: "terminal", now: 100 }], s);
    expect(trailingEntries(r, "s1", new Set(["tu1"]), 100 + SETTLED_SHOW_MS - 1).map((e) => e.item.id)).toContain("perm-1");
    expect(trailingEntries(r, "s1", new Set(["tu1"]), 100 + SETTLED_SHOW_MS).map((e) => e.item.id)).not.toContain("perm-1");
  });

  it("multiselect_joins_with_comma_space", () => {
    // option order, not tap order; original labels (marker and all) go back
    expect(buildAnswers([MQ], { [MQ.question]: ["build", "lint"] }, {})).toEqual({ "Which checks?": "lint, build" });
    expect(buildAnswers([Q], { [Q.question]: ["Yes (Recommended)"] }, {})).toEqual({ "Ship it?": "Yes (Recommended)" });
    // free text wins over picks; an unanswered question means nothing to send
    expect(buildAnswers([Q, MQ], { [Q.question]: ["No"] }, { [MQ.question]: "  just lint  " })).toEqual({
      "Ship it?": "No",
      "Which checks?": "just lint",
    });
    expect(buildAnswers([Q, MQ], { [Q.question]: ["No"] }, {})).toBeNull();
    expect(answerSummary({ a: "Yes (Recommended)", b: "lint, build" })).toBe("Yes, lint, build");
  });

  it("a_rejected_answer_returns_the_card_to_live", () => {
    const s = run([{ t: "snapshot", items: [ask("ask-1", "tu1")].map(fromWire), now: 0 }]);
    // The Mac refused the answer itself (too long), and nobody else has answered: the question
    // is still waiting, so the card must not claim it is done.
    let t = run(
      [
        { t: "sent", id: "ask-1", mine: { kind: "answer", summary: "x".repeat(60) } },
        { t: "result", id: "ask-1", ok: false, now: 5 },
      ],
      s,
    );
    expect(cardView(t.entries["ask-1"])).toMatchObject({ mode: "live", notice: REJECTED_ANSWER_TEXT });
    expect(REJECTED_ANSWER_TEXT).toBe("Couldn't send that answer — try a shorter one");
    expect(openBySession(t)["s1"]?.id).toBe("ask-1");
    expect(trailingEntries(t, "s1", new Set(), 10_000)).toHaveLength(1);
    // A retry goes out and can win.
    t = run(
      [
        { t: "sent", id: "ask-1", mine: { kind: "answer", summary: "short" } },
        { t: "result", id: "ask-1", ok: true, now: 6 },
      ],
      t,
    );
    expect(cardView(t.entries["ask-1"])).toMatchObject({ mode: "done", tone: "ok", text: "Answered", detail: "short" });
    // Or someone else answers meanwhile: the resolved frame settles it honestly.
    const u = run(
      [
        { t: "sent", id: "ask-1", mine: { kind: "answer", summary: "long" } },
        { t: "result", id: "ask-1", ok: false, now: 5 },
        { t: "resolved", id: "ask-1", by: "phone", now: 6 },
      ],
      s,
    );
    expect(cardView(u.entries["ask-1"])).toMatchObject({ mode: "done", tone: "info", text: "Already answered on another phone" });
  });

  it("late_tap_shows_already_answered", () => {
    const s = run([{ t: "snapshot", items: [ask("ask-1", "tu1"), perm("perm-1")].map(fromWire), now: 0 }]);
    // the Mac answered first: ok:false, then (or before) resolved names it
    let t = run(
      [
        { t: "sent", id: "ask-1", mine: { kind: "answer", summary: "Yes" } },
        { t: "result", id: "ask-1", ok: false, now: 5 },
        { t: "resolved", id: "ask-1", by: "desktop", now: 5 },
      ],
      s,
    );
    expect(cardView(t.entries["ask-1"])).toMatchObject({ mode: "done", tone: "info", text: "Already answered on your Mac" });
    // ok:false with no resolved frame (it fell out of the ring): still honest
    t = run([{ t: "sent", id: "perm-1", mine: { kind: "approve", allow: false } }, { t: "result", id: "perm-1", ok: false, now: 5 }], s);
    expect(cardView(t.entries["perm-1"])).toMatchObject({ mode: "done", text: "Already answered" });
    // an ask resolved by the terminal is always a hand-off (Esc, last phone left, another
    // window): never "Answered in the terminal"; the timeout says the same
    expect(cardView(run([{ t: "resolved", id: "ask-1", by: "terminal", now: 1 }], s).entries["ask-1"])).toMatchObject({ text: "Moved to the terminal" });
    expect(cardView(run([{ t: "resolved", id: "ask-1", by: "timeout", now: 1 }], s).entries["ask-1"])).toMatchObject({ text: "Moved to the terminal" });
    const lateAsk = run([{ t: "sent", id: "ask-1", mine: { kind: "answer", summary: "Yes" } }, { t: "resolved", id: "ask-1", by: "terminal", now: 1 }], s);
    expect(cardView(lateAsk.entries["ask-1"])).toMatchObject({ text: "Moved to the terminal" });
    // a permission the terminal handled says so
    expect(cardView(run([{ t: "resolved", id: "perm-1", by: "terminal", now: 1 }], s).entries["perm-1"])).toMatchObject({ text: "Handled in the terminal" });
    const latePerm = run([{ t: "sent", id: "perm-1", mine: { kind: "approve", allow: true } }, { t: "resolved", id: "perm-1", by: "terminal", now: 1 }], s);
    expect(cardView(latePerm.entries["perm-1"])).toMatchObject({ text: "Already handled in the terminal" });
    for (const v of [s, lateAsk, latePerm].flatMap((x) => Object.values(x.entries)).map(cardView)) {
      expect("text" in v ? v.text : "").not.toContain("Answered in the terminal");
    }
  });

  it("a_restarted_mac_reusing_an_id_is_a_new_item", () => {
    // ask-N / perm-N restart at 1 when Conduit relaunches; the Mac is the truth
    let s = run([
      { t: "snapshot", items: [ask("ask-1", "tu1"), perm("perm-1")].map(fromWire), now: 0 },
      { t: "sent", id: "ask-1", mine: { kind: "answer", summary: "Yes" } },
      { t: "result", id: "ask-1", ok: true, now: 1 },
      { t: "resolved", id: "perm-1", by: "desktop", now: 1 },
    ]);
    expect(cardView(s.entries["ask-1"]).mode).toBe("done");
    // the relaunched Mac's snapshot carries a NEW ask-1
    const snap = run([{ t: "snapshot", items: [ask("ask-1", "tu-new")].map(fromWire), now: 5 }], s);
    expect(cardView(snap.entries["ask-1"])).toMatchObject({ mode: "live", item: { toolUseId: "tu-new" } });
    expect(entryForToolUse(snap, "s1", "tu-new")?.item.id).toBe("ask-1");
    expect(openBySession(snap)).toEqual({ s1: expect.objectContaining({ id: "ask-1" }) });
    // the settled perm-1 the snapshot does not name keeps its outcome
    expect(cardView(snap.entries["perm-1"]).mode).toBe("done");
    // a pendingAdded reusing a settled id is new too
    s = run([{ t: "added", item: fromWire(perm("perm-1")) }], s);
    expect(cardView(s.entries["perm-1"]).mode).toBe("live");
    expect(s.order.filter((id) => id === "perm-1")).toHaveLength(1);
    // but a pendingAdded for an item already open here changes nothing
    expect(run([{ t: "added", item: fromWire(perm("perm-1")) }], s)).toBe(s);
  });

  it("an_unsent_tap_stays_live_and_a_reconnect_clears_sending", () => {
    const s = run([{ t: "snapshot", items: [perm("perm-1"), ask("ask-1", "tu1")].map(fromWire), now: 0 }]);
    // the socket was not open: nothing went out, so the card stays live and says why
    const u = run([{ t: "unsent", id: "perm-1" }], s);
    expect(cardView(u.entries["perm-1"])).toMatchObject({ mode: "live", notice: "Not connected — try again" });
    // a later tap that does go out clears the notice
    const v = run([{ t: "sent", id: "perm-1", mine: { kind: "approve", allow: true } }], u);
    expect(cardView(v.entries["perm-1"])).toMatchObject({ mode: "sending" });
    expect(v.entries["perm-1"].unsent).toBeUndefined();
    // a frame lost with a dropped socket: the reconnect snapshot still lists it, so it is live
    // again (resending is safe: first answer wins)
    const w = run(
      [
        { t: "sent", id: "ask-1", mine: { kind: "answer", summary: "Yes" } },
        { t: "snapshot", items: [ask("ask-1", "tu1")].map(fromWire), now: 3 },
      ],
      s,
    );
    expect(cardView(w.entries["ask-1"])).toEqual({ mode: "live", item: w.entries["ask-1"].item });
    // unsent never touches a settled or private item
    const done = run([{ t: "resolved", id: "perm-1", by: "desktop", now: 1 }], s);
    expect(run([{ t: "unsent", id: "perm-1" }], done)).toBe(done);
  });

  it("permission_copy_never_claims_more_than_it_did", () => {
    const s = run([{ t: "snapshot", items: [perm("perm-1"), perm("perm-2")].map(fromWire), now: 0 }]);
    const t = run(
      [
        { t: "sent", id: "perm-1", mine: { kind: "approve", allow: true } },
        { t: "result", id: "perm-1", ok: true, now: 1 },
        { t: "sent", id: "perm-2", mine: { kind: "approve", allow: false } },
        { t: "result", id: "perm-2", ok: true, now: 1 },
      ],
      s,
    );
    expect(cardView(t.entries["perm-1"])).toMatchObject({ mode: "done", text: "Allowed" });
    expect(cardView(t.entries["perm-2"])).toMatchObject({
      mode: "done",
      text: "Denied — if you'd already allowed it in the terminal, it keeps running.",
    });
  });

  it("private_item_not_interactive", () => {
    const s = run([
      {
        t: "snapshot",
        items: [
          { kind: "ask", id: "ask-1", sessionId: "s1", private: true },
          { kind: "permission", id: "perm-1", sessionId: "s1", private: true },
        ].map((w) => fromWire(w as WirePendingItem)),
        now: 0,
      },
    ]);
    for (const id of ["ask-1", "perm-1"]) {
      expect(cardView(s.entries[id])).toEqual({ mode: "private", item: s.entries[id].item, text: PRIVATE_ANSWER_TEXT });
    }
    expect(PRIVATE_ANSWER_TEXT).toBe("Private session — answer it on your Mac");
    // a send for a private item is refused locally: it stays private, never "sending"
    const t = run([{ t: "sent", id: "ask-1", mine: { kind: "answer", summary: "x" } }], s);
    expect(cardView(t.entries["ask-1"]).mode).toBe("private");
  });

  it("an_absent_held_reads_as_held_for_an_older_mac", () => {
    const a = fromWire(ask("ask-1", "tu1"));
    const p = fromWire(perm("perm-1"));
    expect(!a.private && a.held).toBe(true);
    expect(!p.private && p.held).toBe(true);
    expect(cardView({ item: a }).mode).toBe("live");
  });

  it("a_question_the_terminal_has_is_shown_in_full_without_buttons", () => {
    const w = { ...ask("ask-1", "tu1"), held: false } as WirePendingItem;
    const s = run([{ t: "snapshot", items: [fromWire(w)], now: 0 }]);
    const e = s.entries["ask-1"];
    const v = cardView(e);
    expect(v).toEqual({ mode: "watching", item: e.item, text: WATCHING_TEXT });
    expect(WATCHING_TEXT).toBe("Waiting for an answer in the terminal on your Mac");
    // the full question travels with it
    expect(v.item.kind === "ask" && !v.item.private && v.item.questions).toEqual([Q]);
    // it joins the transcript card in place of the old read-only history card
    expect(entryForToolUse(s, "s1", "tu1")).toBe(e);
    // still needs you
    expect(openBySession(s)).toEqual({ s1: e.item });
    // nothing can be sent for it: no hook is waiting on an answer
    const t = run([{ t: "sent", id: "ask-1", mine: { kind: "answer", summary: "x" } }], s);
    expect(t.entries["ask-1"].sent).toBeUndefined();
    expect(cardView(t.entries["ask-1"]).mode).toBe("watching");
    const u = run([{ t: "unsent", id: "ask-1" }], s);
    expect(cardView(u.entries["ask-1"]).mode).toBe("watching");
  });

  it("a_permission_the_terminal_has_is_shown_without_buttons_and_says_how_it_ended", () => {
    const w = { ...perm("perm-1"), held: false } as WirePendingItem;
    let s = run([{ t: "added", item: fromWire(w) }]);
    expect(cardView(s.entries["perm-1"])).toMatchObject({ mode: "watching", text: WATCHING_TEXT });
    expect(trailingEntries(s, "s1", new Set(), 0).map((e) => e.item.id)).toEqual(["perm-1"]);
    // its own tool ran (PostToolUse): the terminal handled it
    s = run([{ t: "resolved", id: "perm-1", by: "terminal", now: 5 }], s);
    expect(cardView(s.entries["perm-1"])).toMatchObject({ mode: "done", tone: "info", text: "Handled in the terminal" });
    // an observed question answered in the terminal is ANSWERED there, not "moved"
    const q = { ...ask("ask-1", "tu1"), held: false } as WirePendingItem;
    let a = run([{ t: "added", item: fromWire(q) }]);
    a = run([{ t: "resolved", id: "ask-1", by: "terminal", now: 5 }], a);
    expect(cardView(a.entries["ask-1"])).toMatchObject({ mode: "done", text: "Answered in the terminal" });
    // a held one handed to the terminal still reads as moved: nobody answered it yet
    let h = run([{ t: "added", item: fromWire(ask("ask-2", "tu2")) }]);
    h = run([{ t: "resolved", id: "ask-2", by: "terminal", now: 5 }], h);
    expect(cardView(h.entries["ask-2"])).toMatchObject({ mode: "done", text: "Moved to the terminal" });
  });
});
