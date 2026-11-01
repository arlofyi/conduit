/**
 * What the phone keeps of a computer for offline reading: the last projects list, the general
 * chats list, and each opened chat's feed (session chats and general chats). Pure rules only:
 * what is kept, how it is bounded, how it is read back, and which copy wins once the computer
 * answers again. The files themselves are written by logic/offlineStore.ts.
 *
 * Two rules matter more than the rest:
 * - A private (silo / local-only) session is NEVER stored: not its feed, not even its row.
 * - The computer always wins: a `history` frame replaces a cached feed outright, never merges.
 */
import type { WireProjectsView, WireRootChat } from "../bridge/protocol";
import type { ChatItem, ImageItem } from "../data/types";
import { FEED_CAP_ID } from "./feed";
import { offlineText } from "./chatList";
import { chatOf } from "./general";
import { formatTime } from "./time";

export const CACHE_VERSION = 1;

/** Newest items kept per chat. */
export const MAX_ITEMS_PER_CHAT = 500;
/** Chats kept per computer (session chats + general chats), least recently saved evicted first. */
export const MAX_CHATS = 50;
/** One chat's file, serialized. A chat over it keeps fewer (newer) items. */
export const MAX_CHAT_BYTES = 1024 * 1024;
/** Every chat file of one computer together. */
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
/** An inline image at most this long (base64 chars) is kept; a larger one becomes a placeholder. */
export const MAX_INLINE_IMAGE_CHARS = 8 * 1024;

export const CACHED_EARLIER_ID = FEED_CAP_ID;
export const CACHED_EARLIER_LABEL = "Earlier messages are on your computer";

export type ChatKey = `s:${string}` | `r:${string}`;
export const sessionKey = (id: string): ChatKey => `s:${id}`;
export const rootKey = (id: string): ChatKey => `r:${id}`;

// ---- privacy ----

/** Private sessions in a view (the desktop's `silo`: private mode or local-only). */
export function privateSessionIds(view: WireProjectsView | null): Set<string> {
  const out = new Set<string>();
  for (const p of view?.projects ?? []) for (const s of p.sessions) if (s.silo) out.add(s.id);
  return out;
}

/** Whether a session's chat may be stored: it must be in the view AND not private. A session
 * the phone cannot vouch for (no view, not listed) is not stored either. */
export function mayCacheSession(view: WireProjectsView | null, sessionId: string): boolean {
  for (const p of view?.projects ?? []) {
    const s = p.sessions.find((x) => x.id === sessionId);
    if (s) return !s.silo;
  }
  return false;
}

/** The view as stored: private sessions are left out entirely. Same object when there are none. */
export function cacheableView(view: WireProjectsView): WireProjectsView {
  if (privateSessionIds(view).size === 0) return view;
  return { ...view, projects: view.projects.map((p) => ({ ...p, sessions: p.sessions.filter((s) => !s.silo) })) };
}

// ---- feed bounding ----

/** An item as stored: a large inline image keeps its place but not its bytes. */
export function slimItem(item: ChatItem): ChatItem {
  if (item.kind !== "image" || item.data === null || item.data.length <= MAX_INLINE_IMAGE_CHARS) return item;
  const slim: ImageItem = { ...item, data: null };
  return slim;
}

const earlier = (): ChatItem => ({ kind: "divider", id: CACHED_EARLIER_ID, label: CACHED_EARLIER_LABEL, tone: "info" });

/**
 * The newest `maxItems` items, slimmed, led by an "earlier messages" divider when anything was
 * dropped, and shrunk further (oldest first) until it serializes under `maxBytes`.
 */
export function boundFeed(feed: readonly ChatItem[], maxItems = MAX_ITEMS_PER_CHAT, maxBytes = MAX_CHAT_BYTES): ChatItem[] {
  return boundFeedJson(feed, maxItems, maxBytes).items;
}

/** `boundFeed`, plus the items' JSON it measured on the way -- so a write serializes the feed
 * once, not twice (a 1 MB chat stringified again on every save was most of the cost). */
export function boundFeedJson(
  feed: readonly ChatItem[],
  maxItems = MAX_ITEMS_PER_CHAT,
  maxBytes = MAX_CHAT_BYTES,
): { items: ChatItem[]; json: string } {
  const rest = feed[0]?.id === CACHED_EARLIER_ID ? feed.slice(1) : feed.slice();
  let dropped = rest.length < feed.length;
  let keep = rest.map(slimItem);
  if (keep.length > maxItems - 1 && (dropped || keep.length > maxItems)) {
    keep = keep.slice(keep.length - (maxItems - 1));
    dropped = true;
  }
  let out = dropped ? [earlier(), ...keep] : keep;
  let json = JSON.stringify(out);
  while (out.length > 1 && json.length > maxBytes) {
    const body = out[0]?.id === CACHED_EARLIER_ID ? out.slice(1) : out;
    const half = body.slice(Math.ceil(body.length / 2));
    out = [earlier(), ...half];
    json = JSON.stringify(out);
    if (half.length === 0) break;
  }
  return { items: out, json };
}

/** A string's size in UTF-8 bytes (what it takes on disk), without allocating an encoding. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4; // a surrogate pair: one 4-byte code point
      i++;
    } else n += 3;
  }
  return n;
}

// ---- files ----

export interface CachedProjects {
  v: number;
  savedAt: number;
  view: WireProjectsView;
}

export interface CachedRootChats {
  v: number;
  savedAt: number;
  chats: WireRootChat[];
}

export interface CachedChat {
  v: number;
  key: ChatKey;
  savedAt: number;
  items: ChatItem[];
}

export interface IndexEntry {
  savedAt: number;
  bytes: number;
}

export interface CacheIndex {
  v: number;
  chats: Record<string, IndexEntry>;
}

export const EMPTY_INDEX: CacheIndex = { v: CACHE_VERSION, chats: {} };

function parseObj(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const r = o as Record<string, unknown>;
    return r.v === CACHE_VERSION ? r : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A stored projects file, or null for anything unreadable. Private sessions are dropped again
 * on the way in, so a file written by an older build cannot leak one. */
export function parseProjects(raw: string | null): CachedProjects | null {
  const r = parseObj(raw);
  const savedAt = num(r?.savedAt);
  const view = r?.view as WireProjectsView | undefined;
  if (!r || savedAt === null || !view || !Array.isArray(view.projects) || !Array.isArray(view.profiles)) return null;
  const ok = view.projects.every((p) => p && typeof p.id === "string" && Array.isArray(p.sessions));
  return ok ? { v: CACHE_VERSION, savedAt, view: cacheableView(view) } : null;
}

export function parseRootChats(raw: string | null): CachedRootChats | null {
  const r = parseObj(raw);
  const savedAt = num(r?.savedAt);
  if (!r || savedAt === null || !Array.isArray(r.chats)) return null;
  return { v: CACHE_VERSION, savedAt, chats: r.chats.map(chatOf).filter((c): c is WireRootChat => c !== null) };
}

const ITEM_KINDS = new Set(["bubble", "event", "result", "todos", "approval", "notice", "divider", "command", "image", "question", "plan"]);

export function parseChat(raw: string | null): CachedChat | null {
  const r = parseObj(raw);
  const savedAt = num(r?.savedAt);
  const key = r?.key;
  if (!r || savedAt === null || typeof key !== "string" || !/^[sr]:/.test(key) || !Array.isArray(r.items)) return null;
  const items = r.items.filter(
    (i): i is ChatItem => !!i && typeof i === "object" && typeof (i as ChatItem).id === "string" && ITEM_KINDS.has((i as ChatItem).kind),
  );
  return { v: CACHE_VERSION, key: key as ChatKey, savedAt, items };
}

export function parseIndex(raw: string | null): CacheIndex {
  const r = parseObj(raw);
  const chats = r?.chats;
  if (!r || !chats || typeof chats !== "object" || Array.isArray(chats)) return EMPTY_INDEX;
  const out: Record<string, IndexEntry> = {};
  for (const [k, e] of Object.entries(chats as Record<string, unknown>)) {
    const o = e as Record<string, unknown> | null;
    const savedAt = num(o?.savedAt);
    const bytes = num(o?.bytes);
    if (/^[sr]:/.test(k) && savedAt !== null && bytes !== null) out[k] = { savedAt, bytes };
  }
  return { v: CACHE_VERSION, chats: out };
}

export const serializeProjects = (view: WireProjectsView, savedAt: number): string =>
  JSON.stringify({ v: CACHE_VERSION, savedAt, view: cacheableView(view) } satisfies CachedProjects);

export const serializeRootChats = (chats: readonly WireRootChat[], savedAt: number): string =>
  JSON.stringify({ v: CACHE_VERSION, savedAt, chats: [...chats] } satisfies CachedRootChats);

/** The same JSON as `JSON.stringify({v, key, savedAt, items: boundFeed(items)})`, with the feed
 * stringified once (boundFeedJson already did it while measuring). */
export function serializeChat(key: ChatKey, items: readonly ChatItem[], savedAt: number): string {
  const head = JSON.stringify({ v: CACHE_VERSION, key, savedAt } satisfies Omit<CachedChat, "items">);
  return `${head.slice(0, -1)},"items":${boundFeedJson(items).json}}`;
}

/** What says a chat changed since it was last written: its newest item and its length. A save
 * with the same signature is skipped (offlineStore). */
export function feedSignature(items: readonly ChatItem[]): string {
  return `${items.length}|${items[items.length - 1]?.id ?? ""}`;
}

// ---- eviction ----

/**
 * The index after one chat was written (`entry` null: removed), and the keys to delete so at most
 * `maxChats` chats and `maxBytes` bytes stay. Least recently saved goes first; the chat just
 * written is never evicted for its own sake.
 */
export function touchIndex(
  index: CacheIndex,
  key: string,
  entry: IndexEntry | null,
  maxChats = MAX_CHATS,
  maxBytes = MAX_TOTAL_BYTES,
): { index: CacheIndex; evict: string[] } {
  const chats = { ...index.chats };
  if (entry) chats[key] = entry;
  else delete chats[key];
  const order = Object.keys(chats)
    .filter((k) => k !== key)
    .sort((a, b) => chats[a].savedAt - chats[b].savedAt);
  let total = Object.values(chats).reduce((n, e) => n + e.bytes, 0);
  let count = Object.keys(chats).length;
  const evict: string[] = [];
  for (const k of order) {
    if (count <= maxChats && total <= maxBytes) break;
    evict.push(k);
    total -= chats[k].bytes;
    count--;
    delete chats[k];
  }
  return { index: { v: CACHE_VERSION, chats }, evict };
}

/** Chats the computer no longer has (deleted sessions or chats) or that became private: their
 * keys, to be removed. `kind` limits the check to one kind of key. */
export function staleKeys(index: CacheIndex, kind: "s" | "r", live: ReadonlySet<string>): string[] {
  return Object.keys(index.chats).filter((k) => k.startsWith(`${kind}:`) && !live.has(k.slice(2)));
}

/** Sessions a view still lists that may be stored (non-private). */
export function cacheableSessionIds(view: WireProjectsView): Set<string> {
  const out = new Set<string>();
  for (const p of view.projects) for (const s of p.sessions) if (!s.silo) out.add(s.id);
  return out;
}

/** A device id as a safe folder name. */
export function macFolder(deviceId: string): string {
  const safe = deviceId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return safe || "computer";
}

/** A chat key as a safe file name. */
export function chatFile(key: string): string {
  return `${key[0]}-${key.slice(2).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}.json`;
}

// ---- offline reading: which copy is shown ----

/**
 * The feed a chat screen shows: the computer's own (`live`) once it has sent one, else the saved
 * copy. History from the computer always wins; a saved copy never fills in around it.
 */
export function chatFeedSource(liveLoaded: boolean, cached: { items: ChatItem[]; savedAt: number } | null | undefined):
  | { from: "live" }
  | { from: "cache"; items: ChatItem[]; savedAt: number } {
  if (liveLoaded || !cached) return { from: "live" };
  return { from: "cache", items: cached.items, savedAt: cached.savedAt };
}

/** "2:05 PM" today, "Oct 30, 2:05 PM" otherwise. */
export function savedAtText(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return formatTime(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${formatTime(ms)}`;
}

/** The offline banner over saved data. */
export function offlineSavedText(savedAt: number, now: number): string {
  return `Offline · showing what was saved at ${savedAtText(savedAt, now)}`;
}

/**
 * The line under a list's top bar while not connected (null when connected). A reason the
 * computer gave (revoked, update needed, access off) wins; otherwise saved data says when it was
 * saved, and a link that dropped this run says when it was last seen. `firstTry` is the first
 * attempt of a launch, which is "connecting", not yet "offline".
 */
export function offlineLine(o: {
  ready: boolean;
  /** a reason other than a plain drop is on the connection */
  reason: boolean;
  statusText: string;
  savedAt: number | null;
  lastSeen: number | null;
  macName: string;
  firstTry: boolean;
  now: number;
}): string | null {
  if (o.ready) return null;
  if (o.reason) return o.statusText;
  if (o.savedAt !== null) {
    const at = savedAtText(o.savedAt, o.now);
    return o.firstTry ? `Connecting · showing what was saved at ${at}` : offlineSavedText(o.savedAt, o.now);
  }
  if (o.lastSeen !== null) return offlineText(o.macName, o.lastSeen, o.now);
  return o.statusText;
}

/** A chat opened offline that this phone never saved. */
export const OFFLINE_NOT_SAVED = "Offline. This chat isn't saved on this phone yet: it will be once you open it while connected.";

/** The hint in a composer that cannot send. */
export const OFFLINE_COMPOSER_HINT = "Offline · reconnect to send";
