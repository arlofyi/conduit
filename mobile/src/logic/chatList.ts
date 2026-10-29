/**
 * The Chats list, as pure functions over the desktop's typed `projects` view
 * (src-tauri/src/bridge_view.rs is the authority for its shape). The screen only renders
 * what these return, so the ordering, filtering and counting rules are tested here.
 */
import type { WireProjectsView, WireViewProject, WireViewSession } from "../bridge/protocol";
import { accentFor } from "./accent";

/** Profile selection meaning "every profile". Desktop profile ids are uuids; this cannot collide. */
export const ALL_PROFILES = "*all-profiles*";

/** A profile id from the view (`null` = the Default profile), or ALL_PROFILES. */
export type ProfileSel = string | null;

/** "needs" (flat), "all" (grouped by project) or a project id (flat). */
export type ChatFilter = "needs" | "all" | string;

export type Dot = "needs" | "running" | "idle";

export interface Preview {
  tone: "needs" | "running" | "plain" | "private";
  /** bold lead-in on a needs row, e.g. "Asks:" */
  prefix: string | null;
  text: string;
}

export interface Row {
  id: string;
  projectId: string;
  title: string;
  branch: string | null;
  initials: string;
  color: string;
  dot: Dot;
  needs: boolean;
  time: string;
  preview: Preview;
  unread: number;
  /** silo / local-only sessions are listed but never opened from the phone */
  openable: boolean;
}

export interface Section {
  /** project id, or "flat" for an ungrouped list */
  key: string;
  /** project header; null for a flat list */
  title: string | null;
  color: string | null;
  count: number;
  rows: Row[];
}

export interface Chip {
  key: ChatFilter;
  label: string;
  /** project swatch; null for Needs you / All */
  color: string | null;
}

export interface ProfileEntry {
  id: ProfileSel;
  name: string;
  /** projects with at least one session */
  projects: number;
  needs: number;
}

/** Two-letter avatar per desktop agent id (src/agents.ts lists the seven). */
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

const RANK: Record<Dot, number> = { needs: 0, running: 1, idle: 2 };

function inProfile(p: WireViewProject, profileId: ProfileSel): boolean {
  return profileId === ALL_PROFILES || (p.profileId ?? null) === profileId;
}

export function previewFor(s: WireViewSession): Preview {
  if (s.silo) return { tone: "private", prefix: null, text: "Private session" };
  if (s.needs?.kind === "ask") {
    return s.needs.text
      ? { tone: "needs", prefix: "Asks:", text: s.needs.text }
      : { tone: "needs", prefix: null, text: "Asks you a question" };
  }
  if (isNeeds(s)) return { tone: "needs", prefix: null, text: "Needs your input" };
  if (s.status === "running") return { tone: "running", prefix: null, text: s.activity ? `${s.activity}…` : "working…" };
  if (s.status === "done") return { tone: "plain", prefix: null, text: "Finished" };
  if (s.stopped) return { tone: "plain", prefix: null, text: "Stopped" };
  return { tone: "plain", prefix: null, text: s.branch ?? "" };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** WhatsApp-style age: now · N min · N h · Yesterday · N d · N w. Empty when unknown. */
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

function rowFor(p: WireViewProject, s: WireViewSession, unread: Record<string, number>, now: number): Row {
  const needs = isNeeds(s);
  return {
    id: s.id,
    projectId: p.id,
    title: s.name,
    branch: s.branch,
    initials: agentInitials(s.agent),
    color: accentFor(p),
    dot: dotFor(s),
    needs,
    time: relativeTime(s.updatedAt, now),
    preview: previewFor(s),
    unread: unread[s.id] ?? 0,
    openable: !s.silo,
  };
}

function compare(a: { row: Row; at: number | null }, b: { row: Row; at: number | null }): number {
  const r = RANK[a.row.dot] - RANK[b.row.dot];
  if (r !== 0) return r;
  return (b.at ?? -Infinity) - (a.at ?? -Infinity);
}

export function buildRows(
  view: WireProjectsView,
  opts: { profileId: ProfileSel; filter: ChatFilter; unread: Record<string, number>; now: number },
): Section[] {
  const { profileId, filter, unread, now } = opts;
  const items: { row: Row; at: number | null; project: WireViewProject }[] = [];
  for (const p of view.projects) {
    if (!inProfile(p, profileId)) continue;
    if (filter !== "needs" && filter !== "all" && p.id !== filter) continue;
    for (const s of p.sessions) {
      if (filter === "needs" && !isNeeds(s)) continue;
      items.push({ row: rowFor(p, s, unread, now), at: s.updatedAt, project: p });
    }
  }
  // Stable sort: equal rank and time keep the desktop's order.
  items.sort(compare);
  if (items.length === 0) return [];
  if (filter !== "all") {
    return [{ key: "flat", title: null, color: null, count: items.length, rows: items.map((i) => i.row) }];
  }
  // Grouped: a project's section sits where its most urgent row would.
  const sections = new Map<string, Section>();
  for (const { row, project } of items) {
    let sec = sections.get(project.id);
    if (!sec) {
      sec = { key: project.id, title: project.name, color: accentFor(project), count: 0, rows: [] };
      sections.set(project.id, sec);
    }
    sec.rows.push(row);
    sec.count++;
  }
  return [...sections.values()];
}

export function chipsFor(view: WireProjectsView, profileId: ProfileSel): Chip[] {
  const projects = view.projects.filter((p) => inProfile(p, profileId) && p.sessions.length > 0);
  const needs = projects.reduce((n, p) => n + p.sessions.filter(isNeeds).length, 0);
  return [
    { key: "needs", label: `Needs you ${needs}`, color: null },
    { key: "all", label: "All", color: null },
    ...projects.map((p) => ({ key: p.id, label: p.name, color: accentFor(p) })),
  ];
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
  for (const s of sessionsById(next).values()) {
    let n = unread[s.id] ?? 0;
    const old = before?.get(s.id);
    if (old && s.id !== openId && !s.silo) {
      const newlyNeeds = isNeeds(s) && !isNeeds(old);
      const finished = old.status === "running" && (s.status === "done" || s.status === "idle") && !isNeeds(s);
      if (newlyNeeds || finished) n++;
    }
    if (n > 0) out[s.id] = n;
  }
  return out;
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
