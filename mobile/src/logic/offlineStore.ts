/**
 * The phone's saved copy of each paired computer, one folder per computer:
 *
 *   <root>/<macFolder>/projects.json     the last projects list (private sessions left out)
 *   <root>/<macFolder>/rootchats.json    the general chats list
 *   <root>/<macFolder>/index.json        every saved chat: when, how big (for LRU + the size)
 *   <root>/<macFolder>/s-<id>.json       one session chat's feed (newest 500 items)
 *   <root>/<macFolder>/r-<id>.json       one general chat's feed
 *
 * Writes are DEBOUNCED: a save only marks the data dirty, and the files are written once things
 * have been quiet for `debounceMs` (and at most `maxWaitMs` after the first change), off the
 * render path. The file system is injected (data/offlineFs.ts on the phone, a Map under jest).
 */
import type { WireProjectsView, WireRootChat } from "../bridge/protocol";
import type { ChatItem } from "../data/types";
import {
  cacheableSessionIds,
  chatFile,
  EMPTY_INDEX,
  macFolder,
  parseChat,
  parseIndex,
  parseProjects,
  parseRootChats,
  serializeChat,
  serializeProjects,
  serializeRootChats,
  staleKeys,
  touchIndex,
  type CacheIndex,
  type CachedProjects,
  type CachedRootChats,
  type ChatKey,
} from "./offlineCache";

export interface CacheFs {
  /** a file's text, or null when it does not exist / cannot be read */
  read(path: string): Promise<string | null>;
  /** write (create or replace) a file, creating its folder */
  write(path: string, text: string): void;
  remove(path: string): void;
  /** a folder and everything in it */
  removeDir(path: string): void;
  /** the folders directly under the root */
  listDirs(): string[];
  /** bytes used under a folder ("" = the root) */
  size(path: string): number;
}

export interface StoreTimers {
  now: () => number;
  setTimeout: (f: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

const realTimers: StoreTimers = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

export const SAVE_DEBOUNCE_MS = 2500;
export const SAVE_MAX_WAIT_MS = 15_000;

type Job =
  | { k: "projects"; view: WireProjectsView }
  | { k: "rootchats"; chats: WireRootChat[] }
  | { k: "chat"; key: ChatKey; items: ChatItem[] }
  | { k: "drop"; key: ChatKey };

export class OfflineStore {
  private enabled = true;
  /** pending writes per computer folder, by job id (a newer save of the same thing replaces it) */
  private pending = new Map<string, Map<string, Job>>();
  private indexes = new Map<string, CacheIndex>();
  private timer: unknown = null;
  private firstDirtyAt: number | null = null;
  /** serializes flushes (a flush awaits index reads) */
  private chain: Promise<void> = Promise.resolve();
  /** bumps on every clear, so a flush already under way writes nothing back */
  private gen = 0;

  constructor(
    private readonly fs: CacheFs,
    private readonly t: StoreTimers = realTimers,
    private readonly debounceMs = SAVE_DEBOUNCE_MS,
    private readonly maxWaitMs = SAVE_MAX_WAIT_MS,
  ) {}

  /** Turning it off drops every pending write and every saved file. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.clearAll();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  // ---- reads ----

  async loadProjects(deviceId: string): Promise<CachedProjects | null> {
    if (!this.enabled) return null;
    return parseProjects(await this.fs.read(`${macFolder(deviceId)}/projects.json`));
  }

  async loadRootChats(deviceId: string): Promise<CachedRootChats | null> {
    if (!this.enabled) return null;
    return parseRootChats(await this.fs.read(`${macFolder(deviceId)}/rootchats.json`));
  }

  async loadChat(deviceId: string, key: ChatKey): Promise<{ items: ChatItem[]; savedAt: number } | null> {
    if (!this.enabled) return null;
    // A chat with a write still pending reads as that write (it is newer than the file).
    const job = this.pending.get(macFolder(deviceId))?.get(`chat:${key}`);
    if (job?.k === "chat") return { items: job.items, savedAt: this.t.now() };
    if (this.pending.get(macFolder(deviceId))?.has(`drop:${key}`)) return null;
    const c = parseChat(await this.fs.read(`${macFolder(deviceId)}/${chatFile(key)}`));
    return c && c.key === key ? { items: c.items, savedAt: c.savedAt } : null;
  }

  // ---- writes (debounced) ----

  saveProjects(deviceId: string, view: WireProjectsView): void {
    this.queue(deviceId, "projects", { k: "projects", view });
  }

  saveRootChats(deviceId: string, chats: WireRootChat[]): void {
    this.queue(deviceId, "rootchats", { k: "rootchats", chats });
  }

  saveChat(deviceId: string, key: ChatKey, items: ChatItem[]): void {
    if (items.length === 0) return;
    const jobs = this.pending.get(macFolder(deviceId));
    jobs?.delete(`drop:${key}`);
    this.queue(deviceId, `chat:${key}`, { k: "chat", key, items });
  }

  /** Remove one chat (it became private, or the computer refused it). */
  dropChat(deviceId: string, key: ChatKey): void {
    this.pending.get(macFolder(deviceId))?.delete(`chat:${key}`);
    this.queue(deviceId, `drop:${key}`, { k: "drop", key });
  }

  private queue(deviceId: string, id: string, job: Job): void {
    if (!this.enabled) return;
    const dir = macFolder(deviceId);
    let jobs = this.pending.get(dir);
    if (!jobs) {
      jobs = new Map();
      this.pending.set(dir, jobs);
    }
    jobs.set(id, job);
    const now = this.t.now();
    this.firstDirtyAt ??= now;
    if (this.timer !== null) this.t.clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstDirtyAt + this.maxWaitMs - now));
    this.timer = this.t.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  /** Write everything pending now (also called as the app goes to the background). */
  flush(): Promise<void> {
    if (this.timer !== null) this.t.clearTimeout(this.timer);
    this.timer = null;
    this.firstDirtyAt = null;
    const work = this.pending;
    this.pending = new Map();
    const gen = this.gen;
    this.chain = this.chain.then(async () => {
      for (const [dir, jobs] of work) {
        try {
          await this.writeJobs(dir, jobs, gen);
        } catch {
          // A full disk or an unwritable folder costs the saved copy, never the app.
        }
      }
    });
    return this.chain;
  }

  private async index(dir: string): Promise<CacheIndex> {
    const cached = this.indexes.get(dir);
    if (cached) return cached;
    const idx = parseIndex(await this.fs.read(`${dir}/index.json`));
    this.indexes.set(dir, idx);
    return idx;
  }

  private removeKeys(dir: string, keys: string[]) {
    for (const k of keys) {
      try {
        this.fs.remove(`${dir}/${chatFile(k)}`);
      } catch {
        // already gone
      }
    }
  }

  private async writeJobs(dir: string, jobs: Map<string, Job>, gen: number): Promise<void> {
    const live = () => this.enabled && this.gen === gen;
    if (!live()) return;
    let idx = await this.index(dir);
    const now = this.t.now();
    let indexDirty = false;
    for (const job of jobs.values()) {
      if (!live()) return;
      if (job.k === "projects") {
        this.fs.write(`${dir}/projects.json`, serializeProjects(job.view, now));
        // Sessions the computer no longer lists, or that turned private, lose their saved chat.
        const stale = staleKeys(idx, "s", cacheableSessionIds(job.view));
        for (const k of stale) {
          idx = touchIndex(idx, k, null).index;
          indexDirty = true;
        }
        this.removeKeys(dir, stale);
      } else if (job.k === "rootchats") {
        this.fs.write(`${dir}/rootchats.json`, serializeRootChats(job.chats, now));
        const stale = staleKeys(idx, "r", new Set(job.chats.map((c) => c.id)));
        for (const k of stale) {
          idx = touchIndex(idx, k, null).index;
          indexDirty = true;
        }
        this.removeKeys(dir, stale);
      } else if (job.k === "chat") {
        const text = serializeChat(job.key, job.items, now);
        this.fs.write(`${dir}/${chatFile(job.key)}`, text);
        const r = touchIndex(idx, job.key, { savedAt: now, bytes: text.length });
        idx = r.index;
        this.removeKeys(dir, r.evict);
        indexDirty = true;
      } else {
        this.removeKeys(dir, [job.key]);
        if (idx.chats[job.key]) {
          idx = touchIndex(idx, job.key, null).index;
          indexDirty = true;
        }
      }
    }
    this.indexes.set(dir, idx);
    if (indexDirty) this.fs.write(`${dir}/index.json`, JSON.stringify(idx));
  }

  // ---- clearing + size ----

  /** Forget one computer's saved copy (the phone forgot it, or the computer revoked it). */
  clearMac(deviceId: string): void {
    this.gen++;
    const dir = macFolder(deviceId);
    this.pending.delete(dir);
    this.indexes.delete(dir);
    try {
      this.fs.removeDir(dir);
    } catch {
      // nothing saved
    }
  }

  /** Remove the folders of computers this phone is no longer paired with. */
  pruneMacs(keepDeviceIds: readonly string[]): void {
    this.gen++;
    const keep = new Set(keepDeviceIds.map(macFolder));
    for (const d of this.fs.listDirs()) {
      if (keep.has(d)) continue;
      this.indexes.delete(d);
      this.pending.delete(d);
      try {
        this.fs.removeDir(d);
      } catch {
        // leave it for next time
      }
    }
  }

  clearAll(): void {
    this.gen++;
    this.pending = new Map();
    this.indexes = new Map();
    if (this.timer !== null) this.t.clearTimeout(this.timer);
    this.timer = null;
    this.firstDirtyAt = null;
    for (const d of this.fs.listDirs()) {
      try {
        this.fs.removeDir(d);
      } catch {
        // leave it
      }
    }
  }

  /** Bytes the saved copies take on this phone. */
  bytes(): number {
    try {
      return this.fs.size("");
    } catch {
      return 0;
    }
  }

  /** For tests: the in-memory index of one computer. */
  indexOf(deviceId: string): CacheIndex {
    return this.indexes.get(macFolder(deviceId)) ?? EMPTY_INDEX;
  }
}
