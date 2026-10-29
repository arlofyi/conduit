import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatItem, Project, SessionStatus, TodoProgress } from "../data/types";
import { BridgeClient } from "./BridgeClient";
import type { ConnState as Conn } from "./connection";
import { appendWire, mapHistory, mapProjects, statusPatch, type LivePatch } from "./live";
import type { WireProject, WireProjectsView } from "./protocol";

/**
 * TEMPORARY (Task 4 replaces this): until the Connect/Pair screens and the Keychain Mac list
 * exist, connect to the desktop on loopback with no saved Mac (the desktop trusts loopback).
 * Task 4 must drive BridgeClient from the saved current Mac (addresses from addressesFor).
 */
const LOOPBACK_URL = "ws://127.0.0.1:8455";

/** Coarse state the current screens render; Task 4 moves them to the full Conn phase. */
type ConnState = "connecting" | "open" | "closed";
const coarse = (c: Conn): ConnState =>
  c.phase === "ready" ? "open" : c.phase === "failed" || c.phase === "idle" ? "closed" : "connecting";

/** Adapt the typed projects view to the legacy shape live.ts maps (Task 5 removes this). */
function legacyProjects(v: WireProjectsView): WireProject[] {
  return v.projects.map((p) => ({
    id: p.id,
    name: p.name,
    path: "",
    sessions: p.sessions.map((s) => ({
      id: s.id,
      name: s.name,
      branch: s.branch,
      agent: s.agent as WireProject["sessions"][number]["agent"],
      running: s.running,
    })),
  }));
}

export interface SessionLive {
  feed: ChatItem[];
  status: SessionStatus;
  activity?: string;
  compacting?: boolean;
  todos?: TodoProgress;
}

const EMPTY_LIVE: SessionLive = { feed: [], status: "idle" };

interface LiveValue {
  connState: ConnState;
  url: string;
  setUrl: (u: string) => void;
  /** dev shared token (CONDUIT_BRIDGE_TOKEN); empty for loopback/simulator */
  token: string;
  setToken: (t: string) => void;
  projects: Project[];
  /** live data for the currently-attached session */
  sessionLive: SessionLive;
  attach: (sessionId: string) => void;
  detach: () => void;
  /** send a prompt to a session (optimistically echoes the user bubble) */
  prompt: (sessionId: string, text: string) => void;
}

const Ctx = createContext<LiveValue | null>(null);

function applyPatch(prev: SessionLive, patch: LivePatch): SessionLive {
  return {
    feed: prev.feed,
    status: patch.status ?? prev.status,
    activity: patch.clearActivity ? undefined : patch.activity ?? prev.activity,
    compacting: patch.compacting ?? prev.compacting,
    todos: patch.todos ?? prev.todos,
  };
}

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [url, setUrl] = useState(LOOPBACK_URL);
  const [token, setToken] = useState("");
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessionLive, setSessionLive] = useState<SessionLive>(EMPTY_LIVE);
  const clientRef = useRef<BridgeClient | null>(null);
  const attachedRef = useRef<string | null>(null);

  useEffect(() => {
    let wasReady = false;
    const client = new BridgeClient({ addresses: [url], mac: null }, {
      onState: (c) => {
        setConnState(coarse(c));
        const ready = c.phase === "ready";
        const justReady = ready && !wasReady;
        wasReady = ready;
        if (justReady) {
          client.list();
          // re-attach across reconnects (desktop is source of truth)
          if (attachedRef.current) {
            setSessionLive(EMPTY_LIVE);
            client.attach(attachedRef.current);
          }
        }
      },
      onMessage: (m) => {
        switch (m.type) {
          case "projects":
            setProjects(mapProjects(legacyProjects(m)));
            break;
          case "history":
            setSessionLive((prev) => ({ ...prev, feed: mapHistory(m.items) }));
            break;
          case "chat":
            setSessionLive((prev) => ({ ...prev, feed: appendWire(prev.feed, m.item) }));
            break;
          case "status":
            setSessionLive((prev) => applyPatch(prev, statusPatch(m.event, m.body as never)));
            break;
          // size / output / error are not used by the chat UI
        }
      },
    });
    clientRef.current = client;
    return () => client.close();
  }, [url, token]);

  const attach = useCallback((sessionId: string) => {
    attachedRef.current = sessionId;
    setSessionLive(EMPTY_LIVE);
    clientRef.current?.attach(sessionId);
  }, []);

  const detach = useCallback(() => {
    attachedRef.current = null;
  }, []);

  const prompt = useCallback((sessionId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // No optimistic echo: claude logs the injected prompt to its transcript, which
    // the bridge tails back as a `chat` frame — avoids a duplicate user bubble.
    clientRef.current?.prompt(sessionId, trimmed);
  }, []);

  const value = useMemo<LiveValue>(
    () => ({ connState, url, setUrl, token, setToken, projects, sessionLive, attach, detach, prompt }),
    [connState, url, token, projects, sessionLive, attach, detach, prompt],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive must be used within a LiveProvider");
  return v;
}
