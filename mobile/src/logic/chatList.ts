/**
 * The Chats list, as pure functions over the desktop's typed `projects` view
 * (src-tauri/src/bridge_view.rs is the authority for its shape). The screen only renders
 * what these return, so the ordering, filtering and counting rules are tested here.
 *
 * The list is FLAT, like a messenger's: the project rides on each row as a coloured label
 * rather than as a section header, and rows sort "needs you" first, then most recent.
 */
import type { WireProjectsView, WireViewProject, WireViewSession } from "../bridge/protocol";
import { accentFor } from "./accent";
import { glyphStateFor, type GlyphState } from "./agents";
import { permissionLine, type PendingItem } from "./pending";
import { listTime, toMs } from "./time";

/** Profile selection meaning "every profile". Desktop profile ids are uuids; this cannot collide. */
export const ALL_PROFILES = "*all-profiles*";

/** A profile id from the view (`null` = the Default profile), or ALL_PROFILES. */
export type ProfileSel = string | null;

/** "all", "needs", "running", or a project id. */
export type ChatFilter = "all" | "needs" | "running" | string;

export type Dot = "needs" | "running" | "idle";

export interface Preview {
  /** needs = amber; running = the "typing…" line; plain = a message; private = a silo row */
  tone: "needs" | "running" | "plain" | "private";
  /** bold lead-in: "Asks:" on a needs row, "You:" on the user's own last message */
  prefix: string | null;
  text: string;
}

export interface Row {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  branch: string | null;
  /** desktop agent id; the avatar draws its brand mark */
  agent: string;
  initials: string;
  color: string;
  dot: Dot;
  /** the desktop's ring vocabulary; undefined = never started this run (no ring) */
  glyph: GlyphState | undefined;
  needs: boolean;
  time: string;
  preview: Preview;
  unread: number;
  /** silo / local-only sessions are listed but never opened from the phone */
  openable: boolean;
}

export interface Chip {
  key: ChatFilter;
  label: string;
  /** project swatch; null for All / Needs you / Running */
  color: string | null;
  /** amber treatment */
  needs?: boolean;
}

export interface ProfileEntry {
  id: ProfileSel;
  name: string;
  /** projects with at least one session */
  projects: number;
  needs: number;
}

/** Two-letter fallback per desktop agent id (src/agents.ts lists the seven). */
const AGENT_INITIALS: Record<string, string> = {
  claude: "CL",
  codex: "CX",
  gemini: "GE",
  opencode: "OC",
  antigravity: "AG",
  commandcode: "CC",
  hermes: "HE",
};

export function agentInitials(agent: string): string {
  return AGENT_INITIALS[agent] ?? "?";
}

export function isNeeds(s: WireViewSession): boolean {
  return s.needs !== null || s.status === "needsInput";
}

export function dotFor(s: WireViewSession): Dot {
  if (isNeeds(s)) return "needs";
  return s.status === "running" ? "running" : "idle";
}

/** The ring a row's avatar wears: the desktop's `glyphStateFor`, with "loaded" = a live PTY. */
export function glyphFor(s: WireViewSession): GlyphState | undefined {
  return glyphStateFor(isNeeds(s) ? "needsInput" : s.status, s.running);
}

function inProfile(p: WireViewProject, profileId: ProfileSel): boolean {
  return profileId === ALL_PROFILES || (p.profileId ?? null) === profileId;
}

/**
 * The row's second line, WhatsApp's precedence: what needs you, then what it is doing right
 * now (WhatsApp's "typing…"), then the last message ("You: …" for yours), then a state word.
 */
export function previewFor(s: WireViewSession, pending?: PendingItem): Preview {
  if (s.silo || pending?.private) {
    // Listed (and counted in Needs you) but never opened here: say where to answer it.
    return {
      tone: "private",
      prefix: null,
      text: isNeeds(s) || pending ? "Private session — open it on your Mac" : "Private session",
    };
  }
  // A pushed question/permission is fresher than the last poll: it leads the row at once.
  if (pending?.kind === "ask") {
    const q = pending.questions[0]?.question?.trim();
    return q ? { tone: "needs", prefix: "Asks:", text: q } : { tone: "needs", prefix: null, text: "Asks you a question" };
  }
  if (pending?.kind === "permission") return { tone: "needs", ...permissionLine(pending) };
  if (s.needs?.kind === "ask") {
    return s.needs.text
      ? { tone: "needs", prefix: "Asks:", text: s.needs.text }
      : { tone: "needs", prefix: null, text: "Asks you a question" };
  }
  if (isNeeds(s)) return { tone: "needs", prefix: null, text: "Needs your input" };
  if (s.status === "running") return { tone: "running", prefix: null, text: s.activity ? `${s.activity}…` : "working…" };
  if (s.lastMessage && s.lastMessage.text) {
    return { tone: "plain", prefix: s.lastMessage.role === "user" ? "You:" : null, text: s.lastMessage.text };
  }
  if (s.status === "done") return { tone: "plain", prefix: null, text: "Finished" };
  if (s.stopped) return { tone: "plain", prefix: null, text: "Stopped" };
  return { tone: "plain", prefix: null, text: s.branch ?? "No messages yet" };
}

/** When the row last moved: the later of the Mac's status change and the last message. */
export function lastActivity(s: WireViewSession): number | null {
  const a = s.updatedAt;
  const b = toMs(s.lastMessage?.at ?? null);
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Coarse age, for the offline bar: now · N min · N h · Yesterday · N d · N w. Empty when unknown. */
export function relativeTime(ms: number | null, now: number): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const d = Math.max(0, now - ms);
  if (d < MIN) return "now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h`;
  if (d < 2 * DAY) return "Yesterday";
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} d`;
  return `${Math.floor(d / (7 * DAY))} w`;
}

export function offlineText(macName: string, lastSeen: number | null, now: number): string {
  if (lastSeen === null) return `${macName} offline`;
  const t = relativeTime(lastSeen, now);
  const when = t === "now" ? "just now" : t === "Yesterday" ? "yesterday" : `${t} ago`;
  return `${macName} offline · last seen ${when}`;
}

function rowFor(
  p: WireViewProject,
  s: WireViewSession,
  unread: Record<string, number>,
  now: number,
  pending: PendingItem | undefined,
): Row {
  const needs = isNeeds(s) || pending !== undefined;
  return {
    id: s.id,
    projectId: p.id,
    projectName: p.name,
    title: s.name,
    branch: s.branch,
    agent: s.agent,
    initials: agentInitials(s.agent),
    color: accentFor(p),
    dot: needs ? "needs" : dotFor(s),
    glyph: needs ? glyphStateFor("needsInput", s.running) : glyphFor(s),
    needs,
    time: listTime(lastActivity(s), now),
    preview: previewFor(s, pending),
    unread: unread[s.id] ?? 0,
    openable: !s.silo,
  };
}

function matches(filter: ChatFilter, p: WireViewProject, s: WireViewSession, pending: boolean): boolean {
  if (filter === "all") return true;
  if (filter === "needs") return pending || isNeeds(s);
  if (filter === "running") return !pending && !isNeeds(s) && s.status === "running";
  return p.id === filter;
}

export function buildRows(
  view: WireProjectsView,
  opts: {
    profileId: ProfileSel;
    filter: ChatFilter;
    unread: Record<string, number>;
    now: number;
    /** pushed, still-open questions/permissions by session (logic/pending.ts `openBySession`) */
    pending?: Record<string, PendingItem>;
  },
): Row[] {
  const { profileId, filter, unread, now } = opts;
  const pending = opts.pending ?? {};
  const items: { row: Row; at: number | null }[] = [];
  for (const p of view.projects) {
    if (!inProfile(p, profileId)) continue;
    for (const s of p.sessions) {
      const pend = pending[s.id];
      if (!matches(filter, p, s, pend !== undefined)) continue;
      items.push({ row: rowFor(p, s, unread, now, pend), at: lastActivity(s) });
    }
  }
  // Needs you first, then most recent. Stable sort: ties keep the desktop's order.
  items.sort((a, b) => Number(b.row.needs) - Number(a.row.needs) || (b.at ?? -Infinity) - (a.at ?? -Infinity));
  return items.map((i) => i.row);
}

/**
 * Needs you: the poll's verdict OR an item the Mac pushed. The poll never marks a held
 * permission (only asks and a `needsInput` status), so without the pushed items a session
 * waiting on Allow/Deny would never be counted.
 */
function needsYou(s: WireViewSession, pending: Record<string, PendingItem> | undefined): boolean {
  return isNeeds(s) || pending?.[s.id] !== undefined;
}

export function chipsFor(view: WireProjectsView, profileId: ProfileSel, pending?: Record<string, PendingItem>): Chip[] {
  const projects = view.projects.filter((p) => inProfile(p, profileId) && p.sessions.length > 0);
  const sessions = projects.flatMap((p) => p.sessions);
  const needs = sessions.filter((s) => needsYou(s, pending)).length;
  const running = sessions.filter((s) => !needsYou(s, pending) && s.status === "running").length;
  const chips: Chip[] = [{ key: "all", label: "All", color: null }];
  // A count chip appears only when there is something to count: "Needs you 0" is noise.
  if (needs > 0) chips.push({ key: "needs", label: `Needs you ${needs}`, color: null, needs: true });
  if (running > 0) chips.push({ key: "running", label: `Running ${running}`, color: null });
  for (const p of projects) chips.push({ key: p.id, label: p.name, color: accentFor(p) });
  return chips;
}

/** How many sessions in the profile need you (the Chats tab badge). */
export function needsCount(view: WireProjectsView | null, profileId: ProfileSel, pending?: Record<string, PendingItem>): number {
  if (!view) return 0;
  return view.projects
    .filter((p) => inProfile(p, profileId))
    .reduce((n, p) => n + p.sessions.filter((s) => needsYou(s, pending)).length, 0);
}

function counts(view: WireProjectsView, profileId: ProfileSel): { projects: number; needs: number } {
  const ps = view.projects.filter((p) => inProfile(p, profileId) && p.sessions.length > 0);
  return { projects: ps.length, needs: ps.reduce((n, p) => n + p.sessions.filter(isNeeds).length, 0) };
}

export function profileSheet(view: WireProjectsView): ProfileEntry[] {
  const list: ProfileEntry[] = view.profiles.map((pr) => ({ id: pr.id, name: pr.name, ...counts(view, pr.id) }));
  list.push({ id: ALL_PROFILES, name: "All profiles", ...counts(view, ALL_PROFILES) });
  return list;
}

/** The selection to use: a profile the Mac no longer has falls back to Default. */
export function resolveProfile(view: WireProjectsView, sel: ProfileSel): ProfileSel {
  if (sel === ALL_PROFILES) return sel;
  return view.profiles.some((p) => p.id === sel) ? sel : null;
}

/** "Profile: <name>" label; an unknown id (profile deleted on the Mac) reads as Default. */
export function profileName(view: WireProjectsView, profileId: ProfileSel): string {
  if (profileId === ALL_PROFILES) return "All profiles";
  return view.profiles.find((p) => p.id === profileId)?.name ?? "Default";
}

/** "N projects · M need(s) you" for a sheet row. */
export function profileSummary(e: ProfileEntry): { projects: string; needs: string | null } {
  return {
    projects: `${e.projects} project${e.projects === 1 ? "" : "s"}`,
    needs: e.needs > 0 ? `${e.needs} ${e.needs === 1 ? "needs" : "need"} you` : null,
  };
}

function sessionsById(view: WireProjectsView): Map<string, WireViewSession> {
  const m = new Map<string, WireViewSession>();
  for (const p of view.projects) for (const s of p.sessions) m.set(s.id, s);
  return m;
}

/**
 * Unread counts after a new `projects` view arrives. The bridge streams chat frames only for
 * the ATTACHED session, so for every other session the only signal is a state change between
 * two views: newly needing you, or a turn that finished. The open chat never accrues; silo
 * sessions never do (they cannot be opened to clear it); counts for vanished sessions drop.
 */
export function nextUnread(
  unread: Record<string, number>,
  prev: WireProjectsView | null,
  next: WireProjectsView,
  openId: string | null,
): Record<string, number> {
  const before = prev ? sessionsById(prev) : null;
  const out: Record<string, number> = {};
  let changed = false;
  let kept = 0;
  for (const s of sessionsById(next).values()) {
    let n = unread[s.id] ?? 0;
    const old = before?.get(s.id);
    if (old && s.id !== openId && !s.silo) {
      const newlyNeeds = isNeeds(s) && !isNeeds(old);
      const finished = old.status === "running" && (s.status === "done" || s.status === "idle") && !isNeeds(s);
      if (newlyNeeds || finished) {
        n++;
        changed = true;
      }
    }
    if (n > 0) {
      out[s.id] = n;
      kept++;
    }
  }
  // Same counts → same object, so a poll that changed nothing re-renders nothing.
  if (!changed && kept === Object.keys(unread).length) return unread;
  return out;
}

/** Shallow value equality for list rows (the preview is the one nested object). */
export function sameRow(a: Row, b: Row): boolean {
  if (a === b) return true;
  for (const k of Object.keys(a) as (keyof Row)[]) {
    if (k === "preview") continue;
    if (a[k] !== b[k]) return false;
  }
  return a.preview.tone === b.preview.tone && a.preview.prefix === b.preview.prefix && a.preview.text === b.preview.text;
}

/** The filter to apply: one whose chip is gone (nothing to count, project removed) reads as All. */
export function resolveFilter(chips: Chip[], filter: ChatFilter): ChatFilter {
  return chips.some((c) => c.key === filter) ? filter : "all";
}

/** A `chat` frame arrived for the attached session: count it unless that chat is open. */
export function chatUnread(
  unread: Record<string, number>,
  attachedId: string | null,
  openId: string | null,
): Record<string, number> {
  if (!attachedId || attachedId === openId) return unread;
  return { ...unread, [attachedId]: (unread[attachedId] ?? 0) + 1 };
}
