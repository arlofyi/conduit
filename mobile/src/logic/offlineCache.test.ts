import type { WireProjectsView, WireViewSession } from "../bridge/protocol";
import type { ChatItem } from "../data/types";
import {
  boundFeed,
  cacheableView,
  CACHED_EARLIER_ID,
  chatFeedSource,
  chatFile,
  macFolder,
  MAX_INLINE_IMAGE_CHARS,
  mayCacheSession,
  offlineLine,
  parseChat,
  parseIndex,
  parseProjects,
  parseRootChats,
  serializeChat,
  serializeProjects,
  serializeRootChats,
  sessionKey,
  slimItem,
  staleKeys,
  touchIndex,
} from "./offlineCache";

const bubbles = (n: number, from = 0): ChatItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "bubble", id: `b${from + i}`, role: "assistant", text: `msg ${from + i}` }));

function sess(id: string, over: Partial<WireViewSession> = {}): WireViewSession {
  return {
    id,
    name: id,
    agent: "claude",
    branch: null,
    model: null,
    stopped: false,
    running: false,
    silo: false,
    status: "idle",
    activity: null,
    updatedAt: null,
    needs: null,
    lastMessage: null,
    ...over,
  };
}

const view = (sessions: WireViewSession[]): WireProjectsView => ({
  profiles: [{ id: null, name: "Default" }],
  activeProfileId: null,
  projects: [{ id: "p1", name: "Proj", profileId: null, color: null, sessions }],
});

describe("feed bounding", () => {
  it("keeps a short feed as it is", () => {
    const f = bubbles(5);
    expect(boundFeed(f, 10)).toEqual(f);
  });

  it("keeps the newest items behind one 'earlier' divider", () => {
    const out = boundFeed(bubbles(20), 6);
    expect(out).toHaveLength(6);
    expect(out[0]).toMatchObject({ kind: "divider", id: CACHED_EARLIER_ID });
    expect(out.slice(1).map((i) => i.id)).toEqual(["b15", "b16", "b17", "b18", "b19"]);
  });

  it("never stacks dividers (a live feed already capped)", () => {
    const capped = boundFeed(bubbles(20), 6);
    const again = boundFeed([...capped, ...bubbles(2, 20)], 6);
    expect(again.filter((i) => i.id === CACHED_EARLIER_ID)).toHaveLength(1);
    expect(again.at(-1)?.id).toBe("b21");
  });

  it("shrinks oldest-first until the chat fits its byte cap", () => {
    const big: ChatItem[] = Array.from({ length: 40 }, (_, i) => ({ kind: "bubble", id: `x${i}`, role: "user", text: "y".repeat(1000) }));
    const out = boundFeed(big, 500, 10_000);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(10_000);
    expect(out[0].id).toBe(CACHED_EARLIER_ID);
    expect(out.at(-1)?.id).toBe("x39");
  });

  it("replaces a large inline image with a placeholder, keeps a small one", () => {
    const large: ChatItem = { kind: "image", id: "i1", mediaType: "image/png", data: "A".repeat(MAX_INLINE_IMAGE_CHARS + 1) };
    const small: ChatItem = { kind: "image", id: "i2", mediaType: "image/png", data: "AAAA" };
    expect(slimItem(large)).toEqual({ kind: "image", id: "i1", mediaType: "image/png", data: null });
    expect(slimItem(small)).toBe(small);
    const stored = parseChat(serializeChat(sessionKey("s1"), [large, small], 5));
    expect(stored?.items).toEqual([{ ...large, data: null }, small]);
  });
});

describe("serialization", () => {
  it("round-trips a chat", () => {
    const items = bubbles(3);
    const c = parseChat(serializeChat(sessionKey("abc"), items, 1234));
    expect(c).toEqual({ v: 1, key: "s:abc", savedAt: 1234, items });
  });

  it("round-trips the projects view and the chats list", () => {
    const v = view([sess("a"), sess("b", { status: "running" })]);
    expect(parseProjects(serializeProjects(v, 9))).toEqual({ v: 1, savedAt: 9, view: v });
    const chats = parseRootChats(serializeRootChats([{ id: "r1", title: "Hi", profileId: null, scope: null, createdAt: 3, running: false }], 7));
    expect(chats?.savedAt).toBe(7);
    expect(chats?.chats.map((c) => c.id)).toEqual(["r1"]);
  });

  it("reads anything unreadable as nothing", () => {
    for (const raw of [null, "", "{", "[]", '{"v":2,"savedAt":1,"items":[]}', '{"v":1,"key":"zz","savedAt":1,"items":[]}']) {
      expect(parseChat(raw)).toBeNull();
    }
    expect(parseProjects('{"v":1,"savedAt":1,"view":{"projects":"nope"}}')).toBeNull();
    expect(parseIndex("garbage")).toEqual({ v: 1, chats: {} });
  });

  it("drops malformed items rather than the whole chat", () => {
    const raw = JSON.stringify({ v: 1, key: "r:c1", savedAt: 1, items: [{ kind: "bubble", id: "ok", role: "user", text: "t" }, { kind: "evil" }, null, 4] });
    expect(parseChat(raw)?.items.map((i) => i.id)).toEqual(["ok"]);
  });

  it("makes safe folder and file names", () => {
    expect(macFolder("../../etc")).toBe("______etc");
    expect(chatFile("s:a/b\\c")).toBe("s-a_b_c.json");
    expect(macFolder("")).toBe("computer");
  });
});

describe("private sessions are never stored", () => {
  const v = view([sess("open"), sess("secret", { silo: true, name: "Secret project" })]);

  it("leaves them out of the stored list entirely", () => {
    expect(cacheableView(v).projects[0].sessions.map((s) => s.id)).toEqual(["open"]);
    expect(serializeProjects(v, 1)).not.toContain("secret");
    expect(serializeProjects(v, 1)).not.toContain("Secret project");
  });

  it("strips them again when reading an older file", () => {
    const raw = JSON.stringify({ v: 1, savedAt: 1, view: v });
    expect(parseProjects(raw)?.view.projects[0].sessions.map((s) => s.id)).toEqual(["open"]);
  });

  it("only stores a chat the phone can vouch for", () => {
    expect(mayCacheSession(v, "open")).toBe(true);
    expect(mayCacheSession(v, "secret")).toBe(false);
    expect(mayCacheSession(v, "unknown")).toBe(false);
    expect(mayCacheSession(null, "open")).toBe(false);
  });

  it("marks a chat that turned private (or was deleted) stale", () => {
    const idx = { v: 1, chats: { "s:open": { savedAt: 1, bytes: 1 }, "s:secret": { savedAt: 1, bytes: 1 }, "r:c1": { savedAt: 1, bytes: 1 } } };
    expect(staleKeys(idx, "s", new Set(["open"]))).toEqual(["s:secret"]);
    expect(staleKeys(idx, "r", new Set())).toEqual(["r:c1"]);
  });
});

describe("eviction", () => {
  const idx = (n: number, bytes = 10) => ({
    v: 1,
    chats: Object.fromEntries(Array.from({ length: n }, (_, i) => [`s:${i}`, { savedAt: i, bytes }])),
  });

  it("evicts the least recently saved chats past the count", () => {
    const r = touchIndex(idx(3), "s:new", { savedAt: 100, bytes: 10 }, 3, 1e9);
    expect(r.evict).toEqual(["s:0"]);
    expect(Object.keys(r.index.chats).sort()).toEqual(["s:1", "s:2", "s:new"]);
  });

  it("evicts past the byte cap, never the chat just written", () => {
    const r = touchIndex(idx(3, 40), "s:new", { savedAt: 100, bytes: 90 }, 50, 100);
    expect(r.evict).toEqual(["s:0", "s:1", "s:2"]);
    expect(Object.keys(r.index.chats)).toEqual(["s:new"]);
  });

  it("re-saving a chat refreshes it rather than adding one", () => {
    const r = touchIndex(idx(3), "s:0", { savedAt: 100, bytes: 10 }, 3, 1e9);
    expect(r.evict).toEqual([]);
    expect(r.index.chats["s:0"].savedAt).toBe(100);
  });

  it("removing an entry evicts nothing", () => {
    const r = touchIndex(idx(2), "s:1", null);
    expect(r.evict).toEqual([]);
    expect(Object.keys(r.index.chats)).toEqual(["s:0"]);
  });
});

describe("offline and online: which copy is shown", () => {
  const cached = { items: bubbles(2), savedAt: 50 };

  it("shows the saved copy until the computer's history arrives", () => {
    expect(chatFeedSource(false, cached)).toEqual({ from: "cache", items: cached.items, savedAt: 50 });
  });

  it("the computer's history wins outright once it has arrived", () => {
    expect(chatFeedSource(true, cached)).toEqual({ from: "live" });
  });

  it("with nothing saved, the live (maybe empty) feed shows", () => {
    expect(chatFeedSource(false, null)).toEqual({ from: "live" });
  });
});

describe("offline line", () => {
  const NOW = new Date(2026, 10, 1, 16, 0).getTime();
  const base = { ready: false, reason: false, statusText: "Connecting to Studio…", savedAt: null, lastSeen: null, macName: "Studio", firstTry: false, now: NOW };

  it("is null while connected", () => {
    expect(offlineLine({ ...base, ready: true, savedAt: 1 })).toBeNull();
  });

  it("names when the saved copy was saved", () => {
    const at = new Date(2026, 10, 1, 14, 5).getTime();
    expect(offlineLine({ ...base, savedAt: at })).toBe("Offline · showing what was saved at 2:05 PM");
    expect(offlineLine({ ...base, savedAt: at, firstTry: true })).toBe("Connecting · showing what was saved at 2:05 PM");
    const yesterday = new Date(2026, 9, 31, 9, 30).getTime();
    expect(offlineLine({ ...base, savedAt: yesterday })).toBe("Offline · showing what was saved at Oct 31, 9:30 AM");
  });

  it("a reason from the computer wins", () => {
    expect(offlineLine({ ...base, reason: true, statusText: "Update Conduit on Studio", savedAt: 1 })).toBe("Update Conduit on Studio");
  });

  it("a drop this run says when it was last seen", () => {
    expect(offlineLine({ ...base, lastSeen: NOW - 5 * 60_000 })).toBe("Studio offline · last seen 5 min ago");
  });
});
