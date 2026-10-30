import { describe, expect, it } from "vitest";
import { answerSummary, askGateOpen, askResolvedPlan, askResolvedToast, askShouldHandOff, buildAnswers, permissionsToShow, sessionsAwaitingAnswer, splitRecommended, waitingClock, type AskQuestion, type PendingAsk } from "./asks";
import { MULTISELECT_JOIN } from "./askProtocol";
import { resolvedCopy } from "./permissionView";

const ask: PendingAsk = {
  id: "ask-1", session: "s1", toolUseId: "t",
  questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }], createdMs: 0,
};

describe("ask gate", () => {
  it("opens only when enabled and someone could see a card", () => {
    expect(askGateOpen({ enabled: true, viewOpen: true, windowFocused: false })).toBe(true);
    expect(askGateOpen({ enabled: true, viewOpen: false, windowFocused: true })).toBe(true);
    expect(askGateOpen({ enabled: true, viewOpen: false, windowFocused: false })).toBe(false);
    expect(askGateOpen({ enabled: false, viewOpen: true, windowFocused: true })).toBe(false);
  });
});

describe("hand-off", () => {
  it("hands off when the user is looking at that session's terminal", () => {
    expect(askShouldHandOff(ask, { selectedSessionId: "s1", continuityVisible: false, windowFocused: true })).toBe(true);
  });
  it("keeps the card while the graph is the visible surface, another session is selected, or the window is unfocused", () => {
    expect(askShouldHandOff(ask, { selectedSessionId: "s1", continuityVisible: true, windowFocused: true })).toBe(false);
    expect(askShouldHandOff(ask, { selectedSessionId: "s2", continuityVisible: false, windowFocused: true })).toBe(false);
    expect(askShouldHandOff(ask, { selectedSessionId: "s1", continuityVisible: false, windowFocused: false })).toBe(false);
    expect(askShouldHandOff(ask, { selectedSessionId: null, continuityVisible: false, windowFocused: true })).toBe(false);
  });
});

describe("permissionsToShow", () => {
  const perm = (id: string, session: string) => ({ id, session, toolName: "Bash", summary: "ls", createdMs: 0 });
  const list = [perm("p1", "s1"), perm("p2", "s2")];
  it("hides a permission for the terminal already in front of the user (Claude is asking there)", () => {
    expect(permissionsToShow(list, { selectedSessionId: "s1", continuityVisible: false, windowFocused: true }).map((p) => p.id)).toEqual(["p2"]);
  });
  it("shows it again once the user looks away", () => {
    expect(permissionsToShow(list, { selectedSessionId: "s2", continuityVisible: false, windowFocused: true }).map((p) => p.id)).toEqual(["p1"]);
    expect(permissionsToShow(list, { selectedSessionId: "s1", continuityVisible: false, windowFocused: false }).map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(permissionsToShow(list, { selectedSessionId: "s1", continuityVisible: true, windowFocused: true }).map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("buildAnswers", () => {
  const qs: AskQuestion[] = [
    { question: "One?", options: [{ label: "A" }, { label: "B" }] },
    { question: "Many?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }, { label: "Z" }] },
  ];
  it("free text wins over a pick, multi-select joins in option order", () => {
    expect(buildAnswers(qs, { "One?": ["B"], "Many?": ["Z", "X"] }, { "One?": "" })).toEqual({
      "One?": "B", "Many?": ["X", "Z"].join(MULTISELECT_JOIN),
    });
    expect(buildAnswers(qs, { "One?": ["B"], "Many?": ["Y"] }, { "One?": "  typed  " })).toEqual({
      "One?": "typed", "Many?": "Y",
    });
  });
  it("returns null until every question has an answer", () => {
    expect(buildAnswers(qs, { "One?": ["A"] }, {})).toBeNull();
    expect(buildAnswers(qs, { "One?": [], "Many?": ["X"] }, { "One?": "   " })).toBeNull();
  });
});

describe("splitRecommended", () => {
  it("strips a trailing (Recommended) and flags the row", () => {
    expect(splitRecommended("Run it now (Recommended)")).toEqual({ label: "Run it now", recommended: true });
    expect(splitRecommended("Run it now  (recommended)  ")).toEqual({ label: "Run it now", recommended: true });
    expect(splitRecommended("Run it now (RECOMMENDED)")).toEqual({ label: "Run it now", recommended: true });
    expect(splitRecommended("Run it now(Recommended)")).toEqual({ label: "Run it now", recommended: true });
  });
  it("leaves a label without the suffix alone", () => {
    expect(splitRecommended("Hold for review")).toEqual({ label: "Hold for review", recommended: false });
    expect(splitRecommended("(Recommended) first")).toEqual({ label: "(Recommended) first", recommended: false });
  });
  it("keeps a label that is only the marker, rather than emptying it", () => {
    expect(splitRecommended("(Recommended)")).toEqual({ label: "(Recommended)", recommended: false });
    expect(splitRecommended("  (Recommended) ")).toEqual({ label: "  (Recommended) ", recommended: false });
  });
});

describe("answerSummary", () => {
  it("joins every answer with a comma and drops the Recommended marker", () => {
    expect(answerSummary({ "A?": "Run it now (Recommended)", "B?": "Unit, Integration" })).toBe(
      "Run it now, Unit, Integration",
    );
  });
  it("truncates a long answer with an ellipsis", () => {
    const s = answerSummary({ "A?": "x".repeat(100) });
    expect(s.length).toBe(60);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("waitingClock", () => {
  it("formats elapsed time as m:ss and never goes negative", () => {
    expect(waitingClock(1_000, 43_000)).toBe("0:42");
    expect(waitingClock(0, 125_400)).toBe("2:05");
    expect(waitingClock(10_000, 5_000)).toBe("0:00");
    expect(waitingClock(0, 61 * 60_000)).toBe("61:00");
  });
});

describe("sessionsAwaitingAnswer", () => {
  const a2: PendingAsk = { ...ask, id: "ask-2", createdMs: 5 };
  const other: PendingAsk = { ...ask, id: "ask-3", session: "s2" };
  it("counts a session while any of its asks is unanswered", () => {
    expect([...sessionsAwaitingAnswer([ask, a2, other], {})].sort()).toEqual(["s1", "s2"]);
    expect([...sessionsAwaitingAnswer([ask, a2], { "ask-1": true })]).toEqual(["s1"]);
  });
  it("drops a session whose only ask is holding its sent confirmation", () => {
    expect([...sessionsAwaitingAnswer([ask, other], { "ask-1": true })]).toEqual(["s2"]);
  });
});

describe("askResolvedToast", () => {
  it("speaks only when a card the user could see ran out of time", () => {
    expect(askResolvedToast("timeout", true)).toBe(true);
    expect(askResolvedToast("timeout", false)).toBe(false);
    expect(askResolvedToast("handoff", true)).toBe(false);
    expect(askResolvedToast("answered", true)).toBe(false);
  });
});

describe("askResolvedPlan", () => {
  const base = { shown: true, handedOffHere: false };
  it("removes a cancelled question silently", () => {
    expect(askResolvedPlan({ how: "cancelled", by: "cancelled", ...base })).toEqual({ hold: false, answered: false, note: null, toast: false });
  });
  it("keeps the timeout toast and drops the card", () => {
    expect(askResolvedPlan({ how: "timeout", by: "timeout", ...base })).toEqual({ hold: false, answered: false, note: null, toast: true });
    expect(askResolvedPlan({ how: "timeout", by: "timeout", shown: false, handedOffHere: false }).toast).toBe(false);
  });
  it("says the phone answered, not 'Sent to …'", () => {
    expect(askResolvedPlan({ how: "answered", by: "phone", ...base })).toEqual({ hold: true, answered: true, note: "phone", toast: false });
  });
  it("holds a desktop answer so the card's own confirmation can show", () => {
    expect(askResolvedPlan({ how: "answered", by: "desktop", ...base })).toEqual({ hold: true, answered: true, note: "desktop", toast: false });
  });
  it("treats an answer with no resolver as before", () => {
    expect(askResolvedPlan({ how: "answered", by: null, ...base })).toEqual({ hold: true, answered: true, note: null, toast: false });
  });
  it("drops a hand-off this window made, and says another side moved it to the terminal", () => {
    expect(askResolvedPlan({ how: "handoff", by: "terminal", shown: true, handedOffHere: true }).hold).toBe(false);
    expect(askResolvedPlan({ how: "handoff", by: "terminal", shown: false, handedOffHere: false }).hold).toBe(false);
    const plan = askResolvedPlan({ how: "handoff", by: "terminal", ...base });
    expect(plan).toEqual({ hold: true, answered: false, note: "terminal", toast: false });
    // A hand-off answers nothing: the question is still waiting in the terminal's menu.
    expect(resolvedCopy(plan.note, "ask")).toBe("Moved to the terminal");
  });
});
