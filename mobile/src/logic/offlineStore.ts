/**
 * The phone's saved copy of each paired computer, one folder per computer:
 *
 *   <root>/<macFolder>/projects.json     the last projects list (private sessions left out)
 *   <root>/<macFolder>/rootchats.json    the general chats list
 *   <root>/<macFolder>/index.json        every saved chat: when, how big (for LRU + the size)
 *   <root>/<macFolder>/s-<id>.json       one session chat's feed (newest 500 items)
 *   <root>/<macFolder>/r-<id>.json       one general chat's feed
 *
 * Writes are DEFERRED: a save only marks the data dirty, and the files are written later, off the
 * render path. When depends on what it is, because a streaming turn re-saves its chat on every
 * frame and each write rewrites the whole file (up to 1 MB):
 *
 * - an OPEN, live chat (the one on screen): when it closes, when its turn ends, when the app goes
 *   to the background or the link drops (`flushChat` / `flush`, called by LiveProvider), and at
 *   least every `OPEN_CHAT_MAX_WAIT_MS` as a safety net. No 15 s max-wait while it streams.
 * - any other chat: once quiet for `debounceMs`, at most `maxWaitMs` after the first change.
 * - the projects and general-chats lists: on background / disconnect, and otherwise at most once
 *   per `LIST_MIN_INTERVAL_MS` (they change with every poll, and only the latest copy matters).
 *
 * A chat whose newest item and length are what was last written is not written again. The file
 * system is injected (data/offlineFs.ts on the phone, a Map under jest).
 */
import type { WireProjectsView, WireRootChat } from "../bridge/protocol";
import type { ChatItem } from "../data/types";
import {
  cacheableSessionIds,
  chatFile,
  EMPTY_INDEX,
  feedSignature,
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
  utf8Bytes,
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
/** The open chat's safety net: written at least this often while it streams. */
export const OPEN_CHAT_MAX_WAIT_MS = 60_000;
/** The projects / general-chats lists, outside background and disconnect: at most this often. */
export const LIST_MIN_INTERVAL_MS = 5 * 60_000;

export interface StoreTiming {
  debounceMs: number;
  maxWaitMs: number;
  openChatMaxWaitMs: number;
  listMinIntervalMs: number;
}

const DEFAULT_TIMING: StoreTiming = {
  debounceMs: SAVE_DEBOUNCE_MS,
  maxWaitMs: SAVE_MAX_WAIT_MS,
  openChatMaxWaitMs: OPEN_CHAT_MAX_WAIT_MS,
  listMinIntervalMs: LIST_MIN_INTERVAL_MS,
};

type Job =
  | { k: "projects"; view: WireProjectsView }
  | { k: "rootchats"; chats: WireRootChat[] }
  | { k: "chat"; key: ChatKey; items: ChatItem[] }
  | { k: "drop"; key: ChatKey };

interface Pending {
  job: Job;
  /** when this job id first became dirty (since its last write) */
  firstAt: number;
  /** when it is due to be written */
  dueAt: number;
}

export class OfflineStore {
  private enabled = true;
  /** pending writes per computer folder, by job id (a newer save of the same thing replaces it) */
  private pending = new Map<string, Map<string, Pending>>();
  private indexes = new Map<string, CacheIndex>();
  private timer: unknown = null;
  private timerAt: number | null = null;
  /** serializes flushes (a flush awaits index reads) */
  private chain: Promise<void> = Promise.resolve();
  /** per folder: bumps when the folder is removed, so a flush already under way for it writes
   * nothing back. Other folders' flushes carry on. */
  private gens = new Map<string, number>();
  /** folders a flush has taken jobs for and not finished writing (count of passes) */
  private inflight = new Map<string, number>();
  /** the open chats per folder (a session chat and a general chat may both be): written on close
   * / turn end, not on the debounce */
  private open = new Map<string, Set<ChatKey>>();
  /** per folder + chat key: the feed signature last written (or pending) */
  private written = new Map<string, string>();
  /** per folder + list ("projects" / "rootchats"): when it was last written */
  private listWrittenAt = new Map<string, number>();
  private readonly timing: StoreTiming;

  constructor(
    private readonly fs: CacheFs,
    private readonly t: StoreTimers = realTimers,
    timing: Partial<StoreTiming> = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  private gen(dir: string): number {
    return this.gens.get(dir) ?? 0;
  }

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
    const job = this.pending.get(macFolder(deviceId))?.get(`chat:${key}`)?.job;
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

  /** Save a chat's feed. A feed whose newest item and length match the last write is skipped. */
  saveChat(deviceId: string, key: ChatKey, items: ChatItem[]): void {
    if (items.length === 0 || !this.enabled) return;
    const dir = macFolder(deviceId);
    const jobs = this.pending.get(dir);
    const hadDrop = jobs?.delete(`drop:${key}`) ?? false;
    const sig = feedSignature(items);
    if (!hadDrop && !jobs?.has(`chat:${key}`) && this.written.get(`${dir}/${key}`) === sig) return;
    this.queue(deviceId, `chat:${key}`, { k: "chat", key, items });
  }

  /** Remove one chat (it became private, or the computer refused it). */
  dropChat(deviceId: string, key: ChatKey): void {
    const dir = macFolder(deviceId);
    this.pending.get(dir)?.delete(`chat:${key}`);
    this.written.delete(`${dir}/${key}`);
    this.queue(deviceId, `drop:${key}`, { k: "drop", key });
  }

  /**
   * A chat opened on screen. It streams, so it is written when it closes (`closeChat`) or its
   * turn ends (`flushChat`), on background / disconnect (`flush`), and at the safety max-wait --
   * not on every debounce.
   */
  openChat(deviceId: string, key: ChatKey): void {
    const dir = macFolder(deviceId);
    let set = this.open.get(dir);
    if (!set) {
      set = new Set();
      this.open.set(dir, set);
    }
    set.add(key);
  }

  /** The chat left the screen: what it had pending is written now. */
  closeChat(deviceId: string, key: ChatKey): Promise<void> {
    const dir = macFolder(deviceId);
    const set = this.open.get(dir);
    if (set?.delete(key) && set.size === 0) this.open.delete(dir);
    return this.flushChat(deviceId, key);
  }

  private dueAt(dir: string, id: string, firstAt: number, now: number): number {
    const { debounceMs, maxWaitMs, openChatMaxWaitMs, listMinIntervalMs } = this.timing;
    const debounced = Math.min(now + debounceMs, firstAt + maxWaitMs);
    if (id === "projects" || id === "rootchats") {
      const last = this.listWrittenAt.get(`${dir}/${id}`);
      return last === undefined ? debounced : Math.max(debounced, last + listMinIntervalMs);
    }
    if (id.startsWith("chat:") && this.open.get(dir)?.has(id.slice(5) as ChatKey)) return firstAt + openChatMaxWaitMs;
    return debounced;
  }

  private queue(deviceId: string, id: string, job: Job): void {
    if (!this.enabled) return;
    const dir = macFolder(deviceId);
    let jobs = this.pending.get(dir);
    if (!jobs) {
      jobs = new Map();
      this.pending.set(dir, jobs);
    }
    const now = this.t.now();
    const firstAt = jobs.get(id)?.firstAt ?? now;
    jobs.set(id, { job, firstAt, dueAt: this.dueAt(dir, id, firstAt, now) });
    if (job.k === "chat") this.written.set(`${dir}/${job.key}`, feedSignature(job.items));
    this.arm();
  }

  /** One timer, for the earliest due job. */
  private arm(): void {
    let at: number | null = null;
    for (const jobs of this.pending.values()) for (const p of jobs.values()) if (at === null || p.dueAt < at) at = p.dueAt;
    if (at === this.timerAt) return;
    if (this.timer !== null) this.t.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = at;
    if (at === null) return;
    this.timer = this.t.setTimeout(() => {
      this.timer = null;
      this.timerAt = null;
      void this.flushDue();
    }, Math.max(0, at - this.t.now()));
  }

  /** Write everything pending now (the app going to the background, the link dropping). */
  flush(): Promise<void> {
    return this.take(() => true);
  }

  /** Write one chat now, if it has a write pending (it closed, or its turn ended). */
  flushChat(deviceId: string, key: ChatKey): Promise<void> {
    const dir = macFolder(deviceId);
    return this.take((d, id) => d === dir && (id === `chat:${key}` || id === `drop:${key}`));
  }

  private flushDue(): Promise<void> {
    const now = this.t.now();
    return this.take((_d, _id, p) => p.dueAt <= now);
  }

  /** Move the pending jobs `pick` chooses into one write pass (serialized after earlier ones). */
  private take(pick: (dir: string, id: string, p: Pending) => boolean): Promise<void> {
    const work = new Map<string, { jobs: Job[]; gen: number }>();
    for (const [dir, jobs] of this.pending) {
      const taken: Job[] = [];
      for (const [id, p] of jobs) {
        if (!pick(dir, id, p)) continue;
        taken.push(p.job);
        jobs.delete(id);
      }
      if (jobs.size === 0) this.pending.delete(dir);
      if (taken.length > 0) {
        work.set(dir, { jobs: taken, gen: this.gen(dir) });
        this.inflight.set(dir, (this.inflight.get(dir) ?? 0) + 1);
      }
    }
    this.arm();
    if (work.size === 0) return this.chain;
    this.chain = this.chain.then(async () => {
      for (const [dir, w] of work) {
        try {
          await this.writeJobs(dir, w.jobs, w.gen);
        } catch {
          // A full disk or an unwritable folder costs the saved copy, never the app.
        } finally {
          const n = (this.inflight.get(dir) ?? 1) - 1;
          if (n > 0) this.inflight.set(dir, n);
          else this.inflight.delete(dir);
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

  private async writeJobs(dir: string, jobs: Job[], gen: number): Promise<void> {
    const live = () => this.enabled && this.gen(dir) === gen;
    if (!live()) return;
    let idx = await this.index(dir);
    const now = this.t.now();
    let indexDirty = false;
    for (const job of jobs) {
      if (!live()) return;
      if (job.k === "projects") {
        this.fs.write(`${dir}/projects.json`, serializeProjects(job.view, now));
        this.listWrittenAt.set(`${dir}/projects`, now);
        // Sessions the computer no longer lists, or that turned private, lose their saved chat.
        const stale = staleKeys(idx, "s", cacheableSessionIds(job.view));
        for (const k of stale) {
          idx = touchIndex(idx, k, null).index;
          indexDirty = true;
        }
        this.removeKeys(dir, stale);
      } else if (job.k === "rootchats") {
        this.fs.write(`${dir}/rootchats.json`, serializeRootChats(job.chats, now));
        this.listWrittenAt.set(`${dir}/rootchats`, now);
        const stale = staleKeys(idx, "r", new Set(job.chats.map((c) => c.id)));
        for (const k of stale) {
          idx = touchIndex(idx, k, null).index;
          indexDirty = true;
        }
        this.removeKeys(dir, stale);
      } else if (job.k === "chat") {
        const text = serializeChat(job.key, job.items, now);
        this.fs.write(`${dir}/${chatFile(job.key)}`, text);
        const r = touchIndex(idx, job.key, { savedAt: now, bytes: utf8Bytes(text) });
        idx = r.index;
        this.removeKeys(dir, r.evict);
        for (const k of r.evict) this.written.delete(`${dir}/${k}`);
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

  /** Drop everything about one folder, on disk and in memory. True when there was anything to
   * drop -- only then is its generation bumped (aborting a flush under way for THAT folder). */
  private removeFolder(dir: string, onDisk: boolean): boolean {
    const had = onDisk || this.pending.has(dir) || this.inflight.has(dir) || this.indexes.has(dir);
    this.pending.delete(dir);
    this.indexes.delete(dir);
    this.open.delete(dir);
    for (const k of [...this.written.keys()]) if (k.startsWith(`${dir}/`)) this.written.delete(k);
    for (const k of [...this.listWrittenAt.keys()]) if (k.startsWith(`${dir}/`)) this.listWrittenAt.delete(k);
    if (!had) return false;
    this.gens.set(dir, this.gen(dir) + 1);
    if (onDisk) {
      try {
        this.fs.removeDir(dir);
      } catch {
        // leave it for next time
      }
    }
    return true;
  }

  private diskDirs(): string[] {
    try {
      return this.fs.listDirs();
    } catch {
      return [];
    }
  }

  /** Forget one computer's saved copy (the phone forgot it, or the computer revoked it). */
  clearMac(deviceId: string): void {
    const dir = macFolder(deviceId);
    this.removeFolder(dir, this.diskDirs().includes(dir));
    this.arm();
  }

  /** Remove the folders of computers this phone is no longer paired with. */
  pruneMacs(keepDeviceIds: readonly string[]): void {
    const keep = new Set(keepDeviceIds.map(macFolder));
    const onDisk = new Set(this.diskDirs());
    const known = new Set([...onDisk, ...this.pending.keys(), ...this.inflight.keys(), ...this.indexes.keys()]);
    for (const d of known) if (!keep.has(d)) this.removeFolder(d, onDisk.has(d));
    this.arm();
  }

  clearAll(): void {
    const onDisk = new Set(this.diskDirs());
    const known = new Set([...onDisk, ...this.pending.keys(), ...this.inflight.keys(), ...this.indexes.keys()]);
    for (const d of known) this.removeFolder(d, onDisk.has(d));
    this.arm();
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
