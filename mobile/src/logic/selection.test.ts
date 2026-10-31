import { confirmText, prune, resultText, toggle } from "./selection";

describe("selection", () => {
  it("toggles ids", () => {
    const a = toggle(new Set(), "x");
    expect([...a]).toEqual(["x"]);
    expect([...toggle(a, "x")]).toEqual([]);
  });

  it("drops ids that left the list and keeps identity when nothing did", () => {
    const sel = new Set(["a", "b"]);
    expect(prune(sel, ["a", "b", "c"])).toBe(sel);
    expect([...prune(sel, ["a"])]).toEqual(["a"]);
  });

  it("always confirms a delete and says what is kept", () => {
    const c = confirmText("delete", 3, 1);
    expect(c?.title).toBe("Delete 3 sessions?");
    expect(c?.body).toMatch(/One is still working/);
    expect(c?.body).toMatch(/worktree folder/);
    expect(confirmText("delete", 1, 0)?.title).toBe("Delete this session?");
  });

  it("confirms a stop only when something is working", () => {
    expect(confirmText("stop", 2, 0)).toBeNull();
    expect(confirmText("stop", 2, 2)?.body).toMatch(/2 are working/);
  });

  it("reports what happened and why anything was skipped", () => {
    expect(resultText("stop", { ok: true, done: ["a"], skipped: [] })).toBe("Stopped 1 session.");
    expect(
      resultText("delete", { ok: true, done: ["a", "b"], skipped: [{ id: "c", reason: "private session" }] }),
    ).toBe("Deleted 2 sessions. Skipped 1 (private session).");
    expect(resultText("delete", { ok: false, error: "Not connected." })).toBe("Not connected.");
  });
});
