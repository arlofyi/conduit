/**
 * The Chats tab (route `General`): the computer's root chat (HQ), a non-coding chat that looks across the
 * user's projects. Pure rules for the list, the scope picker and each chat's feed, so the
 * screens only draw what these return.
 *
 * A chat is LISTED under one profile (`profileId`) and SEES the projects its scope names:
 * whole profiles, single projects, or everything (`allProfiles`, or a null scope on chats
 * made before scopes existed).
 */
import { appendWire, mapHistory } from "../bridge/live";
import type { WireChatItem, WireProjectsView, WireRootChat, WireRootChatEvent, WireRootChatSettings, WireScope } from "../bridge/protocol";
import type { ChatItem } from "../data/types";
import { ALL_PROFILES, type ProfileSel } from "./chatList";
import { capFeed, genId } from "./feed";

export type Scope = WireScope;
export type RootChat = WireRootChat;

export const SCOPE_EXPLAINER = "The chat can only see and read the projects you attach here.";
export const EMPTY_CHAT_INFO = "Ask anything across your projects. Proposed work still needs your approval on your computer.";
/** Antigravity chats have no Conduit tools: nothing to propose, so nothing to approve. */
export const EMPTY_CHAT_INFO_AGY = "Ask anything across your projects. This chat can read them, but it can't start work on your computer.";

/** A chat with nothing attached (every new chat): it knows none of the user's projects yet. */
export const EMPTY_CHAT_INFO_UNATTACHED =
  "Ask anything. This chat doesn't know about your projects yet: attach a profile or projects from the line under its title.";

/** Nothing attached: not every project (null / all), and no profile or project named. */
export function isUnattached(scope: Scope | null | undefined): boolean {
  return !!scope && !scope.allProfiles && scope.profiles.length === 0 && scope.projects.length === 0;
}

/** The empty-chat note for a chat's agent (and, when given, what it has attached). */
export function emptyChatInfo(agent: string | undefined, scope?: Scope | null): string {
  if (isUnattached(scope)) return EMPTY_CHAT_INFO_UNATTACHED;
  return agent === "antigravity" ? EMPTY_CHAT_INFO_AGY : EMPTY_CHAT_INFO;
}

// ---- default scope + listing ----

/** The scope a new chat starts with: the selected profile, or everything under ALL_PROFILES. */
export function defaultScope(sel: ProfileSel): Scope {
  return sel === ALL_PROFILES ? { allProfiles: true, profiles: [], projects: [] } : { allProfiles: false, profiles: [sel], projects: [] };
}

/** The profile a new chat is listed under: the selected one, or the computer's active profile
 * when the phone shows every profile. */
export function createProfileId(sel: ProfileSel, view: WireProjectsView | null): string | null {
  if (sel !== ALL_PROFILES) return sel;
  return view?.activeProfileId ?? null;
}

/** A profile id the computer no longer has reads as Default (same rule as the Chats list). */
function knownProfile(id: string | null, view: WireProjectsView | null): string | null {
  if (id === null || !view) return id;
  return view.profiles.some((p) => p.id === id) ? id : null;
}

/** The chats listed under `sel` (every chat under ALL_PROFILES), newest first. */
export function chatsForProfile(chats: readonly RootChat[], sel: ProfileSel, view: WireProjectsView | null): RootChat[] {
  return chats
    .filter((c) => sel === ALL_PROFILES || knownProfile(c.profileId ?? null, view) === sel)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ---- scope text + picker ----

function profileLabel(view: WireProjectsView | null, id: string | null): string {
  return view?.profiles.find((p) => p.id === id)?.name ?? "Default";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The chip in a chat's header: "Work profile", "All projects", "2 profiles, 1 project". */
export function scopeSummary(scope: Scope | null, view: WireProjectsView | null): string {
  if (!scope || scope.allProfiles) return "All projects";
  const profiles = unique(scope.profiles);
  const projects = unique(scope.projects);
  if (profiles.length === 0 && projects.length === 0) return "No projects attached";
  if (profiles.length === 1 && projects.length === 0) return `${profileLabel(view, profiles[0])} profile`;
  if (profiles.length === 0 && projects.length === 1) {
    return view?.projects.find((p) => p.id === projects[0])?.name ?? "1 project";
  }
  const parts: string[] = [];
  if (profiles.length > 0) parts.push(plural(profiles.length, "profile"));
  if (projects.length > 0) parts.push(plural(projects.length, "project"));
  return parts.join(", ");
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/** A null (legacy) scope as the picker edits it: everything. */
export function editableScope(scope: Scope | null): Scope {
  if (!scope) return defaultScope(ALL_PROFILES);
  return { allProfiles: scope.allProfiles === true, profiles: unique(scope.profiles ?? []), projects: unique(scope.projects ?? []) };
}

export function setAllProfiles(scope: Scope, on: boolean): Scope {
  return { ...scope, allProfiles: on };
}

export function toggleProfile(scope: Scope, id: string | null): Scope {
  const has = scope.profiles.includes(id);
  return { ...scope, profiles: has ? scope.profiles.filter((p) => p !== id) : [...scope.profiles, id] };
}

export function toggleProject(scope: Scope, id: string): Scope {
  const has = scope.projects.includes(id);
  return { ...scope, projects: has ? scope.projects.filter((p) => p !== id) : [...scope.projects, id] };
}

/** Is a project covered by the scope, and how: by its whole profile (or everything), or by
 * being picked on its own. The picker shows a covered-by-profile project as checked and fixed. */
export function projectCover(scope: Scope, projectId: string, profileId: string | null, view: WireProjectsView | null): "profile" | "project" | null {
  if (scope.allProfiles) return "profile";
  if (scope.profiles.includes(knownProfile(profileId, view))) return "profile";
  return scope.projects.includes(projectId) ? "project" : null;
}

export interface ScopeGroup {
  profileId: string | null;
  name: string;
  projects: { id: string; name: string }[];
}

/** The picker's sections: every profile, its projects beneath it (by name). */
export function scopeGroups(view: WireProjectsView): ScopeGroup[] {
  const groups: ScopeGroup[] = view.profiles.map((p) => ({ profileId: p.id, name: p.name, projects: [] }));
  if (!groups.some((g) => g.profileId === null)) groups.unshift({ profileId: null, name: "Default", projects: [] });
  for (const p of view.projects) {
    const id = knownProfile(p.profileId ?? null, view);
    groups.find((g) => g.profileId === id)?.projects.push({ id: p.id, name: p.name });
  }
  for (const g of groups) g.projects.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

/** Same scope? (order and duplicates do not matter) */
export function sameScope(a: Scope | null, b: Scope | null): boolean {
  if (!a || !b) return a === b;
  const set = (xs: readonly (string | null)[]) => [...new Set(xs)].map(String).sort().join("\u0000");
  return a.allProfiles === b.allProfiles && set(a.profiles) === set(b.profiles) && set(a.projects) === set(b.projects);
}

// ---- one chat's feed ----

export interface RootFeed {
  feed: ChatItem[];
  running: boolean;
  /** history has arrived */
  loaded: boolean;
  /** texts this phone sent whose `user` echo has not arrived yet (already shown optimistically) */
  echo: string[];
  /** the reader pressed Stop: the turn's failure that follows is expected, not news */
  stopping: boolean;
}

export const EMPTY_FEED: RootFeed = { feed: [], running: false, loaded: false, echo: [], stopping: false };

export type FeedEvent =
  | { t: "history"; items: WireChatItem[]; running: boolean }
  | { t: "send"; text: string; id?: string }
  | { t: "stop"; id?: string }
  | { t: "event"; ev: WireRootChatEvent };

function notice(text: string, detail?: string): ChatItem {
  return { kind: "notice", id: genId("rn"), tone: "bad", text, ...(detail ? { detail } : {}) };
}

function bubble(text: string, id = genId("ru")): ChatItem {
  return { kind: "bubble", id, role: "user", text };
}

/** One chat's feed after an event. Pure; returns `s` itself when nothing changed. */
export function applyFeed(s: RootFeed, e: FeedEvent): RootFeed {
  switch (e.t) {
    case "history":
      return { feed: capFeed(mapHistory(e.items)), running: e.running, loaded: true, echo: [], stopping: false };
    case "send": {
      const text = e.text.trim();
      if (!text) return s;
      return { ...s, feed: capFeed([...s.feed, bubble(text, e.id)]), echo: [...s.echo, text], running: true, stopping: false };
    }
    case "stop":
      if (!s.running) return s;
      return {
        ...s,
        running: false,
        stopping: true,
        feed: capFeed([...s.feed, { kind: "divider", id: e.id ?? genId("rs"), label: "Stopped by you", tone: "warning", at: new Date().toISOString() }]),
      };
    case "event": {
      const ev = e.ev;
      switch (ev.event) {
        case "user": {
          const text = (ev.text ?? "").trim();
          const i = s.echo.indexOf(text);
          if (i >= 0) return { ...s, echo: [...s.echo.slice(0, i), ...s.echo.slice(i + 1)], running: true };
          return { ...s, feed: capFeed([...s.feed, bubble(text)]), running: true, stopping: false };
        }
        case "item": {
          const feed = capFeed(appendWire(s.feed, ev.item));
          return feed === s.feed ? s : { ...s, feed };
        }
        case "done": {
          if (s.stopping) return { ...s, running: false, stopping: false, echo: [] };
          const failed = ev.isError ? [notice("The turn failed", ev.result ?? undefined)] : [];
          return { ...s, running: false, echo: [], feed: failed.length ? capFeed([...s.feed, ...failed]) : s.feed };
        }
        case "error":
          if (s.stopping) return { ...s, running: false, stopping: false, echo: [] };
          return { ...s, running: false, echo: [], feed: capFeed([...s.feed, notice(ev.message || "Your computer couldn't run that.")]) };
      }
    }
  }
  return s;
}

/** The list after an event: a turn starting or ending moves that chat's running dot.
 * Returns `chats` itself when nothing changed. */
export function applyToList(chats: RootChat[] | null, ev: WireRootChatEvent): RootChat[] | null {
  if (!chats || ev.event === "item") return chats;
  const running = ev.event === "user";
  let changed = false;
  const next = chats.map((c) => {
    if (c.id !== ev.chatId || c.running === running) return c;
    changed = true;
    return { ...c, running };
  });
  return changed ? next : chats;
}

/** Defensive read of a pushed chat (every field optional on the wire). */
export function chatOf(v: unknown): RootChat | null {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c.id !== "string") return null;
  const scope = c.scope as Scope | null | undefined;
  return {
    id: c.id,
    title: typeof c.title === "string" && c.title ? c.title : "New Chat",
    profileId: typeof c.profileId === "string" ? c.profileId : null,
    scope: scope && typeof scope === "object" ? editableScope(scope) : null,
    createdAt: typeof c.createdAt === "number" ? c.createdAt : 0,
    running: c.running === true,
    agent: typeof c.agent === "string" && c.agent ? c.agent : "claude",
    model: typeof c.model === "string" && c.model ? c.model : null,
    effort: typeof c.effort === "string" && c.effort ? c.effort : null,
    research: c.research === true,
    mcps: Array.isArray(c.mcps) ? unique(c.mcps.filter((m): m is string => typeof m === "string")) : [],
  };
}

// ---- chat options: agent, model, effort, deep research, MCP servers ----

export interface AgentOption {
  id: string;
  label: string;
  models: { id: string; label: string }[];
  efforts: string[];
}

export interface RootChatOptions {
  agents: AgentOption[];
  skills: { name: string; description: string }[];
  mcps: { name: string }[];
  /** false: the computer did not answer `rootchatoptions` (an older desktop); Claude only */
  live: boolean;
}

/** What an older desktop (no `rootchatoptions`) can run: Claude, on its defaults. */
export const FALLBACK_OPTIONS: RootChatOptions = {
  agents: [{ id: "claude", label: "Claude", models: [], efforts: [] }],
  skills: [],
  mcps: [],
  live: false,
};

export const MCP_EXPLAINER =
  "MCP servers give the chat their tools (a GitHub server lets it read issues, for example). Only the ones you tick are loaded.";
export const RESEARCH_EXPLAINER = "Thinks longer, searches widely, reads its sources and cites them. Slower.";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** Defensive read of a `rootChatOptions` frame; null when it names no usable agent. */
export function optionsOf(v: unknown): RootChatOptions | null {
  const o = v as Record<string, unknown> | null;
  if (!o || !Array.isArray(o.agents)) return null;
  const agents: AgentOption[] = [];
  for (const a of o.agents as Record<string, unknown>[]) {
    const id = str(a?.id);
    if (!id || agents.some((x) => x.id === id)) continue;
    const models = Array.isArray(a.models)
      ? (a.models as Record<string, unknown>[]).flatMap((m) => {
          const mid = str(m?.id);
          return mid ? [{ id: mid, label: str(m.label) ?? mid }] : [];
        })
      : [];
    const efforts = Array.isArray(a.efforts) ? unique((a.efforts as unknown[]).filter((e): e is string => str(e) !== null)) : [];
    agents.push({ id, label: str(a.label) ?? id, models, efforts });
  }
  if (agents.length === 0) return null;
  const skills = Array.isArray(o.skills)
    ? (o.skills as Record<string, unknown>[]).flatMap((k) => {
        const name = str(k?.name)?.replace(/^\//, "");
        return name ? [{ name, description: str(k.description) ?? "" }] : [];
      })
    : [];
  const mcps = Array.isArray(o.mcps)
    ? unique((o.mcps as Record<string, unknown>[]).map((m) => str(m?.name)).filter((n): n is string => n !== null)).map((name) => ({ name }))
    : [];
  return { agents, skills, mcps, live: true };
}

/** A chat's options as the forms edit them. null model/effort = the agent's default. */
export interface ChatSettings {
  agent: string;
  model: string | null;
  effort: string | null;
  research: boolean;
  mcps: string[];
}

export function agentOption(opts: RootChatOptions, agent: string): AgentOption | null {
  return opts.agents.find((a) => a.id === agent) ?? null;
}

/** A new chat's options: Claude when offered (else the first agent), on its defaults. */
export function defaultSettings(opts: RootChatOptions): ChatSettings {
  const agent = agentOption(opts, "claude")?.id ?? opts.agents[0]?.id ?? "claude";
  return { agent, model: null, effort: null, research: false, mcps: [] };
}

/** The options a chat has now. */
export function settingsOf(chat: RootChat): ChatSettings {
  return {
    agent: chat.agent ?? "claude",
    model: chat.model ?? null,
    effort: chat.effort ?? null,
    research: chat.research === true,
    mcps: unique(chat.mcps ?? []),
  };
}

/** Another agent: a model or effort the new agent does not offer goes back to its default. */
export function pickAgent(s: ChatSettings, opts: RootChatOptions, agent: string): ChatSettings {
  const a = agentOption(opts, agent);
  return {
    ...s,
    agent,
    model: a && s.model !== null && a.models.some((m) => m.id === s.model) ? s.model : null,
    effort: a && s.effort !== null && a.efforts.includes(s.effort) ? s.effort : null,
  };
}

export function toggleMcp(s: ChatSettings, name: string): ChatSettings {
  return { ...s, mcps: s.mcps.includes(name) ? s.mcps.filter((m) => m !== name) : [...s.mcps, name] };
}

/** The `rootchatcreate` options: the agent, plus only what differs from the computer's defaults. */
export function createSettings(s: ChatSettings): WireRootChatSettings {
  return {
    agent: s.agent,
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.research ? { research: true } : {}),
    ...(s.mcps.length ? { mcps: unique(s.mcps) } : {}),
  };
}

/** The `rootchatsettings` patch: only the fields that changed ("" = back to the default), or
 * null when nothing did. The agent is fixed per chat and never sent. */
export function settingsPatch(before: ChatSettings, after: ChatSettings): Omit<WireRootChatSettings, "agent"> | null {
  const patch: Omit<WireRootChatSettings, "agent"> = {};
  if (before.model !== after.model) patch.model = after.model ?? "";
  if (before.effort !== after.effort) patch.effort = after.effort ?? "";
  if (before.research !== after.research) patch.research = after.research;
  const set = (xs: string[]) => [...new Set(xs)].sort().join("\u0000");
  if (set(before.mcps) !== set(after.mcps)) patch.mcps = unique(after.mcps);
  return Object.keys(patch).length ? patch : null;
}

export function agentLabel(opts: RootChatOptions | null, agent: string): string {
  const known = opts ? agentOption(opts, agent)?.label : null;
  if (known) return known;
  return agent === "antigravity" ? "Antigravity" : agent === "claude" ? "Claude" : agent;
}

export function modelName(opts: RootChatOptions | null, agent: string, model: string | null): string {
  if (!model) return "Default model";
  return (opts ? agentOption(opts, agent)?.models.find((m) => m.id === model)?.label : null) ?? model;
}

/** The line under a chat's title: "Claude · Opus 4.6 · high effort · Deep research". */
export function chatBadge(chat: RootChat, opts: RootChatOptions | null): string {
  const s = settingsOf(chat);
  const parts = [agentLabel(opts, s.agent)];
  if (s.model) parts.push(modelName(opts, s.agent, s.model));
  if (s.effort) parts.push(`${s.effort} effort`);
  if (s.research) parts.push("Deep research");
  return parts.join(" · ");
}

// ---- new chat: agent only; attach projects later ----

/** What a new chat sees: nothing. The user attaches profiles or projects from its settings,
 * and the chat knows about them from the next message on. */
export const NEW_CHAT_SCOPE: Scope = { allProfiles: false, profiles: [], projects: [] };

export const ATTACH_EXPLAINER = "The chat only knows about what you attach. Changes apply from your next message.";

/** The agents "+" offers, in the computer's order; Claude alone when the options never came. */
export function startAgents(opts: RootChatOptions | null): AgentOption[] {
  return opts && opts.agents.length > 0 ? opts.agents : FALLBACK_OPTIONS.agents;
}

/** The agent pre-selected in the chooser: the one picked last time if still offered, else
 * Claude when offered, else the first. */
export function preferredAgent(opts: RootChatOptions | null, remembered: string | null): string {
  const agents = startAgents(opts);
  if (remembered && agents.some((a) => a.id === remembered)) return remembered;
  return agents.find((a) => a.id === "claude")?.id ?? agents[0].id;
}

/** "+" skips the chooser when there is nothing to choose. */
export function needsAgentChoice(opts: RootChatOptions | null): boolean {
  return startAgents(opts).length > 1;
}

/** The `rootchatcreate` options for a chat started on `agent` (computer defaults for the rest);
 * undefined for an older desktop, which takes no options. */
export function startSettings(opts: RootChatOptions | null, agent: string): WireRootChatSettings | undefined {
  return opts?.live ? { agent } : undefined;
}

// ---- attached profiles / projects ----

/** One thing attached to a chat, as a removable chip. */
export type AttachedItem =
  | { kind: "all"; key: string; label: string }
  | { kind: "profile"; key: string; label: string; profileId: string | null }
  | { kind: "project"; key: string; label: string; projectId: string };

/** The chips of the Attached section: everything, each whole profile, each single project. */
export function attachedItems(scope: Scope | null, view: WireProjectsView | null): AttachedItem[] {
  if (!scope || scope.allProfiles) return [{ kind: "all", key: "all", label: "All projects" }];
  const items: AttachedItem[] = [];
  for (const id of unique(scope.profiles)) {
    items.push({ kind: "profile", key: `profile:${id ?? ""}`, label: `${profileLabel(view, id)} profile`, profileId: id });
  }
  for (const id of unique(scope.projects)) {
    items.push({ kind: "project", key: `project:${id}`, label: view?.projects.find((p) => p.id === id)?.name ?? "Removed project", projectId: id });
  }
  return items;
}

/** The scope with one chip removed. Detaching "All projects" leaves nothing attached. */
export function detach(scope: Scope | null, item: AttachedItem): Scope {
  const s = editableScope(scope);
  switch (item.kind) {
    case "all":
      return { ...NEW_CHAT_SCOPE };
    case "profile":
      return { ...s, profiles: s.profiles.filter((p) => p !== item.profileId) };
    case "project":
      return { ...s, projects: s.projects.filter((p) => p !== item.projectId) };
  }
}

/** How many of the computer's projects the scope covers. */
export function attachedCount(scope: Scope | null, view: WireProjectsView | null): number {
  if (!view) return 0;
  const s = editableScope(scope);
  return view.projects.filter((p) => projectCover(s, p.id, p.profileId ?? null, view) !== null).length;
}

/** The header's at-a-glance line: "No projects attached", "Arlo · 3 projects", "Home",
 * "2 profiles · 5 projects", "All projects". */
export function attachedSummary(scope: Scope | null, view: WireProjectsView | null): string {
  if (!scope || scope.allProfiles) return "All projects";
  const profiles = unique(scope.profiles);
  const projects = unique(scope.projects);
  if (profiles.length === 0 && projects.length === 0) return "No projects attached";
  if (profiles.length === 0 && projects.length === 1) {
    return view?.projects.find((p) => p.id === projects[0])?.name ?? "1 project";
  }
  const n = view ? attachedCount(scope, view) : projects.length;
  const count = plural(n, "project");
  if (profiles.length === 1) return `${profileLabel(view, profiles[0])} · ${count}`;
  if (profiles.length > 1) return `${plural(profiles.length, "profile")} · ${count}`;
  return count;
}

// ---- skills in the composer ----

const MAX_SUGGESTIONS = 8;

/** Skills offered while the message is a bare `/word` at its very start; [] otherwise. */
export function skillSuggestions(
  draft: string,
  skills: readonly { name: string; description: string }[],
): { name: string; description: string }[] {
  const m = /^\/([^\s/]*)$/.exec(draft);
  if (!m) return [];
  const q = m[1].toLowerCase();
  const starts = skills.filter((k) => k.name.toLowerCase().startsWith(q));
  const contains = q ? skills.filter((k) => !k.name.toLowerCase().startsWith(q) && k.name.toLowerCase().includes(q)) : [];
  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
}

/** What tapping a skill leaves in the composer. */
export function insertSkill(name: string): string {
  return `/${name.replace(/^\//, "")} `;
}
