import { acceptsFrame, frameSession, isSpawnError, refusesOpenChat, SPAWN_ERRORS, spawnErrorText } from "./frames";

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
