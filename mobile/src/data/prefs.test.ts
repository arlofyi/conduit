import { createPrefsStore, DEFAULT_PREFS, parsePrefs } from "./prefs";

describe("prefs", () => {
  it("defaults_match_the_spec", () => {
    expect(DEFAULT_PREFS.notifyQuestion).toBe(true);
    expect(DEFAULT_PREFS.notifyPermission).toBe(true);
    expect(DEFAULT_PREFS.notifyFinished).toBe(false);
  });
  it("corrupt_or_missing_is_defaults", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("{nope")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("[1]")).toEqual(DEFAULT_PREFS);
  });
  it("bad_fields_fall_back_individually", () => {
    const p = parsePrefs(JSON.stringify({ notifyFinished: true, notifyQuestion: "yes", theme: "neon" }));
    expect(p).toEqual({ ...DEFAULT_PREFS, notifyFinished: true });
    expect(parsePrefs(JSON.stringify({ theme: "warm-light" })).theme).toBe("warm-light");
    expect(parsePrefs(JSON.stringify({ theme: "toString" })).theme).toBe(DEFAULT_PREFS.theme);
  });
  it("background_notification_flags_default_off_and_parse", () => {
    expect(DEFAULT_PREFS.notifyAsked).toBe(false);
    expect(DEFAULT_PREFS.batteryHintDismissed).toBe(false);
    const p = parsePrefs(JSON.stringify({ notifyAsked: true, batteryHintDismissed: "yes" }));
    expect(p.notifyAsked).toBe(true);
    expect(p.batteryHintDismissed).toBe(false);
  });
  it("store_round_trips_and_survives_a_read_error", async () => {
    const m = new Map<string, string>();
    const store = createPrefsStore({
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => void m.set(k, v),
      del: async (k) => void m.delete(k),
    });
    await store.save({ ...DEFAULT_PREFS, theme: "warm-dim", notifyQuestion: false });
    expect(await store.load()).toEqual({ ...DEFAULT_PREFS, theme: "warm-dim", notifyQuestion: false });
    const broken = createPrefsStore({
      get: async () => {
        throw new Error("keychain");
      },
      set: async () => undefined,
      del: async () => undefined,
    });
    expect(await broken.load()).toEqual(DEFAULT_PREFS);
  });
});
