import { describe, expect, it } from "vitest";
import {
  DONE_HOLDOFF_MS,
  doneSeenIn,
  needsKind,
  needsLabel,
  WORKING_STALE_MS,
  holdsOffWorking,
  isStaleWorking,
  notificationStatus,
  awaitsUser,
} from "./statusRules";

const NOW = 1_000_000_000;

describe("isStaleWorking", () => {
  it("retires only a running session, and only past the window", () => {
    expect(isStaleWorking("running", NOW - WORKING_STALE_MS - 1, NOW)).toBe(true);
    expect(isStaleWorking("running", NOW - WORKING_STALE_MS + 1, NOW)).toBe(false);
    // A long turn keeps firing tool events, each refreshing updatedAt, so it never trips.
    expect(isStaleWorking("running", NOW, NOW)).toBe(false);
    for (const other of ["idle", "done", "needsInput"] as const) {
      expect(isStaleWorking(other, 0, NOW)).toBe(false);
    }
  });

  it("treats an entry with no timestamp as fresh rather than sweeping it", () => {
    expect(isStaleWorking("running", undefined, NOW)).toBe(false);
  });

  it("does not sweep everything when the clock jumps backwards", () => {
    expect(isStaleWorking("running", NOW, 1)).toBe(false);
  });
});

describe("holdsOffWorking", () => {
  it("ignores tool chatter for a moment after the turn ends", () => {
    expect(holdsOffWorking("done", NOW - 1_000, NOW)).toBe(true);
    expect(holdsOffWorking("done", NOW - DONE_HOLDOFF_MS - 1, NOW)).toBe(false);
  });

  it("holds off nothing but done", () => {
    for (const other of ["idle", "running", "needsInput"] as const) {
      expect(holdsOffWorking(other, NOW, NOW)).toBe(false);
    }
    expect(holdsOffWorking(undefined, NOW, NOW)).toBe(false);
    expect(holdsOffWorking("done", undefined, NOW)).toBe(false);
  });
});

describe("notificationStatus", () => {
  it("raises the badge for the kinds that genuinely want a human", () => {
    for (const t of ["permission_prompt", "elicitation_dialog", "agent_needs_input"]) {
      expect(notificationStatus(t, "running")).toBe("needsInput");
      expect(notificationStatus(t, "done")).toBe("needsInput");
    }
  });

  it("uses idle_prompt to rescue a stuck turn and never to disturb a finished one", () => {
    // Esc during a tool call: Claude aborts the tool and never runs Stop, so this is the
    // only signal that the session is no longer busy.
    expect(notificationStatus("idle_prompt", "running")).toBe("idle");
    // The same event also fires after a normal turn end. Acting on it there is what put a
    // permanent "needs input" badge on every completed session.
    expect(notificationStatus("idle_prompt", "done")).toBeUndefined();
    expect(notificationStatus("idle_prompt", "idle")).toBeUndefined();
    expect(notificationStatus("idle_prompt", "needsInput")).toBeUndefined();
  });

  it("reads idle_prompt on a question to the user as needs input, not a stuck turn", () => {
    expect(notificationStatus("idle_prompt", "running", true)).toBe("needsInput");
    expect(notificationStatus("idle_prompt", "done", true)).toBeUndefined();
    expect(awaitsUser("AskUserQuestion")).toBe(true);
    expect(awaitsUser("ExitPlanMode")).toBe(true);
    expect(awaitsUser("Bash")).toBe(false);
    expect(awaitsUser(undefined)).toBe(false);
  });

  it("ignores informational and unknown kinds", () => {
    for (const t of ["auth_success", "elicitation_complete", "agent_completed", "future"]) {
      expect(notificationStatus(t, "running")).toBeUndefined();
      expect(notificationStatus(t, "done")).toBeUndefined();
    }
  });

  it("keeps the legacy badge when the payload carries no type at all", () => {
    expect(notificationStatus(undefined, "running")).toBe("needsInput");
    expect(notificationStatus(undefined, "done")).toBe("needsInput");
  });
});

describe("done means finished unseen", () => {
  const t0 = 1_000_000;

  it("applies only to a done session that is in front of the user", () => {
    expect(doneSeenIn("done", t0, t0 + 10_000, false)).toBeUndefined();
    for (const status of ["idle", "running", "needsInput"] as const) {
      expect(doneSeenIn(status, t0, t0 + 10_000, true)).toBeUndefined();
    }
    expect(doneSeenIn(undefined, t0, t0, true)).toBeUndefined();
  });

  it("never marks seen inside the done-holdoff", () => {
    expect(doneSeenIn("done", t0, t0, true)).toBe(DONE_HOLDOFF_MS);
    expect(doneSeenIn("done", t0, t0 + 1_000, true)).toBe(DONE_HOLDOFF_MS - 1_000);
    expect(doneSeenIn("done", t0, t0 + DONE_HOLDOFF_MS, true)).toBe(0);
    expect(doneSeenIn("done", t0, t0 + 60_000, true)).toBe(0);
  });

  it("treats an entry with no timestamp as long finished, and a clock that went back as fresh", () => {
    expect(doneSeenIn("done", undefined, t0, true)).toBe(0);
    expect(doneSeenIn("done", t0, t0 - 5_000, true)).toBe(DONE_HOLDOFF_MS);
  });
});

describe("what a session needs you for", () => {
  it("reads the kind from the notification type", () => {
    expect(needsKind("permission_prompt")).toBe("permission");
    expect(needsKind("elicitation_dialog")).toBe("question");
    expect(needsKind("idle_prompt")).toBe("question");
    expect(needsKind("agent_needs_input")).toBe("input");
    expect(needsKind(undefined)).toBe("input");
    expect(needsKind("something_new")).toBe("input");
  });

  it("labels each kind, and an unknown one as the plain pill", () => {
    expect(needsLabel("permission").text).toBe("approve?");
    expect(needsLabel("question").text).toBe("question");
    expect(needsLabel("input").text).toBe("needs you");
    expect(needsLabel(undefined).text).toBe("needs you");
    for (const k of ["permission", "question", "input", undefined] as const) {
      expect(needsLabel(k).title.length).toBeGreaterThan(10);
    }
  });
});
