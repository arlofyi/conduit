import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import type { ChatItem } from "../data/types";
import { rootKey, sessionKey } from "./offlineCache";
import { OfflineStore, type CacheFs, type StoreTimers } from "./offlineStore";

/** An in-memory file system: path -> text. */
function memFs() {
  const files = new Map<string, string>();
  const fs: CacheFs = {
    read: async (p) => files.get(p) ?? null,
    write: (p, t) => void files.set(p, t),
    remove: (p) => void files.delete(p),
    removeDir: (d) => {
      for (const k of [...files.keys()]) if (k.startsWith(`${d}/`)) files.delete(k);
    },
    listDirs: () => [...new Set([...files.keys()].map((k) => k.split("/")[0]))],
    size: () => [...files.values()].reduce((n, t) => n + t.length, 0),
  };
  return { fs, files };
}

/** Manual timers: `tick` runs what is due. */
function fakeTimers() {
  let now = 1_000_000;
  let queue: { at: number; f: () => void; id: number }[] = [];
  let next = 1;
  const t: StoreTimers = {
    now: () => now,
    setTimeout: (f, ms) => {
      const id = next++;
      queue.push({ at: now + ms, f, id });
      return id;
    },
    clearTimeout: (id) => {
      queue = queue.filter((q) => q.id !== id);
    },
  };
  const tick = (ms: number) => {
    now += ms;
    const due = queue.filter((q) => q.at <= now);
    queue = queue.filter((q) => q.at > now);
    for (const q of due) q.f();
  };
  return { t, tick, pending: () => queue.length };
}

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

const items = (n: number): ChatItem[] => Array.from({ length: n }, (_, i) => ({ kind: "bubble", id: `b${i}`, role: "user", text: `m${i}` }));

function sess(id: string, silo = false): WireViewSession {
  return { id, name: id, agent: "claude", branch: null, model: null, stopped: false, running: false, silo, status: "idle", activity: null, updatedAt: null, needs: null, lastMessage: null };
}
const view = (sessions: WireViewSession[]): WireProjectsView => ({
  profiles: [],
  activeProfileId: null,
  projects: [{ id: "p", name: "P", profileId: null, color: null, sessions }],
});

describe("OfflineStore", () => {
  it("debounces: many saves, one write after things go quiet", async () => {
    const { fs, files } = memFs();
    const { t, tick } = fakeTimers();
    const store = new OfflineStore(fs, t, 1000, 10_000);
    for (let i = 1; i <= 5; i++) {
      store.saveChat("mac", sessionKey("s1"), items(i));
      tick(500);
    }
    expect(files.size).toBe(0);
    tick(1000);
    await flushPromises();
    const c = await store.loadChat("mac", sessionKey("s1"));
    expect(c?.items).toHaveLength(5);
    expect([...files.keys()].sort()).toEqual(["mac/index.json", "mac/s-s1.json"]);
  });

  it("a steady stream still writes by the max wait", async () => {
    const { fs, files } = memFs();
    const { t, tick } = fakeTimers();
    const store = new OfflineStore(fs, t, 1000, 3000);
    for (let i = 0; i < 8; i++) {
      store.saveChat("mac", sessionKey("s1"), items(i + 1));
      tick(500);
    }
    await flushPromises();
    expect(files.has("mac/s-s1.json")).toBe(true);
  });

  it("reads a pending write before it reaches the disk", async () => {
    const { fs } = memFs();
    const { t } = fakeTimers();
    const store = new OfflineStore(fs, t);
    store.saveChat("mac", rootKey("c1"), items(2));
    expect((await store.loadChat("mac", rootKey("c1")))?.items).toHaveLength(2);
  });

  it("evicts the least recently saved chats past the count, deleting their files", async () => {
    const { fs, files } = memFs();
    const { t, tick } = fakeTimers();
    const store = new OfflineStore(fs, t, 10, 10);
    // MAX_CHATS is 50: save 52, one flush each so the save times differ.
    for (let i = 0; i < 52; i++) {
      store.saveChat("mac", sessionKey(`s${i}`), items(1));
      tick(20);
      await flushPromises();
    }
    expect(Object.keys(store.indexOf("mac").chats)).toHaveLength(50);
    expect(files.has("mac/s-s0.json")).toBe(false);
    expect(files.has("mac/s-s1.json")).toBe(false);
    expect(files.has("mac/s-s51.json")).toBe(true);
  });

  it("a projects list drops chats of sessions that are gone or turned private", async () => {
    const { fs, files } = memFs();
    const { t } = fakeTimers();
    const store = new OfflineStore(fs, t);
    store.saveChat("mac", sessionKey("keep"), items(1));
    store.saveChat("mac", sessionKey("secret"), items(1));
    store.saveChat("mac", sessionKey("gone"), items(1));
    await store.flush();
    store.saveProjects("mac", view([sess("keep"), sess("secret", true)]));
    await store.flush();
    expect(files.has("mac/s-keep.json")).toBe(true);
    expect(files.has("mac/s-secret.json")).toBe(false);
    expect(files.has("mac/s-gone.json")).toBe(false);
    expect(files.get("mac/projects.json")).not.toContain("secret");
    expect(Object.keys(store.indexOf("mac").chats)).toEqual(["s:keep"]);
  });

  it("dropChat removes a chat the computer refused as private", async () => {
    const { fs, files } = memFs();
    const { t } = fakeTimers();
    const store = new OfflineStore(fs, t);
    store.saveChat("mac", sessionKey("s1"), items(1));
    await store.flush();
    store.dropChat("mac", sessionKey("s1"));
    expect(await store.loadChat("mac", sessionKey("s1"))).toBeNull();
    await store.flush();
    expect(files.has("mac/s-s1.json")).toBe(false);
  });

  it("forgetting a computer drops its folder, pending writes included", async () => {
    const { fs, files } = memFs();
    const { t } = fakeTimers();
    const store = new OfflineStore(fs, t);
    store.saveChat("a", sessionKey("s1"), items(1));
    store.saveChat("b", sessionKey("s1"), items(1));
    await store.flush();
    store.saveChat("a", sessionKey("s2"), items(1));
    store.clearMac("a");
    await store.flush();
    expect([...files.keys()].some((k) => k.startsWith("a/"))).toBe(false);
    expect(files.has("b/s-s1.json")).toBe(true);
  });

  it("a clear during a flush writes nothing back", async () => {
    const { fs, files } = memFs();
    const { t } = fakeTimers();
    const store = new OfflineStore(fs, t);
    store.saveChat("a", sessionKey("s1"), items(1));
    const flushing = store.flush();
    store.clearAll();
    await flushing;
    expect(files.size).toBe(0);
  });

  it("pruneMacs removes computers no longer paired", async () => {
    const { fs, files } = memFs();
    const { t } = fakeTimers();
    const store = new OfflineStore(fs, t);
    store.saveChat("a", sessionKey("s1"), items(1));
    store.saveChat("b", sessionKey("s1"), items(1));
    await store.flush();
    store.pruneMacs(["b"]);
    expect([...files.keys()].every((k) => k.startsWith("b/"))).toBe(true);
  });

  it("turned off: everything goes and nothing more is written or read", async () => {
    const { fs, files } = memFs();
    const { t } = fakeTimers();
    const store = new OfflineStore(fs, t);
    store.saveProjects("a", view([sess("x")]));
    await store.flush();
    store.setEnabled(false);
    expect(files.size).toBe(0);
    store.saveChat("a", sessionKey("x"), items(1));
    await store.flush();
    expect(files.size).toBe(0);
    expect(await store.loadProjects("a")).toBeNull();
    store.setEnabled(true);
    store.saveProjects("a", view([sess("x")]));
    await store.flush();
    expect((await store.loadProjects("a"))?.view.projects[0].sessions[0].id).toBe("x");
    expect(store.bytes()).toBeGreaterThan(0);
  });
});
