import * as Crypto from "expo-crypto";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import { usePrefs } from "../data/PrefsProvider";
import { macStore } from "../data/secureBackend";
import type { ChatItem, ProjectsView, SavedMac, SessionStatus, TodoProgress } from "../data/types";
import { bannerFromPending, bannerFromStatus, bannersFromView, type Banner, type Signals } from "../logic/banner";
import type { ContextInfo } from "../logic/chatHeader";
import { chatUnread, nextUnread } from "../logic/chatList";
import { connErrorText } from "../logic/connCopy";
import { capFeed, genId } from "../logic/feed";
import {
  acceptsFrame,
  frameSession,
  isSpawnError,
  PRIVATE_SESSION,
  refusesOpenChat,
  spawnErrorText,
  trustStallNotice,
} from "../logic/frames";
import { loopbackMac, type PairEndpoint } from "../logic/macs";
import { addressesFor, confirmCode, makeNonce, type QrPayload } from "../logic/pairing";
import { emptyPending, fromWire, pendingReducer, type Mine, type PendingEvent, type PendingState } from "../logic/pending";
import { BridgeClient } from "./BridgeClient";
import { initialConn, lifecycleAction, type ConnError, type ConnState } from "./connection";
import { appendWire, mapHistory, mapProjectsView, sameView, statusPatch, type LivePatch } from "./live";
import { probeLoopback as probeLoopbackWith, type LoopbackFound, type ProbeSocket } from "./probe";
import { answerMsg, approveMsg, discoverMsg, pairMsg, portsMsg, sessionActionMsg, spawnMsg, uploadMsg, type ClientMsg, type WireMac } from "./protocol";
import { parsePortsFrame, type WebPortsView } from "../logic/ports";
import type { ActionResult, SessionAction } from "../logic/selection";
import { chunkBase64, decodedBytes } from "../logic/attachments";
import { Directory, File, Paths } from "expo-file-system";
import {
  baseName,
  cacheName,
  CANCELLED as FS_CANCELLED,
  NOT_CONNECTED as FS_NOT_CONNECTED,
  PRIVATE as FS_PRIVATE,
  TIMEOUT as FS_TIMEOUT,
} from "../logic/files";
import {
  fsAckMsg,
  fsDownloadMsg,
  fsListMsg,
  fsReadMsg,
  fsWriteMsg,
  type ServerMsg,
  type WireFsEntry,
  type WireFsReply,
  type WireFsText,
} from "./protocol";
import { applyFeed, applyToList, chatOf, EMPTY_FEED, FALLBACK_OPTIONS, optionsOf, type FeedEvent, type RootChat, type RootChatOptions, type RootFeed, type Scope } from "../logic/general";
import { rootChatCreateMsg, rootChatHistoryMsg, rootChatOptionsMsg, rootChatScopeMsg, rootChatSendMsg, rootChatSettingsMsg, rootChatsMsg, rootChatStopMsg, type WireRootChatSettings } from "./protocol";

import { sessionOptionsMsg, sessionSetMsg, usageMsg, type SessionSetPatch } from "./protocol";
import { parseSessionOptions, type SessionOptions } from "../logic/sessionOptions";
import { parseUsageFrame, type UsageRow } from "../logic/usage";

/** Simulator/dev build: also try loopback, and offer "This computer (simulator)". */
export const IS_SIMULATOR_OR_DEV = __DEV__;

/**
 * The Mac answers `list` with its whole projects view and pushes nothing in between, so the
 * Chats list asks again on this cadence while connected. The view is built from in-memory
 * state on your computer (no git, no disk), so this is cheap on both ends.
 */
export const LIST_POLL_MS = 10_000;

const sha256Hex = (s: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s, { encoding: Crypto.CryptoEncoding.HEX });

const deviceName = (): string =>
  Platform.OS === "ios" ? (Platform.isPad ? "iPad" : "iPhone") : Platform.OS === "android" ? "Android phone" : "Phone";

const stubMac = (e: PairEndpoint): SavedMac => ({
  deviceId: "pairing",
  token: "",
  macName: e.macName,
  dnsName: e.dnsName,
  ip: e.ip,
  port: e.port,
  pairedAt: 0,
});

export type PairTarget = { kind: "qr"; qr: QrPayload } | { kind: "request"; endpoint: PairEndpoint };

export interface PairingState {
  /** what is being paired (Try again re-sends a request; a QR secret is single-use) */
  target: PairTarget;
  macName: string;
  via: "qr" | "request";
  /** connecting → waiting (pair sent, code shown when known) → done | failed */
  phase: "connecting" | "waiting" | "done" | "failed";
  /** the 4 digits to compare with the Mac; QR path at once, request path after pairPending */
  code: string | null;
  /** user-facing failure sentence */
  error: string | null;
}

export interface HelloInfo {
  macName: string;
  conduitVersion: string;
}

export interface SessionLive {
  feed: ChatItem[];
  status: SessionStatus;
  /** when `status` last came from a hook (or the phone's own Stop); 0 = none since attach */
  statusAt: number;
  activity?: string;
  compacting?: boolean;
  todos?: TodoProgress;
  /** the Mac refused this chat: a private (silo'd / local-only) session */
  refused?: "private";
}

const EMPTY_LIVE: SessionLive = { feed: [], status: "idle", statusAt: 0 };

/** A new-chat request from the phone: the Mac answers `spawned` (or `error`). */
export type SpawnState =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "spawned"; sessionId: string; projectId: string; name: string }
  | { phase: "failed"; message: string };

const SPAWN_TIMEOUT_MS = 12_000;

let localSeq = 0;

export type UploadOutcome = { ok: true; path: string } | { ok: false; error: string };
type UploadStep = { kind: "progress" } | { kind: "result"; outcome: UploadOutcome };
/** A 10 MB file over a slow cellular link still finishes well inside this. */
const NOT_CONNECTED = "Not connected to your computer.";
/** The desktop's refusal for a chunk that does not continue a file it holds (uploads.rs). */
const OUT_OF_ORDER = "The file arrived out of order. Try again.";
/** How long an upload waits for the link to come back after a picker or camera returns. */
const RECONNECT_WAIT_MS = 20_000;
/** Per chunk: a 512 KiB chunk takes ~4 s at 1 Mbit/s. */
const CHUNK_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

// ---- file browser outcomes (see the "file browser" block in the provider) ----
/** `error` is the computer's own word ("confirm", "conflict", "not found"...) or one of
 * logic/files.ts's phone-side ones; `fsErrorText` words it for the reader. */
export type FsListOutcome = { ok: true; path: string; entries: WireFsEntry[]; truncated: number } | { ok: false; error: string };
export type FsReadOutcome = ({ ok: true } & WireFsText) | { ok: false; error: string };
export type FsWriteOutcome = { ok: true; mtimeMs: number; size: number } | { ok: false; error: string };
/** `uri` is a file in this phone's cache, ready for an <Image> or the share sheet. */
export type FsDownloadOutcome = { ok: true; uri: string; name: string; size: number } | { ok: false; error: string };
export interface FsDownloadOptions {
  /** resend after the reader confirmed opening a secret */
  confirm?: boolean;
  onProgress?: (received: number, total: number) => void;
  /** polled at each chunk: true stops the download (the reader left) */
  isCancelled?: () => boolean;
}
type FsFail = { type: "fail"; error: string };
const FS_TIMEOUT_MS = 15_000;
/** Per chunk: ~384 KiB, the same budget uploads use. */
const FS_CHUNK_TIMEOUT_MS = 30_000;
function fsErr(r: WireFsReply | FsFail): string {
  return "error" in r && typeof r.error === "string" ? r.error : "Your computer sent an unexpected answer.";
}

// ---- general chat outcomes (see the "general chat" block in the provider) ----
export type RootCreateOutcome = { ok: true; chat: RootChat } | { ok: false; error: string };
export type RootScopeOutcome = { ok: true; scope: Scope | null } | { ok: false; error: string };
export type RootSettingsOutcome = { ok: true; chat: RootChat | null } | { ok: false; error: string };
/** An older desktop never answers `rootchatoptions`: don't make the new-chat sheet wait long. */
const ROOT_OPTIONS_TIMEOUT_MS = 6_000;
const ROOT_TIMEOUT_MS = 12_000;
const ROOT_NO_ANSWER = "Your computer didn't answer. Check the connection and try again.";

// ---- session controls + usage outcomes (see the "session controls" block in the provider) ----
export type SessionOptionsOutcome = { ok: true; options: SessionOptions } | { ok: false; error: string };
export type SessionSetOutcome = { ok: boolean; note: string | null };
/** The latest `usage` answer and when it arrived (ms). */
export interface UsageState {
  rows: UsageRow[];
  at: number;
}
const CTL_TIMEOUT_MS = 10_000;
/** The desktop serves cached reads only, but there is still no point asking more often. */
export const USAGE_POLL_MS = 60_000;
const CTL_NO_ANSWER = "Your computer didn't answer. Its Conduit may need an update for this.";
const CTL_PRIVATE = "This session is private: change it on your computer.";

export interface LiveValue {
  /** false until the Keychain Mac list has been read; render nothing route-deciding before */
  loaded: boolean;
  /** every paired Mac (incl. loopback "Macs" in dev) */
  macs: SavedMac[];
  /** the Mac the app is connected to; null → the Connect screen */
  currentMac: SavedMac | null;
  /** full connection state of the current Mac's socket */
  conn: ConnState;
  /** the current Mac's last hello */
  hello: HelloInfo | null;
  /** ws:// URL in use while ready, else null */
  address: string | null;
  /** why the app was sent back to Connect (e.g. the Mac revoked this phone) */
  notice: ConnError | null;
  clearNotice: () => void;
  selectMac: (deviceId: string) => Promise<void>;
  /** forget a Mac (default: the current one); forgetting the current one goes to Connect */
  forget: (deviceId?: string) => Promise<void>;
  /** ask the current Mac for Conduit Macs on the same tailnet user; answered in `discovered` */
  discover: () => void;
  discovered: WireMac[] | null;
  /** the current computer's local web apps (Apps tab); null until the first `ports` answer */
  webPorts: WebPortsView | null;
  /** ask the computer for its local web apps now; answered into `webPorts` */
  refreshPorts: () => void;
  pairing: PairingState | null;
  pair: (target: PairTarget) => void;
  cancelPairing: () => void;
  /** Simulator/dev: every Conduit answering on 127.0.0.1:8455..=8474 (never auto-picked) */
  probeLoopback: () => Promise<LoopbackFound[]>;
  addLoopback: (found: LoopbackFound) => Promise<void>;
  /** the current Mac's projects view; kept while offline, null until the first one arrives */
  view: ProjectsView | null;
  /** when `view` last arrived (ms); a pull-to-refresh waits for this to move */
  viewAt: number;
  /** ask the Mac for a fresh view now */
  refreshProjects: () => void;
  /** unread counts per session for the current Mac, in memory only */
  unread: Record<string, number>;
  /** when the current Mac last sent anything before the link dropped (ms), for "last seen" */
  lastSeen: number | null;
  /** live data for the currently-attached session */
  sessionLive: SessionLive;
  /** the attached session's context-window use (Claude only; null until the Mac sends one) */
  context: ContextInfo | null;
  attach: (sessionId: string) => void;
  /** stop streaming into the chat; with an id, only if that session is still the attached one
   * (a chat replaced by another must not detach its successor) */
  detach: (sessionId?: string) => void;
  /** send a prompt to a session (text + Enter) */
  prompt: (sessionId: string, text: string) => void;
  /** Stop the session's current turn (Esc on your computer) and mark it in the open feed */
  interrupt: (sessionId: string) => void;
  /** send prepared frames (quick actions) */
  sendFrames: (frames: ClientMsg[]) => void;
  /** start a new session with its first message; the answer lands in `spawnState` */
  spawn: (projectId: string, text: string, agent: string, name?: string) => void;
  spawnState: SpawnState;
  resetSpawn: () => void;
  /** questions/permissions the current Mac holds for a human, and how each one ended */
  pending: PendingState;
  /** answer a held question; `summary` is what the card confirms */
  answer: (askId: string, answers: Record<string, string>, summary: string) => void;
  /** allow or deny a held permission */
  approve: (id: string, allow: boolean) => void;
  /** send one file into a session's `.conduit-uploads/`; resolves with its path or why not */
  upload: (sessionId: string, name: string, data: string) => Promise<UploadOutcome>;
  /** stop or delete sessions on the computer (the Chats list's selection) */
  sessionAction: (action: SessionAction, sessionIds: string[]) => Promise<ActionResult>;
  /** the file browser: one folder of a session's directory ("" = its root) */
  fsList: (sessionId: string, path: string) => Promise<FsListOutcome>;
  /** a file as text (`confirm` opens a secret the computer flagged) */
  fsRead: (sessionId: string, path: string, confirm?: boolean) => Promise<FsReadOutcome>;
  /** save an edit; `base` is the stat it started from (a newer file is a "conflict") */
  fsWrite: (sessionId: string, path: string, content: string, base: { mtimeMs: number; size: number }) => Promise<FsWriteOutcome>;
  /** copy a file into this phone's cache (one at a time: a new one cancels the last) */
  fsDownload: (sessionId: string, path: string, opts?: FsDownloadOptions) => Promise<FsDownloadOutcome>;
  /** the general chat (the computer's root chat): every chat, null until the first `rootChats` */
  rootChats: RootChat[] | null;
  /** the feed of each general chat opened since connecting, by chat id */
  rootFeeds: Record<string, RootFeed>;
  /** ask for the list again (also subscribes this socket to general-chat events) */
  refreshRootChats: () => void;
  /** load a chat's history and keep its feed live; `closeRootChat` stops re-loading it on reconnect */
  openRootChat: (chatId: string) => void;
  closeRootChat: (chatId: string) => void;
  /** start a chat listed under `profileId`, seeing `scope`, with its agent/model/effort/... */
  createRootChat: (profileId: string | null, scope: Scope | null, settings?: WireRootChatSettings) => Promise<RootCreateOutcome>;
  /** what a chat can be set to on this computer: null until asked, `live: false` from an
   * older desktop that never answered (Claude only) */
  rootChatOptions: RootChatOptions | null;
  /** ask for `rootChatOptions` (again); resolves with what arrived, or null on no answer */
  loadRootChatOptions: () => Promise<RootChatOptions | null>;
  /** change one chat's model/effort/research/MCP servers (only the fields named) */
  setRootChatSettings: (chatId: string, patch: Omit<WireRootChatSettings, "agent">) => Promise<RootSettingsOutcome>;
  /** send one message (shown at once); false = not connected */
  sendRootChat: (chatId: string, text: string) => boolean;
  stopRootChat: (chatId: string) => void;
  /** change which projects a chat sees (`null` = every project) */
  setRootChatScope: (chatId: string, scope: Scope | null) => Promise<RootScopeOutcome>;
  /** the in-app banner on screen, if any */
  // ---- session controls + usage ----
  /** every agent account's usage; null until the first answer (older desktops never answer) */
  usage: UsageState | null;
  /** ask for usage unless asked within USAGE_POLL_MS (`force` skips that) */
  refreshUsage: (force?: boolean) => void;
  sessionOptions: (sessionId: string) => Promise<SessionOptionsOutcome>;
  sessionSet: (sessionId: string, patch: SessionSetPatch) => Promise<SessionSetOutcome>;
  banner: Banner | null;
  dismissBanner: () => void;
}

const Ctx = createContext<LiveValue | null>(null);

function applyPatch(prev: SessionLive, patch: LivePatch): SessionLive {
  return {
    ...prev,
    feed: prev.feed,
    status: patch.status ?? prev.status,
    statusAt: patch.status ? Date.now() : prev.statusAt,
    activity: patch.clearActivity ? undefined : patch.activity ?? prev.activity,
    compacting: patch.compacting ?? prev.compacting,
    todos: patch.todos ?? prev.todos,
  };
}

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [macs, setMacs] = useState<SavedMac[]>([]);
  const [currentMac, setCurrentMac] = useState<SavedMac | null>(null);
  const [conn, setConn] = useState<ConnState>(initialConn);
  /** The live connection state, for async work that must wait for a reconnect. */
  const connRef = useRef(conn);
  connRef.current = conn;
  const [hello, setHello] = useState<HelloInfo | null>(null);
  const [notice, setNotice] = useState<ConnError | null>(null);
  const [discovered, setDiscovered] = useState<WireMac[] | null>(null);
  const [webPorts, setWebPorts] = useState<WebPortsView | null>(null);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [view, setView] = useState<ProjectsView | null>(null);
  const [viewAt, setViewAt] = useState(0);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  /** the last view, for diffing the next one into unread counts */
  const viewRef = useRef<ProjectsView | null>(null);
  /** Session actions waiting for their `sessionActionResult`, by requestId. */
  const actionsRef = useRef(new Map<string, (r: ActionResult) => void>());
  /** The chunk each upload is waiting on an answer for, by requestId. */
  const uploadsRef = useRef(new Map<string, { sessionId: string; step: (s: UploadStep) => void }>());
  /** Uploads run one file at a time, in pick order (see `uploads.rs` on why). */
  const uploadQueue = useRef<Promise<unknown>>(Promise.resolve());
  /** the session your computer is streaming to this socket; outlives `attachedRef` after the chat closes */
  const streamingRef = useRef<string | null>(null);
  /** last frame from the Mac; copied into `lastSeen` only when the link drops (a state per frame
   * would re-render every consumer on each streamed chunk) */
  const lastFrameAt = useRef<number | null>(null);
  const [sessionLive, setSessionLive] = useState<SessionLive>(EMPTY_LIVE);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [spawnState, setSpawnState] = useState<SpawnState>({ phase: "idle" });
  const [pending, setPending] = useState<PendingState>(emptyPending);
  /** the reducer's latest value, read synchronously by answer/approve (a double tap must not send twice) */
  const pendingRef = useRef<PendingState>(emptyPending);
  const dispatchPending = useCallback((ev: PendingEvent) => {
    const next = pendingReducer(pendingRef.current, ev);
    if (next === pendingRef.current) return;
    pendingRef.current = next;
    setPending(next);
  }, []);
  const spawnPending = useRef(false);
  /** the last spawn timed out on the phone; the Mac may still answer it */
  const spawnLate = useRef(false);
  /** each session's last known needs/status, shared by the view and status-frame banner paths */
  const signalsRef = useRef<Signals>({});
  /** read inside socket callbacks, which are created once per Mac */
  const { prefs } = usePrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /** false while the app is in the background: the list poll pauses */
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const clientRef = useRef<BridgeClient | null>(null);
  const attachedRef = useRef<string | null>(null);
  const pairClientRef = useRef<BridgeClient | null>(null);
  /** bumps on every pair()/cancel so a stale attempt's async callbacks are ignored */
  const pairGen = useRef(0);

  // ---- file browser (desktop phone_fs.rs) -- self-contained: refs, router, four calls ----
  /** Each fs request waiting on its answer, by requestId (a download re-registers per chunk). */
  const fsWaitersRef = useRef(new Map<string, { sessionId: string; settle: (m: WireFsReply | FsFail) => void }>());
  /** The download in flight; the computer runs one per socket and a new one replaces it. */
  const fsDownloadRef = useRef<string | null>(null);
  /** Wait for one answer to `requestId`, sending `frame` once the waiter is in place. */
  const fsExchange = useCallback(
    (sessionId: string, requestId: string, frame: ClientMsg | null, ms: number): Promise<WireFsReply | FsFail> =>
      new Promise((resolve) => {
        const finish = (m: WireFsReply | FsFail) => {
          clearTimeout(timer);
          if (fsWaitersRef.current.get(requestId)?.settle === finish) fsWaitersRef.current.delete(requestId);
          resolve(m);
        };
        const timer = setTimeout(() => finish({ type: "fail", error: FS_TIMEOUT }), ms);
        fsWaitersRef.current.set(requestId, { sessionId, settle: finish });
        if (frame && !clientRef.current?.send(frame)) finish({ type: "fail", error: FS_NOT_CONNECTED });
      }),
    [],
  );
  /** Called first for every frame: true when it was an fs answer (consumed). A private-session
   * refusal fails that session's requests now instead of at their timeout. */
  const fsRoute = useCallback((m: ServerMsg): boolean => {
    if (m.type === "error") {
      if (m.message === FS_PRIVATE && m.sessionId) {
        for (const w of [...fsWaitersRef.current.values()]) {
          if (w.sessionId === m.sessionId) w.settle({ type: "fail", error: FS_PRIVATE });
        }
      }
      return false;
    }
    if (m.type !== "fsListResult" && m.type !== "fsReadResult" && m.type !== "fsWriteResult" && m.type !== "fsChunk") return false;
    fsWaitersRef.current.get(m.requestId)?.settle(m);
    return true;
  }, []);
  const fsList = useCallback(
    async (sessionId: string, path: string): Promise<FsListOutcome> => {
      const id = genId("fs");
      const r = await fsExchange(sessionId, id, fsListMsg(sessionId, id, path), FS_TIMEOUT_MS);
      if (r.type !== "fsListResult" || r.error !== undefined) return { ok: false, error: fsErr(r) };
      return { ok: true, path: r.path, entries: r.entries ?? [], truncated: r.truncated ?? 0 };
    },
    [fsExchange],
  );
  const fsRead = useCallback(
    async (sessionId: string, path: string, confirm = false): Promise<FsReadOutcome> => {
      const id = genId("fs");
      const r = await fsExchange(sessionId, id, fsReadMsg(sessionId, id, path, confirm), FS_TIMEOUT_MS);
      if (r.type !== "fsReadResult" || r.error !== undefined) return { ok: false, error: fsErr(r) };
      const { type: _t, requestId: _r, error: _e, ...text } = r;
      return { ok: true, ...text };
    },
    [fsExchange],
  );
  const fsWrite = useCallback(
    async (sessionId: string, path: string, content: string, base: { mtimeMs: number; size: number }): Promise<FsWriteOutcome> => {
      const id = genId("fs");
      const r = await fsExchange(sessionId, id, fsWriteMsg(sessionId, id, path, content, base), FS_TIMEOUT_MS);
      if (r.type !== "fsWriteResult" || r.error !== undefined) return { ok: false, error: fsErr(r) };
      return { ok: true, mtimeMs: r.mtimeMs, size: r.size };
    },
    [fsExchange],
  );
  const fsDownload = useCallback(
    async (sessionId: string, path: string, opts: FsDownloadOptions = {}): Promise<FsDownloadOutcome> => {
      const id = genId("dl");
      // The computer drops the previous download for this one: end its wait now.
      const prev = fsDownloadRef.current;
      if (prev) fsWaitersRef.current.get(prev)?.settle({ type: "fail", error: FS_CANCELLED });
      fsDownloadRef.current = id;
      const dir = new Directory(Paths.cache, "conduit-files", id);
      let file: File | null = null;
      const fail = (error: string): FsDownloadOutcome => {
        try {
          if (dir.exists) dir.delete();
        } catch {
          // the cache is the OS's to clear
        }
        return { ok: false, error };
      };
      let frame: ClientMsg | null = fsDownloadMsg(sessionId, id, path, opts.confirm);
      let received = 0;
      for (let expect = 1; ; expect++) {
        const r = await fsExchange(sessionId, id, frame, FS_CHUNK_TIMEOUT_MS);
        if (r.type !== "fsChunk" || r.error !== undefined) return fail(fsErr(r));
        // A newer download replaced this one on the computer, or the reader left.
        if (fsDownloadRef.current !== id || opts.isCancelled?.()) return fail(FS_CANCELLED);
        if (r.seq !== expect) return fail("The file arrived out of order. Try again.");
        try {
          if (!file) {
            dir.create({ intermediates: true, idempotent: true });
            file = new File(dir, cacheName(r.name || baseName(path)));
            file.create({ overwrite: true });
          }
          if (r.data) file.write(r.data, { encoding: "base64", append: true });
        } catch (e) {
          return fail(`Couldn't save on this phone: ${e instanceof Error ? e.message : String(e)}`);
        }
        received += decodedBytes(r.data);
        opts.onProgress?.(received, r.size);
        if (r.done) {
          if (fsDownloadRef.current === id) fsDownloadRef.current = null;
          return { ok: true, uri: file.uri, name: r.name, size: r.size };
        }
        frame = fsAckMsg(id);
      }
    },
    [fsExchange],
  );
  // ---- end file browser ----

  // ---- general chat (desktop root_chat.rs) -- self-contained: state, router, calls ----
  const [rootChats, setRootChats] = useState<RootChat[] | null>(null);
  const [rootFeeds, setRootFeeds] = useState<Record<string, RootFeed>>({});
  const [rootChatOptions, setRootChatOptions] = useState<RootChatOptions | null>(null);
  /** this socket has sent a rootchat* frame, so the computer pushes events to it; a new
   * socket (reconnect) re-subscribes and re-loads the open chat */
  const rootSubscribedRef = useRef(false);
  const rootOpenRef = useRef<string | null>(null);
  /** answers waited on: `create:<requestId>` and `scope:<chatId>` */
  const rootWaitersRef = useRef(new Map<string, (m: ServerMsg | null) => void>());
  const rootSend = useCallback((frame: ClientMsg): boolean => {
    const ok = !!clientRef.current?.send(frame);
    if (ok) rootSubscribedRef.current = true;
    return ok;
  }, []);
  /** Events reach only chats opened here: a feed built from a turn's tail alone would lie. */
  const patchRootFeed = useCallback((chatId: string, e: FeedEvent) => {
    setRootFeeds((all) => {
      const prev = all[chatId];
      if (!prev && e.t !== "history" && e.t !== "send") return all;
      const next = applyFeed(prev ?? EMPTY_FEED, e);
      return next === prev ? all : { ...all, [chatId]: next };
    });
  }, []);
  const rootWait = useCallback(
    (key: string, frame: ClientMsg, timeoutMs = ROOT_TIMEOUT_MS): Promise<ServerMsg | null> =>
      new Promise((resolve) => {
        const finish = (m: ServerMsg | null) => {
          clearTimeout(timer);
          if (rootWaitersRef.current.get(key) === finish) rootWaitersRef.current.delete(key);
          resolve(m);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        rootWaitersRef.current.set(key, finish);
        if (!rootSend(frame)) finish(null);
      }),
    [rootSend],
  );
  /** Called for every frame: true when it was a general-chat frame (consumed). */
  const rootRoute = useCallback(
    (m: ServerMsg): boolean => {
      switch (m.type) {
        case "rootChats":
          setRootChats((m.chats ?? []).map(chatOf).filter((c): c is RootChat => c !== null));
          return true;
        case "rootChatCreated": {
          const chat = chatOf(m.chat);
          if (chat) setRootChats((list) => [chat, ...(list ?? []).filter((c) => c.id !== chat.id)]);
          rootWaitersRef.current.get(`create:${m.requestId}`)?.(m);
          return true;
        }
        case "rootChatHistory": {
          const running = m.running === true;
          patchRootFeed(m.chatId, { t: "history", items: m.items ?? [], running });
          setRootChats((list) => list?.map((c) => (c.id === m.chatId && c.running !== running ? { ...c, running } : c)) ?? list);
          return true;
        }
        case "rootChatScoped":
          if (m.ok) setRootChats((list) => list?.map((c) => (c.id === m.chatId ? { ...c, scope: m.scope } : c)) ?? list);
          rootWaitersRef.current.get(`scope:${m.chatId}`)?.(m);
          return true;
        case "rootChatSettings": {
          const chat = m.ok ? chatOf(m.chat) : null;
          if (chat) setRootChats((list) => list?.map((c) => (c.id === chat.id ? chat : c)) ?? list);
          rootWaitersRef.current.get(`settings:${m.requestId}`)?.(m);
          return true;
        }
        case "rootChatOptions": {
          const opts = optionsOf(m);
          if (opts) setRootChatOptions(opts);
          rootWaitersRef.current.get(`options:${m.requestId}`)?.(m);
          return true;
        }
        case "rootChatEvent":
          setRootChats((list) => applyToList(list, m));
          patchRootFeed(m.chatId, { t: "event", ev: m });
          // A first message titles a "New Chat" on the computer: re-read the list.
          if (m.event === "done" || m.event === "error") clientRef.current?.send(rootChatsMsg());
          return true;
        default:
          return false;
      }
    },
    [patchRootFeed],
  );
  const refreshRootChats = useCallback(() => {
    rootSend(rootChatsMsg());
  }, [rootSend]);
  const openRootChat = useCallback(
    (chatId: string) => {
      rootOpenRef.current = chatId;
      rootSend(rootChatHistoryMsg(chatId));
    },
    [rootSend],
  );
  const closeRootChat = useCallback((chatId: string) => {
    if (rootOpenRef.current === chatId) rootOpenRef.current = null;
  }, []);
  const createRootChat = useCallback(
    async (profileId: string | null, scope: Scope | null, settings?: WireRootChatSettings): Promise<RootCreateOutcome> => {
      const id = genId("rc");
      const r = await rootWait(`create:${id}`, rootChatCreateMsg(id, profileId, scope, settings));
      if (!r) return { ok: false, error: clientRef.current ? ROOT_NO_ANSWER : NOT_CONNECTED };
      const chat = r.type === "rootChatCreated" ? chatOf(r.chat) : null;
      return chat ? { ok: true, chat } : { ok: false, error: "Your computer sent an unexpected answer." };
    },
    [rootWait],
  );
  const sendRootChat = useCallback(
    (chatId: string, text: string): boolean => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (!rootSend(rootChatSendMsg(chatId, trimmed))) return false;
      patchRootFeed(chatId, { t: "send", text: trimmed });
      return true;
    },
    [rootSend, patchRootFeed],
  );
  const stopRootChat = useCallback(
    (chatId: string) => {
      if (rootSend(rootChatStopMsg(chatId))) patchRootFeed(chatId, { t: "stop" });
    },
    [rootSend, patchRootFeed],
  );
  const setRootChatScope = useCallback(
    async (chatId: string, scope: Scope | null): Promise<RootScopeOutcome> => {
      const r = await rootWait(`scope:${chatId}`, rootChatScopeMsg(chatId, scope));
      if (!r) return { ok: false, error: clientRef.current ? ROOT_NO_ANSWER : NOT_CONNECTED };
      if (r.type !== "rootChatScoped" || !r.ok) return { ok: false, error: "Your computer didn't accept that scope." };
      return { ok: true, scope: r.scope };
    },
    [rootWait],
  );
  const loadRootChatOptions = useCallback(async (): Promise<RootChatOptions | null> => {
    const id = genId("ro");
    const r = await rootWait(`options:${id}`, rootChatOptionsMsg(id), ROOT_OPTIONS_TIMEOUT_MS);
    const opts = r && r.type === "rootChatOptions" ? optionsOf(r) : null;
    // No answer: an older desktop (Claude only). Keep a live answer from earlier if there is one.
    if (!opts) setRootChatOptions((cur) => cur ?? FALLBACK_OPTIONS);
    return opts;
  }, [rootWait]);
  const setRootChatSettings = useCallback(
    async (chatId: string, patch: Omit<WireRootChatSettings, "agent">): Promise<RootSettingsOutcome> => {
      const id = genId("rs");
      const r = await rootWait(`settings:${id}`, rootChatSettingsMsg(chatId, id, patch));
      if (!r) return { ok: false, error: clientRef.current ? ROOT_NO_ANSWER : NOT_CONNECTED };
      if (r.type !== "rootChatSettings" || !r.ok) {
        const note = r.type === "rootChatSettings" && typeof r.note === "string" && r.note ? r.note : null;
        return { ok: false, error: note ?? "Your computer didn't accept those settings." };
      }
      return { ok: true, chat: chatOf(r.chat) };
    },
    [rootWait],
  );
  // ---- end general chat ----

  // ---- session controls + usage (2026-11-01 spec section 2) -- self-contained ----
  const [usage, setUsage] = useState<UsageState | null>(null);
  /** when `usage` was last ASKED for (a send that went out), for the 60 s throttle */
  const usageAskedRef = useRef(0);
  /** answers waited on, by requestId; `sessionId` lets a private refusal fail them at once */
  const ctlWaitersRef = useRef(new Map<string, { sessionId: string | null; settle: (m: ServerMsg | null) => void }>());
  const ctlWait = useCallback(
    (requestId: string, sessionId: string | null, frame: ClientMsg): Promise<ServerMsg | null> =>
      new Promise((resolve) => {
        const finish = (m: ServerMsg | null) => {
          clearTimeout(timer);
          if (ctlWaitersRef.current.get(requestId)?.settle === finish) ctlWaitersRef.current.delete(requestId);
          resolve(m);
        };
        const timer = setTimeout(() => finish(null), CTL_TIMEOUT_MS);
        ctlWaitersRef.current.set(requestId, { sessionId, settle: finish });
        if (!clientRef.current?.send(frame)) finish(null);
      }),
    [],
  );
  /** Called for every frame: true when it was a session-control / usage answer (consumed). */
  const ctlRoute = useCallback((m: ServerMsg): boolean => {
    if (m.type === "error") {
      if (m.message === PRIVATE_SESSION && m.sessionId) {
        for (const w of [...ctlWaitersRef.current.values()]) {
          if (w.sessionId === m.sessionId) w.settle(m);
        }
      }
      return false;
    }
    if (m.type === "usage") {
      const rows = parseUsageFrame(m);
      if (rows) setUsage({ rows, at: Date.now() });
      return true;
    }
    if (m.type === "sessionOptions" || m.type === "sessionSetResult") {
      const id = (m as { requestId?: unknown }).requestId;
      if (typeof id === "string") ctlWaitersRef.current.get(id)?.settle(m);
      return true;
    }
    return false;
  }, []);
  const refreshUsage = useCallback((force = false) => {
    if (!force && Date.now() - usageAskedRef.current < USAGE_POLL_MS) return;
    if (clientRef.current?.send(usageMsg(genId("us")))) usageAskedRef.current = Date.now();
  }, []);
  const sessionOptions = useCallback(
    async (sessionId: string): Promise<SessionOptionsOutcome> => {
      const id = genId("so");
      const r = await ctlWait(id, sessionId, sessionOptionsMsg(sessionId, id));
      if (!r) return { ok: false, error: clientRef.current ? CTL_NO_ANSWER : NOT_CONNECTED };
      if (r.type === "error") return { ok: false, error: CTL_PRIVATE };
      const options = parseSessionOptions(r);
      return options ? { ok: true, options } : { ok: false, error: "Your computer sent an unexpected answer." };
    },
    [ctlWait],
  );
  const sessionSet = useCallback(
    async (sessionId: string, patch: SessionSetPatch): Promise<SessionSetOutcome> => {
      const id = genId("ss");
      const r = await ctlWait(id, sessionId, sessionSetMsg(sessionId, id, patch));
      if (!r) return { ok: false, note: clientRef.current ? CTL_NO_ANSWER : NOT_CONNECTED };
      if (r.type === "error") return { ok: false, note: CTL_PRIVATE };
      if (r.type !== "sessionSetResult") return { ok: false, note: "Your computer sent an unexpected answer." };
      // the name / model / keep-running shown in lists and headers come from the view
      clientRef.current?.list();
      return { ok: r.ok === true, note: typeof r.note === "string" && r.note ? r.note : null };
    },
    [ctlWait],
  );
  // ---- end session controls ----

  const refreshMacs = useCallback(async () => {
    try {
      const list = await macStore.list();
      setMacs(list);
      return list;
    } catch {
      return null; // transient Keychain error: keep what we have
    }
  }, []);

  // Load the paired Macs once; with no current selection, fall back to the first one.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const list = await macStore.list();
        let cur = await macStore.current();
        if (!cur && list.length > 0) {
          cur = list[0];
          await macStore.setCurrent(cur.deviceId).catch(() => undefined);
        }
        if (!live) return;
        setMacs(list);
        setCurrentMac(cur);
      } catch {
        // Keychain unreadable (e.g. before first unlock): start at Connect, delete nothing.
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // One authenticated (or loopback) socket to the current Mac.
  const macKey = currentMac ? `${currentMac.deviceId}|${currentMac.token}` : null;
  useEffect(() => {
    if (!currentMac) {
      setConn(initialConn);
      return;
    }
    const mac = currentMac;
    setHello(null);
    setView(null);
    setViewAt(0);
    setUnread({});
    setLastSeen(null);
    viewRef.current = null;
    signalsRef.current = {};
    setBanner(null);
    setContext(null);
    streamingRef.current = null;
    lastFrameAt.current = null;
    setDiscovered(null);
    setWebPorts(null);
    setRootChats(null);
    setRootFeeds({});
    setUsage(null);
    usageAskedRef.current = 0;
    setRootChatOptions(null);
    rootSubscribedRef.current = false;
    rootOpenRef.current = null;
    pendingRef.current = emptyPending;
    setPending(emptyPending);
    let wasReady = false;
    const client = new BridgeClient(
      { addresses: addressesFor(mac, { simulator: IS_SIMULATOR_OR_DEV }), mac },
      {
        onState: (c) => {
          setConn(c);
          const ready = c.phase === "ready";
          const justReady = ready && !wasReady;
          if (wasReady && !ready) setLastSeen(lastFrameAt.current ?? Date.now());
          wasReady = ready;
          if (justReady) {
            client.list();
            // A new socket streams nothing until attached. Re-attach the open chat (desktop is
            // the source of truth); a chat closed earlier is no longer streamed.
            streamingRef.current = attachedRef.current;
            if (attachedRef.current) {
              setSessionLive(EMPTY_LIVE);
              client.attach(attachedRef.current);
            }
            // General-chat events are per socket: subscribe again, and catch the open chat up.
            if (rootSubscribedRef.current) {
              client.send(rootChatsMsg());
              if (rootOpenRef.current) client.send(rootChatHistoryMsg(rootOpenRef.current));
            }
          }
        },
        onEffect: (e) => {
          if (e.k !== "forgetMac") return;
          // The Mac revoked this phone: forget it and go back to Connect with a message.
          setNotice({ kind: "revoked", macName: mac.macName });
          macStore
            .forget(e.deviceId)
            .catch(() => undefined)
            .then(() => refreshMacs());
          setCurrentMac((cur) => (cur?.deviceId === e.deviceId ? null : cur));
        },
        onMessage: (m) => {
          lastFrameAt.current = Date.now();
          if (fsRoute(m)) return;
          if (rootRoute(m)) return;
          if (ctlRoute(m)) return;
          switch (m.type) {
            case "hello":
              setHello({ macName: m.macName, conduitVersion: m.conduitVersion });
              break;
            case "spawned":
              // A late answer (after the sheet's timeout) still opens the chat it started, so
              // the reader is not tempted into starting a second one.
              if (spawnPending.current || spawnLate.current) {
                spawnPending.current = false;
                spawnLate.current = false;
                setSpawnState({ phase: "spawned", sessionId: m.sessionId, projectId: m.projectId, name: m.name });
                clientRef.current?.list(); // the new session belongs in the list now
              }
              break;
            case "error": {
              // A chat this phone started, stuck on your computer's folder-trust prompt (null otherwise).
              const stall = trustStallNotice(m.message, m.sessionId, attachedRef.current, genId("n"));
              if (m.message === PRIVATE_SESSION && m.sessionId) {
                // A private session takes no files: fail its uploads now, not at the timeout.
                for (const w of [...uploadsRef.current.values()]) {
                  if (w.sessionId !== m.sessionId) continue;
                  w.step({ kind: "result", outcome: { ok: false, error: "This session is private: it can't take files from the phone." } });
                }
              }
              if (m.message === PRIVATE_SESSION) {
                // The Mac refused the chat that is open (at attach, or because it was made
                // private while streaming): say so instead of an empty feed. A refusal for a
                // chat already left is stale and ignored.
                if (refusesOpenChat(m.message, m.sessionId, attachedRef.current)) {
                  setSessionLive({ ...EMPTY_LIVE, refused: "private" });
                }
              } else if (stall) {
                // Say so in that chat rather than leave it reading "working…". The Mac re-sends
                // `history` once Claude does start, which replaces this notice with the real feed.
                setSessionLive((prev) => ({ ...prev, feed: capFeed([...prev.feed, stall]) }));
              } else if (spawnPending.current && isSpawnError(m.message)) {
                // Only the spawn's own errors answer a spawn; anything else is about another request.
                spawnPending.current = false;
                spawnLate.current = false;
                setSpawnState({ phase: "failed", message: spawnErrorText(m.message) });
              }
              break;
            }
            case "ports": {
              const next = parsePortsFrame(m);
              if (next) setWebPorts(next);
              break;
            }
            case "macs":
              setDiscovered(m.macs);
              break;
            case "pending":
              dispatchPending({
                t: "snapshot",
                items: [...(m.asks ?? []), ...(m.permissions ?? [])].map(fromWire),
                now: Date.now(),
              });
              break;
            case "pendingAdded": {
              const item = fromWire(m.item);
              const before = pendingRef.current;
              dispatchPending({ t: "added", item });
              // An item already open here is not new: no second banner.
              if (pendingRef.current === before) break;
              // Banner now, not at the next 10 s poll (same toggles / open-chat / silo rules).
              const b = bannerFromPending(signalsRef.current, viewRef.current, item, attachedRef.current, prefsRef.current);
              signalsRef.current = b.signals;
              if (b.banner) setBanner(b.banner);
              break;
            }
            case "resolved":
              dispatchPending({ t: "resolved", id: m.id, by: m.by, now: Date.now() });
              break;
            case "answerResult":
              dispatchPending({ t: "result", id: m.askId, ok: m.ok, now: Date.now() });
              break;
            case "uploadProgress":
              uploadsRef.current.get(m.requestId)?.step({ kind: "progress" });
              break;
            case "uploadResult":
              uploadsRef.current
                .get(m.requestId)
                ?.step({ kind: "result", outcome: m.ok ? { ok: true, path: m.path } : { ok: false, error: m.error } });
              break;
            case "sessionActionResult": {
              const waiter = actionsRef.current.get(m.requestId);
              if (waiter) {
                actionsRef.current.delete(m.requestId);
                waiter({ ok: true, done: m.done, skipped: m.skipped });
              }
              // The list changes now; do not leave deleted rows up until the next poll.
              clientRef.current?.list();
              break;
            }
            case "approveResult":
              dispatchPending({ t: "result", id: m.id, ok: m.ok, now: Date.now() });
              break;
            case "projects": {
              const prev = viewRef.current;
              const mapped = mapProjectsView(m);
              // a poll that brought nothing new keeps the old reference: nothing re-renders
              const next = sameView(prev, mapped) && prev ? prev : mapped;
              viewRef.current = next;
              const open = attachedRef.current;
              setUnread((u) => nextUnread(u, prev, next, open));
              const b = bannersFromView(signalsRef.current, next, open, prefsRef.current);
              signalsRef.current = b.signals;
              if (b.banners.length > 0) setBanner(b.banners[0]);
              setView(next);
              setViewAt(Date.now());
              break;
            }
            case "context":
              if (m.sessionId === attachedRef.current) setContext({ fraction: m.fraction, model: m.model });
              break;
            case "history":
              // Also re-sent when the Mac follows the session onto a new transcript (/clear).
              if (attachedRef.current && acceptsFrame(m.sessionId, attachedRef.current)) {
                setSessionLive((prev) => ({ ...prev, feed: capFeed(mapHistory(m.items)) }));
              }
              break;
            case "chat": {
              // A tagged frame names its session; an untagged one (older Mac) is the streamed one's.
              const about = frameSession(m.sessionId, streamingRef.current);
              setUnread((u) => chatUnread(u, about, attachedRef.current));
              if (attachedRef.current && acceptsFrame(m.sessionId, attachedRef.current)) {
                setSessionLive((prev) => ({ ...prev, feed: capFeed(appendWire(prev.feed, m.item)) }));
              }
              break;
            }
            case "status": {
              const patch = statusPatch(m.event, m.body as never);
              const streaming = frameSession(m.sessionId, streamingRef.current);
              if (attachedRef.current && acceptsFrame(m.sessionId, attachedRef.current)) {
                setSessionLive((prev) => applyPatch(prev, patch));
              }
              if (patch.status && streaming) {
                const r = bannerFromStatus(
                  signalsRef.current,
                  viewRef.current,
                  streaming,
                  patch.status,
                  attachedRef.current,
                  prefsRef.current,
                );
                signalsRef.current = r.signals;
                if (r.banner) setBanner(r.banner);
              }
              break;
            }
            // size / output / error are not used by the chat UI
          }
        },
      },
    );
    clientRef.current = client;
    return () => {
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
    // macKey captures the Mac's identity + token; the object itself changes on every reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [macKey, refreshMacs]);

  const selectMac = useCallback(
    async (deviceId: string) => {
      const list = (await refreshMacs()) ?? macs;
      const mac = list.find((m) => m.deviceId === deviceId);
      if (!mac) return;
      await macStore.setCurrent(deviceId).catch(() => undefined);
      setNotice(null);
      setCurrentMac(mac);
    },
    [macs, refreshMacs],
  );

  const forget = useCallback(
    async (deviceId?: string) => {
      const id = deviceId ?? currentMac?.deviceId;
      if (!id) return;
      await macStore.forget(id).catch(() => undefined);
      await refreshMacs();
      setCurrentMac((cur) => (cur?.deviceId === id ? null : cur));
    },
    [currentMac, refreshMacs],
  );

  const discover = useCallback(() => {
    clientRef.current?.send(discoverMsg());
  }, []);

  const cancelPairing = useCallback(() => {
    pairGen.current++;
    pairClientRef.current?.close();
    pairClientRef.current = null;
    setPairing(null);
  }, []);

  const pair = useCallback(
    (target: PairTarget) => {
      pairClientRef.current?.close();
      const gen = ++pairGen.current;
      const isCurrent = () => pairGen.current === gen;
      const endpoint: PairEndpoint =
        target.kind === "qr"
          ? { macName: target.qr.macName, dnsName: target.qr.dnsName, ip: target.qr.ip, port: target.qr.port }
          : target.endpoint;
      let macName = endpoint.macName;
      let nonce: string;
      try {
        nonce = makeNonce(Crypto.getRandomBytes);
      } catch {
        setPairing({ target, macName, via: target.kind, phase: "failed", code: null, error: "Couldn't pair" });
        return;
      }
      setNotice(null);
      setPairing({ target, macName, via: target.kind, phase: "connecting", code: null, error: null });
      const patch = (p: Partial<PairingState>) => {
        if (isCurrent()) setPairing((prev) => (prev ? { ...prev, ...p } : prev));
      };
      const showCode = (input: string) =>
        confirmCode(sha256Hex, input, nonce).then(
          (code) => patch({ code }),
          () => patch({ phase: "failed", error: "Couldn't pair" }),
        );
      if (target.kind === "qr") showCode(target.qr.secret);

      let sent = false;
      const client: BridgeClient = new BridgeClient(
        { addresses: addressesFor(stubMac(endpoint), { simulator: IS_SIMULATOR_OR_DEV }), mac: null, pairing: true },
        {
          onState: (c) => {
            if (!isCurrent()) return;
            if (c.phase === "pairing" && !sent) {
              sent = true;
              const name = deviceName();
              client.send(
                target.kind === "qr"
                  ? pairMsg({ secret: target.qr.secret, deviceName: name, nonce })
                  : pairMsg({ request: true, deviceName: name, nonce }),
              );
              patch({ phase: "waiting" });
            } else if (c.phase === "failed") {
              patch({ phase: "failed", error: c.error ? connErrorText(c.error, macName) : "Couldn't pair" });
            }
          },
          onMessage: (m) => {
            if (!isCurrent()) return;
            if (m.type === "hello") {
              macName = m.macName;
              patch({ macName });
            } else if (m.type === "pairPending" && target.kind === "request") {
              showCode(m.requestId);
            }
          },
          onEffect: (e) => {
            // A token the Mac issued is always kept, even if the attempt was abandoned:
            // dropping it would leave a paired device on your computer this phone cannot use.
            if (e.k !== "saveToken") return;
            const mac: SavedMac = {
              deviceId: e.deviceId,
              token: e.token,
              macName,
              dnsName: endpoint.dnsName,
              ip: endpoint.ip,
              port: endpoint.port,
              pairedAt: Date.now(),
            };
            (async () => {
              try {
                await macStore.save(mac);
                await macStore.setCurrent(mac.deviceId);
              } catch {
                patch({ phase: "failed", error: "Couldn't save the pairing on this phone" });
                client.close();
                return;
              }
              client.close();
              // The token is persisted: finish selecting this computer even if the user left Pair
              // meanwhile (pairGen only guards the Pair screen's own state).
              if (pairClientRef.current === client) pairClientRef.current = null;
              await refreshMacs();
              patch({ phase: "done" });
              setNotice(null);
              setCurrentMac(mac);
            })();
          },
        },
      );
      pairClientRef.current = client;
    },
    [refreshMacs],
  );

  // Never leave a pairing socket open behind an unmounted provider.
  useEffect(() => () => pairClientRef.current?.close(), []);

  const probeLoopback = useCallback(
    () => probeLoopbackWith((url) => new WebSocket(url) as unknown as ProbeSocket),
    [],
  );

  const addLoopback = useCallback(
    async (found: LoopbackFound) => {
      const mac = loopbackMac(found, Date.now());
      try {
        await macStore.save(mac);
        await macStore.setCurrent(mac.deviceId);
      } catch {
        // fall through: still connect for this run
      }
      await refreshMacs();
      setNotice(null);
      setCurrentMac(mac);
    },
    [refreshMacs],
  );

  // Track foreground/background: a backgrounded app polls nothing, and closes its socket --
  // iOS suspends it, and an open socket would keep the Mac holding questions for a phone
  // that cannot show them. Back in front it redials (a fresh `ready` re-lists and re-attaches).
  useEffect(() => {
    let prev: string = AppState.currentState;
    const sub = AppState.addEventListener("change", (s) => {
      const active = s === "active";
      const action = lifecycleAction(prev, s);
      if (action === "suspend") clientRef.current?.suspend();
      if (action === "resume") {
        clientRef.current?.resume();
        // back in front: ask at once rather than wait out the interval (a no-op while the
        // socket is redialling; `ready` lists then)
        clientRef.current?.list();
      }
      prev = s;
      setForeground(active);
    });
    return () => sub.remove();
  }, []);

  // Keep the list fresh while connected and in front: the Mac only sends a view when asked.
  const ready = conn.phase === "ready";
  useEffect(() => {
    if (!ready || !foreground) return;
    const t = setInterval(() => clientRef.current?.list(), LIST_POLL_MS);
    return () => clearInterval(t);
  }, [ready, foreground, macKey]);

  const refreshPorts = useCallback(() => {
    clientRef.current?.send(portsMsg());
  }, []);

  const refreshProjects = useCallback(() => {
    clientRef.current?.list();
  }, []);

  const attach = useCallback((sessionId: string) => {
    attachedRef.current = sessionId;
    streamingRef.current = sessionId;
    setSessionLive(EMPTY_LIVE);
    setContext(null);
    // opening a chat reads it, and answers its banner
    setUnread((u) => {
      if (!(sessionId in u)) return u;
      const { [sessionId]: _read, ...rest } = u;
      return rest;
    });
    setBanner((b) => (b?.sessionId === sessionId ? null : b));
    clientRef.current?.attach(sessionId);
  }, []);

  const detach = useCallback((sessionId?: string) => {
    if (sessionId === undefined || attachedRef.current === sessionId) attachedRef.current = null;
  }, []);

  const interrupt = useCallback((sessionId: string) => {
    clientRef.current?.interrupt(sessionId);
    // Esc ends the turn without a Stop hook, so the phone records the idle state itself: the
    // header drops Stop, and a later poll does not read the end of this turn as "finished".
    const prev = signalsRef.current[sessionId];
    if (prev) signalsRef.current = { ...signalsRef.current, [sessionId]: { needs: null, status: "idle" } };
    if (attachedRef.current !== sessionId) return;
    localSeq += 1;
    setSessionLive((s) => ({
      ...s,
      status: "idle",
      statusAt: Date.now(),
      activity: undefined,
      feed: capFeed([
        ...s.feed,
        {
          kind: "divider",
          id: `local-interrupt-${localSeq}`,
          label: "Interrupted by you",
          tone: "warning",
          at: new Date().toISOString(),
        },
      ]),
    }));
  }, []);

  const dismissBanner = useCallback(() => setBanner(null), []);

  /** Send once per item: a card that is already sending, settled or private sends nothing. */
  const sendFor = useCallback(
    (id: string, mine: Mine, frame: ClientMsg) => {
      const e = pendingRef.current.entries[id];
      const client = clientRef.current;
      if (!e || e.sent || e.item.private || e.ok !== undefined || e.by !== undefined) return;
      // Marked sent only once the frame actually went out: a tap while the socket redials
      // (e.g. just back from the background) stays live and says so, instead of "Sending…"
      // forever.
      if (client?.send(frame)) dispatchPending({ t: "sent", id, mine });
      else dispatchPending({ t: "unsent", id });
    },
    [dispatchPending],
  );

  const answer = useCallback(
    (askId: string, answers: Record<string, string>, summary: string) =>
      sendFor(askId, { kind: "answer", summary }, answerMsg(askId, answers)),
    [sendFor],
  );

  const approve = useCallback(
    (id: string, allow: boolean) => sendFor(id, { kind: "approve", allow }, approveMsg(id, allow)),
    [sendFor],
  );

  /** Wait for the answer to one chunk; `cancel` if the chunk never went out. */
  const awaitStep = useCallback((requestId: string, sessionId: string) => {
    let cancel = () => {};
    const promise = new Promise<UploadStep>((resolve) => {
      const finish = (st: UploadStep) => {
        clearTimeout(timer);
        uploadsRef.current.delete(requestId);
        resolve(st);
      };
      // A link that drops mid-upload never answers; say so instead of spinning forever.
      const timer = setTimeout(
        () => finish({ kind: "result", outcome: { ok: false, error: "Your computer didn't answer. Check the connection and try again." } }),
        CHUNK_TIMEOUT_MS,
      );
      uploadsRef.current.set(requestId, { sessionId, step: finish });
      cancel = () => finish({ kind: "result", outcome: { ok: false, error: NOT_CONNECTED } });
    });
    return { promise, cancel };
  }, []);

  const upload = useCallback(
    (sessionId: string, name: string, data: string): Promise<UploadOutcome> => {
      // Picking a photo or taking one sends the app to the background, and a backgrounded app
      // closes its socket; the upload starts the moment the picker returns, usually before the
      // reconnect. So wait for the link (measured on a vivo X200 Pro: every pick after the
      // first failed with "Not connected"). The desktop keeps half-received files PER
      // CONNECTION, so a link that drops mid-file restarts that file, once.
      const waitReady = async (): Promise<boolean> => {
        const until = Date.now() + RECONNECT_WAIT_MS;
        while (Date.now() < until) {
          if (connRef.current.phase === "ready" && clientRef.current) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      };
      const attempt = async (): Promise<UploadOutcome & { lost?: boolean }> => {
        if (!(await waitReady())) return { ok: false, error: "Not connected to your computer.", lost: true };
        const requestId = genId("up");
        const chunks = chunkBase64(data);
        for (let seq = 0; seq < chunks.length; seq++) {
          const done = seq === chunks.length - 1;
          const wait = awaitStep(requestId, sessionId);
          if (!clientRef.current?.send(uploadMsg(sessionId, requestId, name, chunks[seq], seq, done))) wait.cancel();
          const st = await wait.promise;
          if (st.kind === "result") {
            const lost = !st.outcome.ok && (st.outcome.error === NOT_CONNECTED || st.outcome.error === OUT_OF_ORDER);
            return lost ? { ...st.outcome, lost } : st.outcome;
          }
        }
        return { ok: false, error: "Your computer didn't confirm the file." };
      };
      const run = async (): Promise<UploadOutcome> => {
        const first = await attempt();
        const r = first.lost ? await attempt() : first;
        return r.ok ? { ok: true, path: r.path } : { ok: false, error: r.error };
      };
      const next = uploadQueue.current.then(run, run);
      uploadQueue.current = next.catch(() => undefined);
      return next;
    },
    [awaitStep],
  );

  const sessionAction = useCallback(
    (action: SessionAction, sessionIds: string[]): Promise<ActionResult> =>
      new Promise<ActionResult>((resolve) => {
        const requestId = genId("act");
        const timer = setTimeout(() => {
          if (!actionsRef.current.delete(requestId)) return;
          resolve({ ok: false, error: "Your computer didn't answer. Pull to refresh to see what changed." });
        }, ACTION_TIMEOUT_MS);
        actionsRef.current.set(requestId, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        if (!clientRef.current?.send(sessionActionMsg(requestId, action, sessionIds))) {
          actionsRef.current.delete(requestId);
          clearTimeout(timer);
          resolve({ ok: false, error: "Not connected to your computer." });
        }
      }),
    [],
  );

  const prompt = useCallback((sessionId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // No optimistic echo: claude logs the injected prompt to its transcript, which
    // the bridge tails back as a `chat` frame — avoids a duplicate user bubble.
    clientRef.current?.prompt(sessionId, trimmed);
  }, []);

  /** Raw frames for the quick-actions sheet (its table, logic/quickActions.ts, builds them). */
  const sendFrames = useCallback((frames: ClientMsg[]) => {
    for (const f of frames) clientRef.current?.send(f);
  }, []);

  const spawn = useCallback((projectId: string, text: string, agent: string, name = "") => {
    const trimmed = text.trim();
    if (spawnPending.current) return;
    const client = clientRef.current;
    if (!client) {
      setSpawnState({ phase: "failed", message: "Not connected to your computer." });
      return;
    }
    spawnPending.current = true;
    spawnLate.current = false;
    setSpawnState({ phase: "pending" });
    client.send(spawnMsg(projectId, trimmed, agent, name));
  }, []);

  // A spawn the Mac never answers (link dropped mid-request) must not spin forever. It is NOT
  // retried: the Mac may have started the session anyway, and a retry would start a second.
  // A late `spawned` still opens the chat (spawnLate).
  useEffect(() => {
    if (spawnState.phase !== "pending") return;
    const t = setTimeout(() => {
      if (!spawnPending.current) return;
      spawnPending.current = false;
      spawnLate.current = true;
      clientRef.current?.list();
      setSpawnState({
        phase: "failed",
        message: "Your computer hasn't answered yet. Check Sessions before starting another — it may have started.",
      });
    }, SPAWN_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [spawnState.phase]);

  const resetSpawn = useCallback(() => {
    spawnPending.current = false;
    spawnLate.current = false;
    setSpawnState({ phase: "idle" });
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);
  const address = conn.phase === "ready" ? conn.addresses[conn.addressIndex] ?? null : null;

  const value = useMemo<LiveValue>(
    () => ({
      loaded,
      macs,
      currentMac,
      conn,
      hello,
      address,
      notice,
      clearNotice,
      selectMac,
      forget,
      discover,
      discovered,
      webPorts,
      refreshPorts,
      pairing,
      pair,
      cancelPairing,
      probeLoopback,
      addLoopback,
      view,
      viewAt,
      refreshProjects,
      unread,
      lastSeen,
      sessionLive,
      context,
      attach,
      detach,
      prompt,
      interrupt,
      sendFrames,
      spawn,
      spawnState,
      resetSpawn,
      pending,
      answer,
      approve,
      upload,
      sessionAction,
      fsList,
      fsRead,
      fsWrite,
      fsDownload,
      rootChats,
      rootFeeds,
      refreshRootChats,
      openRootChat,
      closeRootChat,
      createRootChat,
      sendRootChat,
      stopRootChat,
      setRootChatScope,
      rootChatOptions,
      loadRootChatOptions,
      setRootChatSettings,
      usage,
      refreshUsage,
      sessionOptions,
      sessionSet,
      banner,
      dismissBanner,
    }),
    [
      usage,
      refreshUsage,
      sessionOptions,
      sessionSet,
      rootChats,
      rootFeeds,
      refreshRootChats,
      openRootChat,
      closeRootChat,
      createRootChat,
      sendRootChat,
      stopRootChat,
      setRootChatScope,
      rootChatOptions,
      loadRootChatOptions,
      setRootChatSettings,
      pending,
      answer,
      approve,
      upload,
      sessionAction,
      fsList,
      fsRead,
      fsWrite,
      fsDownload,
      sendFrames,
      spawn,
      spawnState,
      resetSpawn,
      loaded,
      macs,
      currentMac,
      conn,
      hello,
      address,
      notice,
      clearNotice,
      selectMac,
      forget,
      discover,
      discovered,
      webPorts,
      refreshPorts,
      pairing,
      pair,
      cancelPairing,
      probeLoopback,
      addLoopback,
      view,
      viewAt,
      refreshProjects,
      unread,
      lastSeen,
      sessionLive,
      context,
      attach,
      detach,
      prompt,
      interrupt,
      banner,
      dismissBanner,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive must be used within a LiveProvider");
  return v;
}

/**
 * Keep the usage meters fresh while a screen that shows them is focused: ask when it gains
 * focus or the link comes back, then at most every USAGE_POLL_MS. A backgrounded app's socket
 * is closed, so the interval's sends simply go nowhere until it is back in front.
 */
export function useUsagePolling(active: boolean): void {
  const { refreshUsage, conn } = useLive();
  const ready = conn.phase === "ready";
  useEffect(() => {
    if (!active || !ready) return;
    refreshUsage();
    const t = setInterval(() => refreshUsage(), USAGE_POLL_MS);
    return () => clearInterval(t);
  }, [active, ready, refreshUsage]);
}
