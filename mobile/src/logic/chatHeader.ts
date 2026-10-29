/**
 * The chat screen's header: "Project · title", the agent avatar, and the sub-line
 * `waiting on you | working… | idle · <model> · <n>% context`. Pure, so the precedence
 * between the polled `projects` view and the live hook stream is tested here.
 */
import type { WireProjectsView, WireViewProject, WireViewSession } from "../bridge/protocol";
import type { SessionStatus } from "../data/types";
import { accentFor } from "./accent";
import { agentInitials, isNeeds } from "./chatList";

export type HeaderState = "needs" | "running" | "idle";

export interface ContextInfo {
  /** 0..1 of the model's context window */
  fraction: number;
  model: string | null;
}

/** The live hook-derived status and when it arrived (ms; 0 = no hook seen since attach). */
export interface LiveStatus {
  status: SessionStatus;
  at: number;
}

export interface ChatHeader {
  /** "Project · title" */
  title: string;
  /** the session's own title (composer placeholder) */
  name: string;
  initials: string;
  color: string | null;
  state: HeaderState;
  subline: string;
  /** Stop is offered only while a turn is running */
  canStop: boolean;
}

export function headerState(status: SessionStatus): HeaderState {
  if (status === "needsInput") return "needs";
  return status === "running" ? "running" : "idle";
}

const STATE_TEXT: Record<HeaderState, string> = {
  needs: "waiting on you",
  running: "working…",
  idle: "idle",
};

const FAMILIES = ["opus", "sonnet", "haiku", "fable"];

/** "claude-opus-4-1-…" → "Opus"; ids from other providers are shown as they are. */
export function modelLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  const lower = id.toLowerCase();
  if (lower.startsWith("claude") || !lower.includes("/")) {
    const fam = FAMILIES.find((f) => lower.includes(f));
    if (fam) return fam[0].toUpperCase() + fam.slice(1);
  }
  return id;
}

export function subline(a: { state: HeaderState; model: string | null; fraction: number | null }): string {
  const parts = [STATE_TEXT[a.state]];
  if (a.model) parts.push(a.model);
  if (a.fraction !== null && Number.isFinite(a.fraction)) {
    const pct = Math.round(Math.min(1, Math.max(0, a.fraction)) * 100);
    parts.push(`${pct}% context`);
  }
  return parts.join(" · ");
}

function find(
  view: WireProjectsView | null,
  projectId: string,
  sessionId: string,
): { project: WireViewProject; session: WireViewSession } | null {
  if (!view) return null;
  // The route's project first; session ids are unique, so any project listing it will do
  // (a session moved between projects on the Mac is still found).
  const ordered = [...view.projects].sort((x, y) => Number(y.id === projectId) - Number(x.id === projectId));
  for (const project of ordered) {
    const session = project.sessions.find((s) => s.id === sessionId);
    if (session) return { project, session };
  }
  return null;
}

/**
 * The newer of the two status sources wins. The view's `updatedAt` is when the Mac last saw the
 * session change; a live hook (or the phone's own Stop) newer than that is fresher. With no
 * timestamp on the view, a live status received since attach wins.
 */
function stateOf(session: WireViewSession | null, live: LiveStatus): HeaderState {
  const liveWins = live.at > 0 && (session === null || session.updatedAt === null || live.at >= session.updatedAt);
  if (liveWins) return headerState(live.status);
  if (!session) return "idle";
  if (isNeeds(session)) return "needs";
  return session.status === "running" ? "running" : "idle";
}

export function chatHeader(a: {
  view: WireProjectsView | null;
  sessionId: string;
  projectId: string;
  /** the name the list navigated with, used until the view has the session */
  fallbackName: string;
  live: LiveStatus;
  context: ContextInfo | null;
}): ChatHeader {
  const hit = find(a.view, a.projectId, a.sessionId);
  const state = stateOf(hit?.session ?? null, a.live);
  const model = modelLabel(a.context?.model ?? hit?.session.model ?? null);
  return {
    title: hit ? `${hit.project.name} · ${hit.session.name}` : a.fallbackName,
    name: hit?.session.name ?? a.fallbackName,
    initials: hit ? agentInitials(hit.session.agent) : "?",
    color: hit ? accentFor(hit.project) : null,
    state,
    subline: subline({ state, model, fraction: a.context ? a.context.fraction : null }),
    canStop: state === "running",
  };
}
