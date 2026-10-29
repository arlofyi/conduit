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
import { bannerFromStatus, bannersFromView, type Banner, type Signals } from "../logic/banner";
import type { ContextInfo } from "../logic/chatHeader";
import { chatUnread, nextUnread } from "../logic/chatList";
import { connErrorText } from "../logic/connCopy";
import { loopbackMac, type PairEndpoint } from "../logic/macs";
import { addressesFor, confirmCode, makeNonce, type QrPayload } from "../logic/pairing";
import { BridgeClient } from "./BridgeClient";
import { initialConn, type ConnError, type ConnState } from "./connection";
import { appendWire, mapHistory, mapProjectsView, sameView, statusPatch, type LivePatch } from "./live";
import { probeLoopback as probeLoopbackWith, type LoopbackFound, type ProbeSocket } from "./probe";
import { discoverMsg, pairMsg, type WireMac } from "./protocol";

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
}

const EMPTY_LIVE: SessionLive = { feed: [], status: "idle", statusAt: 0 };

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
  /** the in-app banner on screen, if any */
  banner: Banner | null;
  dismissBanner: () => void;
}

const Ctx = createContext<LiveValue | null>(null);

function applyPatch(prev: SessionLive, patch: LivePatch): SessionLive {
  return {
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
            case "macs":
              setDiscovered(m.macs);
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
              setSessionLive((prev) => ({ ...prev, feed: mapHistory(m.items) }));
              break;
            case "chat": {
              // chat frames carry no session id: they belong to whatever this socket streams
              const streaming = streamingRef.current;
              setUnread((u) => chatUnread(u, streaming, attachedRef.current));
              if (attachedRef.current) setSessionLive((prev) => ({ ...prev, feed: appendWire(prev.feed, m.item) }));
              break;
            }
            case "status": {
              // status frames carry no session id either: they are the streamed session's
              const patch = statusPatch(m.event, m.body as never);
              const streaming = streamingRef.current;
              if (attachedRef.current) setSessionLive((prev) => applyPatch(prev, patch));
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

  // Track foreground/background: a backgrounded app polls nothing.
  useEffect(() => {
    let was = AppState.currentState === "active";
    const sub = AppState.addEventListener("change", (s) => {
      const active = s === "active";
      // back in front: ask at once rather than wait out the interval
      if (active && !was) clientRef.current?.list();
      was = active;
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
      feed: [...s.feed, { kind: "divider", id: `local-interrupt-${localSeq}`, label: "■ Interrupted by you", tone: "warning" }],
    }));
  }, []);

  const dismissBanner = useCallback(() => setBanner(null), []);

  const prompt = useCallback((sessionId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // No optimistic echo: claude logs the injected prompt to its transcript, which
    // the bridge tails back as a `chat` frame — avoids a duplicate user bubble.
    clientRef.current?.prompt(sessionId, trimmed);
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
      banner,
      dismissBanner,
    }),
    [
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
