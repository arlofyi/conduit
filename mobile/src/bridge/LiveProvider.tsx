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
import { capFeed } from "../logic/feed";
import { acceptsFrame, frameSession, isSpawnError, PRIVATE_SESSION, refusesOpenChat, spawnErrorText } from "../logic/frames";
import { loopbackMac, type PairEndpoint } from "../logic/macs";
import { addressesFor, confirmCode, makeNonce, type QrPayload } from "../logic/pairing";
import { emptyPending, fromWire, pendingReducer, type Mine, type PendingEvent, type PendingState } from "../logic/pending";
import { BridgeClient } from "./BridgeClient";
import { initialConn, lifecycleAction, type ConnError, type ConnState } from "./connection";
import { appendWire, mapHistory, mapProjectsView, sameView, statusPatch, type LivePatch } from "./live";
import { probeLoopback as probeLoopbackWith, type LoopbackFound, type ProbeSocket } from "./probe";
import { answerMsg, approveMsg, discoverMsg, pairMsg, spawnMsg, type ClientMsg, type WireMac } from "./protocol";

/** Simulator/dev build: also try loopback, and offer "This Mac (simulator)". */
export const IS_SIMULATOR_OR_DEV = __DEV__;

/**
 * The Mac answers `list` with its whole projects view and pushes nothing in between, so the
 * Chats list asks again on this cadence while connected. The view is built from in-memory
 * state on the Mac (no git, no disk), so this is cheap on both ends.
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
  /** Stop the session's current turn (Esc on the Mac) and mark it in the open feed */
  interrupt: (sessionId: string) => void;
  /** send prepared frames (quick actions) */
  sendFrames: (frames: ClientMsg[]) => void;
  /** start a new session with its first message; the answer lands in `spawnState` */
  spawn: (projectId: string, text: string, agent: string) => void;
  spawnState: SpawnState;
  resetSpawn: () => void;
  /** questions/permissions the current Mac holds for a human, and how each one ended */
  pending: PendingState;
  /** answer a held question; `summary` is what the card confirms */
  answer: (askId: string, answers: Record<string, string>, summary: string) => void;
  /** allow or deny a held permission */
  approve: (id: string, allow: boolean) => void;
  /** the in-app banner on screen, if any */
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
  const [hello, setHello] = useState<HelloInfo | null>(null);
  const [notice, setNotice] = useState<ConnError | null>(null);
  const [discovered, setDiscovered] = useState<WireMac[] | null>(null);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [view, setView] = useState<ProjectsView | null>(null);
  const [viewAt, setViewAt] = useState(0);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  /** the last view, for diffing the next one into unread counts */
  const viewRef = useRef<ProjectsView | null>(null);
  /** the session the Mac is streaming to this socket; outlives `attachedRef` after the chat closes */
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
            case "error":
              if (m.message === PRIVATE_SESSION) {
                // The Mac refused the chat that is open (at attach, or because it was made
                // private while streaming): say so instead of an empty feed. A refusal for a
                // chat already left is stale and ignored.
                if (refusesOpenChat(m.message, m.sessionId, attachedRef.current)) {
                  setSessionLive({ ...EMPTY_LIVE, refused: "private" });
                }
              } else if (spawnPending.current && isSpawnError(m.message)) {
                // Only the spawn's own errors answer a spawn; anything else is about another request.
                spawnPending.current = false;
                spawnLate.current = false;
                setSpawnState({ phase: "failed", message: spawnErrorText(m.message) });
              }
              break;
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
            // dropping it would leave a paired device on the Mac this phone cannot use.
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
              // The token is persisted: finish selecting this Mac even if the user left Pair
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

  const spawn = useCallback((projectId: string, text: string, agent: string) => {
    const trimmed = text.trim();
    if (!trimmed || spawnPending.current) return;
    const client = clientRef.current;
    if (!client) {
      setSpawnState({ phase: "failed", message: "Not connected to your Mac." });
      return;
    }
    spawnPending.current = true;
    spawnLate.current = false;
    setSpawnState({ phase: "pending" });
    client.send(spawnMsg(projectId, trimmed, agent));
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
        message: "Your Mac hasn't answered yet. Check Chats before starting another — it may have started.",
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
      banner,
      dismissBanner,
    }),
    [
      pending,
      answer,
      approve,
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
