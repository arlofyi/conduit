/**
 * Session controls on the phone: the `sessionOptions` answer read defensively, the composer's
 * slash suggestions, and the effort indicator. Pure, so the filtering and parsing are tested.
 */

export interface ModelOption {
  id: string;
  label: string;
}
export type CommandKind = "builtin" | "command" | "skill";
export interface CommandOption {
  name: string;
  description: string;
  kind: CommandKind;
}
export interface McpOption {
  name: string;
  source: string;
  enabled: boolean;
}
export interface SessionOptions {
  sessionId: string;
  agent: string;
  model: string | null;
  effort: string | null;
  keepRunning: boolean;
  modelLive: boolean;
  models: ModelOption[];
  efforts: string[];
  commands: CommandOption[];
  mcps: McpOption[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A command name without its leading slash (the desktop may send either). */
export function bareName(name: string): string {
  return name.replace(/^\/+/, "").trim();
}

/** The `sessionOptions` frame, or null when it is not one. Malformed entries are dropped. */
export function parseSessionOptions(m: unknown): SessionOptions | null {
  const f = m as Record<string, unknown> | null;
  if (!f || f.type !== "sessionOptions" || typeof f.sessionId !== "string") return null;
  const models = arr(f.models).flatMap((x): ModelOption[] => {
    if (typeof x === "string") return x ? [{ id: x, label: x }] : [];
    const o = x as { id?: unknown; label?: unknown } | null;
    const id = str(o?.id);
    return id ? [{ id, label: str(o?.label) ?? id }] : [];
  });
  const seen = new Set<string>();
  const commands = arr(f.commands).flatMap((x): CommandOption[] => {
    const o = x as { name?: unknown; description?: unknown; kind?: unknown } | null;
    const raw = str(o?.name);
    const name = raw ? bareName(raw) : "";
    if (!name || /\s/.test(name) || seen.has(name)) return [];
    seen.add(name);
    const kind: CommandKind = o?.kind === "skill" || o?.kind === "command" ? o.kind : "builtin";
    return [{ name, description: str(o?.description) ?? "", kind }];
  });
  const mcps = arr(f.mcps).flatMap((x): McpOption[] => {
    const o = x as { name?: unknown; source?: unknown; enabled?: unknown } | null;
    const name = str(o?.name);
    return name ? [{ name, source: str(o?.source) ?? "", enabled: o?.enabled !== false }] : [];
  });
  return {
    sessionId: f.sessionId,
    agent: str(f.agent) ?? "",
    model: str(f.model),
    effort: str(f.effort),
    keepRunning: f.keepRunning === true,
    modelLive: f.modelLive === true,
    models,
    efforts: arr(f.efforts).filter((e): e is string => typeof e === "string" && e.length > 0),
    commands,
    mcps,
  };
}

/**
 * What the composer is completing: the text after a leading `/` while no space has been typed
 * yet (`/com` -> "com", `/` -> ""); null once there is an argument or no slash at all.
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const rest = draft.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

/**
 * Commands matching `query`, best first: name prefix, then a name containing it, then a
 * description containing it. Ties keep the desktop's order. An empty query lists everything.
 */
export function filterCommands(commands: readonly CommandOption[], query: string, limit = Infinity): CommandOption[] {
  const q = bareName(query).toLowerCase();
  if (!q) return commands.slice(0, limit);
  const rank = (c: CommandOption): number => {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    if (c.description.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return commands
    .map((c, i) => ({ c, i, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}

/** The composer's suggestions for a draft: none unless it is a bare `/token`, and none once the
 * token already names a command exactly (the user finished typing it). */
export function slashSuggestions(draft: string, commands: readonly CommandOption[], limit = 6): CommandOption[] {
  const q = slashQuery(draft);
  if (q === null || commands.length === 0) return [];
  const hits = filterCommands(commands, q, limit);
  if (hits.length === 1 && hits[0].name.toLowerCase() === q.toLowerCase()) return [];
  return hits;
}

/** The draft after choosing a command: `/name ` replaces a partial `/token`, and goes in front
 * of anything else already typed (so the words become its argument). */
export function insertCommand(draft: string, name: string): string {
  const cmd = `/${bareName(name)} `;
  if (draft.trim() === "" || slashQuery(draft) !== null) return cmd;
  return cmd + draft.replace(/^\s+/, "");
}

/** Built-ins that take no argument and just act, so the sheet can offer "Run now". */
const RUN_NOW = new Set(["compact", "clear", "cost", "context", "init", "review"]);
export function canRunNow(c: CommandOption): boolean {
  return c.kind === "builtin" && RUN_NOW.has(c.name);
}

/** A row's kind as a short tag. */
export function kindTag(kind: CommandKind): string {
  return kind === "skill" ? "skill" : kind === "command" ? "custom" : "built-in";
}

const EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The effort indicator: how many of `steps` bars to fill. Placed by its index in the agent's own
 * list when it is in it, else on the common ladder; null when there is no effort to show.
 */
export function effortLevel(effort: string | null | undefined, efforts: readonly string[] = [], steps = 5): { filled: number; steps: number } | null {
  if (!effort) return null;
  const e = effort.toLowerCase();
  const own = efforts.map((x) => x.toLowerCase());
  let i = own.indexOf(e);
  let n = own.length;
  if (i < 0) {
    i = EFFORT_LADDER.indexOf(e);
    n = EFFORT_LADDER.length;
  }
  if (i < 0) return { filled: Math.ceil(steps / 2), steps };
  const filled = n <= 1 ? steps : Math.max(1, Math.round(((i + 1) / n) * steps));
  return { filled: Math.min(steps, filled), steps };
}

/** "xhigh" -> "Extra high"; others capitalised. */
export function effortName(effort: string): string {
  if (effort.toLowerCase() === "xhigh") return "Extra high";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export const MAX_NAME = 40;

/** A rename's text, or null when there is nothing to send (blank, or unchanged). */
export function renameValue(typed: string, current: string): string | null {
  const v = typed.trim().slice(0, MAX_NAME);
  return v && v !== current ? v : null;
}

/** The composer's suggestion rows for a draft (the shape `Composer`'s `suggest` takes). */
export function composerSuggestions(
  draft: string,
  commands: readonly CommandOption[],
): { key: string; label: string; detail?: string; insert: string }[] {
  return slashSuggestions(draft, commands).map((c) => ({
    key: c.name,
    label: `/${c.name}`,
    detail: c.description ? `${kindTag(c.kind)} · ${c.description}` : kindTag(c.kind),
    insert: insertCommand(draft, c.name),
  }));
}
