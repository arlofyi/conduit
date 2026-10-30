/**
 * Map bridge wire messages to the app's UI types, and reduce live hook `status`
 * frames into a per-session status patch. The reducer is a port of the desktop
 * verb→status switch in `src/App.tsx`.
 */
import type { ChatItem, EventKind, SessionStatus, TodoProgress } from "../data/types";
import { toolActivity } from "../logic/status";
import type {
  WireChatItem,
  WireLastMessage,
  WireNeeds,
  WireProjectsView,
  WireStatus,
  WireViewSession,
} from "./protocol";

let idSeq = 0;
function nextId(prefix = "w"): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function eventKind(e: string): EventKind {
  switch (e) {
    case "read":
      return "read";
    case "bash":
      return "bash";
    case "edit":
      return "edit";
    case "search":
      return "search";
    case "web":
      return "web";
    case "subagent":
      return "subagent";
    default:
      return "generic";
  }
}

/**
 * Every wire kind `mapChatItem` handles: the Rust manifest minus `usage` (not shown on the phone); `result` stays in the feed and is paired with its call by `groupFeed`.
 * A literal on purpose: Metro cannot bundle files outside mobile/. live.test.ts checks it against the manifest.
 */
export const PHONE_KINDS: readonly string[] = [
  "bubble",
  "event",
  "result",
  "task",
  "peer",
  "auto",
  "command",
  "command_output",
  "skill",
  "image",
  "divider",
  "question",
  "plan",
  "note",
];

/** Same table as the desktop's `taskLine` (src/chatItems.ts); keep in step. */
function taskLine(status: string): { tone: "ok" | "bad" | "info"; text: string } {
  switch (status) {
    case "completed":
      return { tone: "ok", text: "Background task finished" };
    case "failed":
    case "error":
      return { tone: "bad", text: "Background task failed" };
    case "stopped":
    case "killed":
      return { tone: "info", text: "Background task stopped" };
    default:
      return { tone: "info", text: "Background task update" };
  }
}

/** Transcript-derived wire item to UI ChatItem (assigns a render id, keeps the line's `at`).
 * Null = not shown on the phone. */
export function mapChatItem(w: WireChatItem): ChatItem | null {
  const item = mapBody(w);
  if (item && typeof w.at === "string" && w.at !== "") item.at = w.at;
  return item;
}

function mapBody(w: WireChatItem): ChatItem | null {
  switch (w.kind) {
    case "bubble":
      return { kind: "bubble", id: nextId("b"), role: w.role, text: w.text };
    case "event":
      return {
        kind: "event",
        id: nextId("e"),
        event: eventKind(w.event),
        label: w.label,
        mono: w.mono ?? undefined,
        ok: w.ok ?? undefined,
        toolUseId: w.toolUseId ?? undefined,
      };
    case "result":
      return {
        kind: "result",
        id: nextId("r"),
        toolUseId: w.toolUseId,
        isError: w.isError,
        errorText: w.errorText,
        diff: w.diff,
      };
    case "task": {
      const { tone, text } = taskLine(w.status);
      return { kind: "notice", id: nextId("n"), tone, text, detail: w.summary };
    }
    case "peer":
      return { kind: "notice", id: nextId("n"), tone: "info", text: `Message from ${w.from}`, detail: w.text };
    case "auto":
      return { kind: "notice", id: nextId("n"), tone: "info", text: w.label, detail: w.text };
    case "skill":
      return { kind: "notice", id: nextId("n"), tone: "info", text: `Loaded skill ${w.name}` };
    case "note":
      return { kind: "notice", id: nextId("n"), tone: "info", text: w.tag, detail: w.text };
    case "divider":
      return { kind: "divider", id: nextId("d"), label: w.label, tone: w.tone };
    case "command":
      return { kind: "command", id: nextId("c"), name: w.name, args: w.args };
    case "command_output":
      return { kind: "command", id: nextId("c"), name: "", args: "", output: w.text };
    case "image":
      return { kind: "image", id: nextId("i"), mediaType: w.mediaType, data: w.data };
    case "question":
      return { kind: "question", id: nextId("q"), toolUseId: w.toolUseId, questions: w.questions };
    case "plan":
      return { kind: "plan", id: nextId("p"), markdown: w.markdown };
    default:
      return null; // usage, and kinds from a newer desktop
  }
}

/** Append one wire item to a feed, folding a command's output into the command before it. */
export function appendWire(feed: ChatItem[], w: WireChatItem): ChatItem[] {
  const last = feed[feed.length - 1];
  if (w.kind === "command_output" && last && last.kind === "command" && last.output === undefined) {
    return [...feed.slice(0, -1), { ...last, output: w.text }];
  }
  const item = mapChatItem(w);
  return item ? [...feed, item] : feed;
}

export function mapHistory(ws: WireChatItem[]): ChatItem[] {
  return ws.reduce<ChatItem[]>(appendWire, []);
}

const STATUSES: readonly WireStatus[] = ["idle", "running", "needsInput", "done"];

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function needsOf(v: unknown): WireNeeds {
  const n = v as { kind?: unknown; text?: unknown } | null;
  if (n?.kind === "ask") return { kind: "ask", text: str(n.text) };
  if (n?.kind === "input") return { kind: "input", text: null };
  return null;
}

function sessionOf(v: unknown): WireViewSession | null {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s.id !== "string") return null;
  const silo = s.silo === true;
  const needs = needsOf(s.needs);
  return {
    id: s.id,
    name: str(s.name) ?? s.id,
    agent: str(s.agent) ?? "",
    branch: str(s.branch),
    model: str(s.model),
    stopped: s.stopped === true,
    running: s.running === true,
    silo,
    status: STATUSES.includes(s.status as WireStatus) ? (s.status as WireStatus) : "idle",
    // The Mac already withholds these for a silo session; never let one through regardless.
    activity: silo ? null : str(s.activity),
    updatedAt: typeof s.updatedAt === "number" && s.updatedAt > 0 ? s.updatedAt : null,
    needs: silo && needs ? { kind: "input", text: null } : needs,
    // The Mac sends null for a silo session; never show one regardless.
    lastMessage: silo ? null : lastMessageOf(s.lastMessage),
  };
}

function lastMessageOf(v: unknown): WireLastMessage | null {
  const m = v as { role?: unknown; text?: unknown; at?: unknown } | null;
  if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return null;
  return { role: m.role, text: m.text, at: str(m.at) };
}

/**
 * The `projects` frame as the typed view the Chats list reads (shape: src-tauri/src/bridge_view.rs).
 * Defensive: a malformed entry is dropped or defaulted rather than crashing the list, and the
 * frame's `type` tag is not carried along.
 */
export function mapProjectsView(m: unknown): WireProjectsView {
  const v = (m ?? {}) as Record<string, unknown>;
  const profiles = Array.isArray(v.profiles)
    ? v.profiles.flatMap((p) => {
        const pr = p as { id?: unknown; name?: unknown } | null;
        if (!pr || typeof pr.name !== "string") return [];
        return [{ id: str(pr.id), name: pr.name }];
      })
    : [];
  const projects = Array.isArray(v.projects)
    ? v.projects.flatMap((p) => {
        const pr = p as Record<string, unknown> | null;
        if (!pr || typeof pr.id !== "string") return [];
        const sessions = Array.isArray(pr.sessions)
          ? pr.sessions.map(sessionOf).filter((s): s is WireViewSession => s !== null)
          : [];
        return [{ id: pr.id, name: str(pr.name) ?? pr.id, profileId: str(pr.profileId), color: str(pr.color), sessions }];
      })
    : [];
  return {
    profiles: profiles.length > 0 ? profiles : [{ id: null, name: "Default" }],
    activeProfileId: str(v.activeProfileId),
    projects,
  };
}

/**
 * Deep equality of two mapped views. `mapProjectsView` builds every object with a fixed key
 * order, so comparing serializations is exact; the provider keeps the previous reference when
 * a poll brings nothing new, so the list re-renders nothing.
 */
export function sameView(a: WireProjectsView | null, b: WireProjectsView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- live status reducer (subset of desktop src/App.tsx hook switch) ----

export interface LivePatch {
  status?: SessionStatus;
  activity?: string;
  compacting?: boolean;
  todos?: TodoProgress;
  /** clear the transient activity label */
  clearActivity?: boolean;
}

interface HookBody {
  tool_name?: string;
  tool_input?: { todos?: unknown[]; todo_list?: unknown[]; file_path?: string; path?: string; command?: string };
  message?: string;
  prompt?: string;
}

function todoProgress(items: unknown[]): { progress: TodoProgress; anyRunning: boolean } {
  const arr = items as { status?: string }[];
  const done = arr.filter((t) => t.status === "completed").length;
  const anyRunning = arr.some((t) => t.status === "in_progress");
  return { progress: { done, total: arr.length }, anyRunning };
}

/** One hook `status` frame → a patch to apply to the session's live state. */
export function statusPatch(event: string, body: HookBody | null | undefined): LivePatch {
  const b = body ?? {};
  switch (event) {
    case "prompt":
      return { status: "running", compacting: false, clearActivity: true };
    case "pretool":
      return { status: "running", compacting: false, activity: toolActivity(b.tool_name ?? "", b.tool_input) };
    case "todos":
    case "tooluse": {
      const items = b.tool_input?.todos ?? b.tool_input?.todo_list;
      if (Array.isArray(items)) {
        const { progress, anyRunning } = todoProgress(items);
        return anyRunning ? { todos: progress, status: "running" } : { todos: progress };
      }
      return {};
    }
    case "precompact":
      return { compacting: true };
    case "sessionstart":
      return { compacting: false, clearActivity: true };
    case "sessionend":
      return { status: "idle", compacting: false, clearActivity: true };
    case "stop":
      return { status: "done", compacting: false, clearActivity: true };
    case "notification":
      return { status: "needsInput" };
    default:
      return {};
  }
}
