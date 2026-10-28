import { beforeEach, describe, expect, it, vi } from "vitest";

// `store.ts` reads `localStorage` and `window` at module scope and this suite runs in the node env, so
// give it in-memory ones BEFORE the dynamic import below. Tauri's IPC does not exist
// here either: `invoke` is a recording mock the tests script per command.
const { invokeMock } = vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  };
  // themes.ts asks the window for the system colour scheme while the store is created.
  (globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  return { invokeMock: vi.fn() };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const { applyCliOpenPayload, matchProjectByPath } = await import("./cliOpen");
const { useStore } = await import("./store");

const session = (args: Record<string, unknown>) => ({
  id: "s1",
  name: args.name,
  useWorktree: args.useWorktree,
  agent: args.agent,
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
    cmd === "add_session" ? session(args) : undefined,
  );
  useStore.setState({
    projects: [{ id: "p1", path: "/repo", name: "repo", sessions: [] }] as never,
    selectedProjectId: null,
    pendingPrompts: {},
  });
});

describe("applyCliOpenPayload", () => {
  it("opens a named worktree session with its prompt pending exactly once", async () => {
    await applyCliOpenPayload({
      path: "/repo",
      agent: "claude",
      worktree: "fix-a",
      name: "Fix: a",
      prompt: "brief",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "add_session",
      expect.objectContaining({ name: "Fix: a", useWorktree: true, worktreeSlug: "fix-a" }),
    );
    expect(useStore.getState().takePendingPrompt("s1")).toBe("brief");
    expect(useStore.getState().takePendingPrompt("s1")).toBeUndefined();
  });

  it("treats a v1 payload exactly as before", async () => {
    await applyCliOpenPayload({ path: "/repo", agent: "claude" });
    expect(invokeMock).toHaveBeenCalledWith(
      "add_session",
      expect.objectContaining({ useWorktree: false, worktreeSlug: null }),
    );
    expect(useStore.getState().takePendingPrompt("s1")).toBeUndefined();
  });

  it("drained pending opens keep prompt and slug", async () => {
    // The boot drain applies whatever `take_pending_opens` returns through this same function.
    const full = {
      path: "/repo",
      agent: "claude",
      worktree: "fix-a",
      name: "Fix: a",
      prompt: "brief",
    };
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
      cmd === "take_pending_opens" ? [full] : cmd === "add_session" ? session(args) : undefined,
    );
    const opens = await (await import("@tauri-apps/api/core")).invoke<(typeof full)[]>(
      "take_pending_opens",
    );
    for (const open of opens) await applyCliOpenPayload(open);
    expect(invokeMock).toHaveBeenCalledWith(
      "add_session",
      expect.objectContaining({ name: "Fix: a", useWorktree: true, worktreeSlug: "fix-a" }),
    );
    expect(useStore.getState().takePendingPrompt("s1")).toBe("brief");
  });
});

const projects = [
  { id: "a", path: "/Users/u/code/alpha" },
  { id: "b", path: "/Users/u/code/beta/" },
];

describe("matchProjectByPath", () => {
  it("finds an exact match", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/alpha")).toBe("a");
  });

  it("ignores a trailing slash on either side", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/alpha/")).toBe("a");
    expect(matchProjectByPath(projects, "/Users/u/code/beta")).toBe("b");
  });

  it("returns null when nothing matches, so the caller adds the project", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/gamma")).toBeNull();
  });

  it("does not treat a prefix as a match", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/alpha-2")).toBeNull();
    expect(matchProjectByPath(projects, "/Users/u/code")).toBeNull();
  });

  it("never matches an empty path", () => {
    expect(matchProjectByPath(projects, "")).toBeNull();
    expect(matchProjectByPath(projects, "/")).toBeNull();
  });

  it("compares Windows paths case-insensitively and normalizes separators", () => {
    const win = [{ id: "w", path: "C:\\Users\\u\\Code\\Alpha" }];
    expect(matchProjectByPath(win, "c:/users/u/code/alpha")).toBe("w");
  });
});
