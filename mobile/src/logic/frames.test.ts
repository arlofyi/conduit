import {
  acceptsFrame,
  frameSession,
  isSpawnError,
  refusesOpenChat,
  SPAWN_ERRORS,
  spawnErrorText,
  TRUST_STALL,
  trustStallNotice,
} from "./frames";

describe("session-tagged frames", () => {
  it("keeps frames for the open chat and drops the one the reader left", () => {
    expect(acceptsFrame("s1", "s1")).toBe(true);
    expect(acceptsFrame("old", "s1")).toBe(false);
    expect(acceptsFrame("s1", null)).toBe(false);
  });

  it("accepts untagged frames from an older Mac", () => {
    expect(acceptsFrame(undefined, "s1")).toBe(true);
    expect(acceptsFrame(null, null)).toBe(true);
  });

  it("attributes a frame to its tag, else to the streamed session", () => {
    expect(frameSession("s2", "s1")).toBe("s2");
    expect(frameSession(undefined, "s1")).toBe("s1");
    expect(frameSession(undefined, null)).toBeNull();
  });
});

describe("private-session refusals", () => {
  it("refuse the open chat, never one the reader already left", () => {
    expect(refusesOpenChat("private session", "s1", "s1")).toBe(true);
    expect(refusesOpenChat("private session", "old", "s1")).toBe(false);
    expect(refusesOpenChat("private session", "s1", null)).toBe(false);
    expect(refusesOpenChat("no such session", "s1", "s1")).toBe(false);
  });

  it("an untagged refusal from an older Mac still counts", () => {
    expect(refusesOpenChat("private session", undefined, "s1")).toBe(true);
  });
});

describe("spawn errors", () => {
  it("only the spawn's own errors fail a pending spawn", () => {
    for (const m of SPAWN_ERRORS) expect(isSpawnError(m)).toBe(true);
    expect(isSpawnError("private session")).toBe(false);
    expect(isSpawnError("no such session")).toBe(false);
    expect(isSpawnError("unauthorized")).toBe(false);
  });

  it("has a sentence for each", () => {
    expect(spawnErrorText("too many new chats — try again later")).toMatch(/try again later/);
    expect(spawnErrorText("could not create session")).toMatch(/couldn't start/);
  });
});

describe("a new chat waiting on the Mac's folder-trust prompt", () => {
  it("matches bridge.rs TRUST_STALL_MESSAGE exactly", () => {
    expect(TRUST_STALL).toBe("Claude is waiting on your Mac \u2014 open this folder there once to trust it");
  });
  it("becomes a notice in the chat it names, and only there", () => {
    expect(trustStallNotice(TRUST_STALL, "s1", "s1", "n-1")).toEqual({
      kind: "notice",
      id: "n-1",
      tone: "info",
      text: "Claude is waiting on your Mac",
      detail: "Open this folder there once to trust it.",
    });
    expect(trustStallNotice(TRUST_STALL, "s1", "other", "n-1")).toBeNull();
    expect(trustStallNotice(TRUST_STALL, "s1", null, "n-1")).toBeNull();
    expect(trustStallNotice("private session", "s1", "s1", "n-1")).toBeNull();
    // It always names its session: an untagged one cannot be placed.
    expect(trustStallNotice(TRUST_STALL, undefined, "s1", "n-1")).toBeNull();
  });
  it("is never mistaken for a spawn failure", () => {
    expect(isSpawnError(TRUST_STALL)).toBe(false);
  });
});
