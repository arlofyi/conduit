import { describe, expect, it } from "vitest";
import {
  alreadyAnsweredCopy,
  cardResolution,
  parseBy,
  permissionOutcomeCopy,
  remoteNote,
  resolutionHold,
  resolvedCopy,
  sortPermissions,
  type PendingPermission,
} from "./permissionView";

describe("parseBy", () => {
  it("accepts the five wire values and nothing else", () => {
    for (const v of ["phone", "desktop", "terminal", "timeout", "cancelled"]) expect(parseBy(v)).toBe(v);
    expect(parseBy("Phone")).toBeNull();
    expect(parseBy(undefined)).toBeNull();
    expect(parseBy(3)).toBeNull();
  });
});

describe("resolvedCopy", () => {
  it("names where it was answered, from the Mac's side", () => {
    for (const kind of ["ask", "permission"] as const) {
      expect(resolvedCopy("phone", kind)).toBe("Answered on your phone");
      expect(resolvedCopy("timeout", kind)).toBe("Moved to the terminal");
      expect(resolvedCopy("desktop", kind)).toBe("Answered in another Conduit window");
    }
  });
  it("never calls a question's hand-off an answer", () => {
    // An ask's `by: terminal` is always a hand-off (Esc killing the hook, another window's
    // auto hand-off, the last phone leaving): the question is still waiting in the menu.
    expect(resolvedCopy("terminal", "ask")).toBe("Moved to the terminal");
  });
  it("does not claim a permission was answered when the event cannot tell", () => {
    // A permission's `by: terminal` is a terminal "No"/Esc OR the last phone leaving, and
    // `permission-resolved` carries only {id, by}, so it cannot say which.
    expect(resolvedCopy("terminal", "permission")).toBe("Handled in the terminal");
  });
  it("says nothing for a cancellation or an unknown resolver", () => {
    expect(resolvedCopy("cancelled", "ask")).toBeNull();
    expect(resolvedCopy(null, "permission")).toBeNull();
  });
});

describe("alreadyAnsweredCopy", () => {
  it("says where when it knows, and never guesses", () => {
    for (const kind of ["ask", "permission"] as const) {
      expect(alreadyAnsweredCopy("phone", kind)).toBe("Already answered on your phone.");
      expect(alreadyAnsweredCopy("desktop", kind)).toBe("Already answered in another Conduit window.");
      expect(alreadyAnsweredCopy("timeout", kind)).toBe("It moved to the terminal.");
      expect(alreadyAnsweredCopy("cancelled", kind)).toBe("Already answered.");
      expect(alreadyAnsweredCopy(null, kind)).toBe("Already answered.");
    }
    expect(alreadyAnsweredCopy("terminal", "ask")).toBe("It moved to the terminal.");
    expect(alreadyAnsweredCopy("terminal", "permission")).toBe("Already handled in the terminal.");
  });
});

describe("cardResolution", () => {
  it("shows a remote resolution on an open card", () => {
    expect(cardResolution("idle", "phone", "ask")).toEqual({ view: "remote", copy: "Answered on your phone" });
    expect(cardResolution("idle", null, "ask")).toBeNull();
    expect(cardResolution("error", "terminal", "ask")).toEqual({ view: "remote", copy: "Moved to the terminal" });
  });
  it("does not take this card's own in-flight answer for another window's", () => {
    expect(cardResolution("sending", "desktop", "permission")).toBeNull();
    expect(cardResolution("sending", "phone", "permission")).toEqual({ view: "remote", copy: "Answered on your phone" });
  });
  it("keeps the remote copy when this card's own call then comes back false (no flip back to the form)", () => {
    expect(cardResolution("gone", "phone", "permission")).toEqual({ view: "remote", copy: "Answered on your phone" });
    expect(cardResolution("gone", "desktop", "ask")).toEqual({ view: "remote", copy: "Answered in another Conduit window" });
  });
  it("falls back to the 'already answered' note only when nobody said who", () => {
    expect(cardResolution("gone", null, "ask")).toEqual({ view: "gone", copy: "Already answered." });
    expect(cardResolution("gone", "cancelled", "permission")).toEqual({ view: "gone", copy: "Already answered." });
  });
  it("leaves the card's own confirmation alone", () => {
    expect(cardResolution("done", "desktop", "ask")).toBeNull();
  });
});

describe("remoteNote", () => {
  it("shows a remote resolution on a card that did not answer", () => {
    expect(remoteNote("phone", false)).toBe("phone");
    expect(remoteNote("terminal", false)).toBe("terminal");
    expect(remoteNote("desktop", false)).toBe("desktop");
  });
  it("does not mistake this card's own in-flight answer for another window's", () => {
    // Rust resolves (and emits by:desktop) before the card's own invoke returns.
    expect(remoteNote("desktop", true)).toBeNull();
    // The phone winning the race is still the phone.
    expect(remoteNote("phone", true)).toBe("phone");
  });
  it("never shows a cancellation or nothing", () => {
    expect(remoteNote("cancelled", false)).toBeNull();
    expect(remoteNote(null, false)).toBeNull();
  });
});

describe("resolutionHold", () => {
  it("drops a cancelled or unseen card at once and holds a seen one", () => {
    expect(resolutionHold("cancelled", true)).toBe(false);
    expect(resolutionHold("phone", false)).toBe(false);
    expect(resolutionHold("phone", true)).toBe(true);
    expect(resolutionHold("timeout", true)).toBe(true);
    expect(resolutionHold(null, true)).toBe(false);
  });
});

describe("permissionOutcomeCopy", () => {
  it("claims only that the answer reached Claude's hook", () => {
    expect(permissionOutcomeCopy(true)).toEqual({ title: "Allowed" });
    const deny = permissionOutcomeCopy(false);
    expect(deny.title).toBe("Denied");
    expect(deny.detail).toBe("If you'd already allowed it in the terminal, it keeps running.");
  });
});

describe("sortPermissions", () => {
  it("is oldest first and does not mutate its input", () => {
    const p = (id: string, createdMs: number): PendingPermission => ({ id, session: "s", toolName: "Bash", summary: "ls", createdMs });
    const input = [p("b", 2), p("a", 1), p("c", 3)];
    expect(sortPermissions(input).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(input.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
});
