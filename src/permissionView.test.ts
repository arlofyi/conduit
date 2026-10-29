import { describe, expect, it } from "vitest";
import {
  alreadyAnsweredCopy,
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
    expect(resolvedCopy("phone")).toBe("Answered on your phone");
    expect(resolvedCopy("terminal")).toBe("Answered in the terminal");
    expect(resolvedCopy("timeout")).toBe("Moved to the terminal");
    expect(resolvedCopy("desktop")).toBe("Answered in another Conduit window");
  });
  it("says nothing for a cancellation or an unknown resolver", () => {
    expect(resolvedCopy("cancelled")).toBeNull();
    expect(resolvedCopy(null)).toBeNull();
  });
});

describe("alreadyAnsweredCopy", () => {
  it("says where when it knows, and never guesses", () => {
    expect(alreadyAnsweredCopy("phone")).toBe("Already answered on your phone.");
    expect(alreadyAnsweredCopy("terminal")).toBe("Already answered in the terminal.");
    expect(alreadyAnsweredCopy("desktop")).toBe("Already answered in another Conduit window.");
    expect(alreadyAnsweredCopy("timeout")).toBe("It moved to the terminal.");
    expect(alreadyAnsweredCopy("cancelled")).toBe("Already answered.");
    expect(alreadyAnsweredCopy(null)).toBe("Already answered.");
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
