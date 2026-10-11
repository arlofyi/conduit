import { describe, expect, it } from "vitest";
import { askGateOpen, askShouldHandOff, buildAnswers, type AskQuestion, type PendingAsk } from "./asks";
import { MULTISELECT_JOIN } from "./askProtocol";

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
