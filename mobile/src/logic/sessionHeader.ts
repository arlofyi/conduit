/**
 * The chat header's two lines and its two gauges, and the session sheet's "what is it running
 * now" rows. Pure, so the fallbacks are tested:
 *
 * - `sessionOptions.model`/`effort` are the PINNED values (null when unpinned). The sheet shows
 *   the ACTIVE model: the pin, else the model the session is actually reporting; an unpinned
 *   effort reads "Default". Never a dash -- a dash read as "this session has no model".
 * - Line 2 is `project · status · model · effort bars [· auto-approve]`.
 * - The context ring around the avatar and the usage gauge both colour by CONSUMPTION
 *   (green, amber from 70 %, red from 90 %), the same ramp as every other meter.
 */
import { headerGauge, pct, severity, type Severity, type UsageRow } from "./usage";
import { modelLabel, type HeaderState } from "./chatHeader";
import { effortLevel, effortName, type ModelOption } from "./sessionOptions";

export const DEFAULT_TEXT = "Default";

const STATE_TEXT: Record<HeaderState, string> = {
  needs: "waiting on you",
  running: "working…",
  idle: "idle",
};

export const COMPACTING_TEXT = "compacting…";

export function stateText(state: HeaderState): string {
  return STATE_TEXT[state];
}

/**
 * The model a session runs on right now: the pinned id first (a switch made from the sheet
 * shows at once), else the live one (the transcript's, then the view's). `label` is what the
 * agent calls it when it listed it, else the family name ("Opus"), else the id; "Default" when
 * nothing is known.
 */
export function activeModel(a: {
  pinned: string | null | undefined;
  live: string | null | undefined;
  models?: readonly ModelOption[];
}): { id: string | null; label: string } {
  const id = a.pinned || a.live || null;
  if (!id) return { id: null, label: DEFAULT_TEXT };
  const listed = a.models?.find((m) => m.id === id)?.label;
  return { id, label: listed ?? modelLabel(id) ?? id };
}

/** The effort as the sheet names it: "Default" when the session pins none. */
export function effortText(effort: string | null | undefined): string {
  return effort ? effortName(effort) : DEFAULT_TEXT;
}

/** The header's effort glyph: signal bars, filled to the level; `isDefault` draws them outlined. */
export interface EffortIndicator {
  filled: number;
  steps: number;
  isDefault: boolean;
  label: string;
}

export function effortIndicator(effort: string | null | undefined, efforts: readonly string[] = [], steps = 5): EffortIndicator {
  const lvl = effortLevel(effort, efforts, steps);
  if (!lvl || !effort) return { filled: 0, steps, isDefault: true, label: `Effort ${DEFAULT_TEXT.toLowerCase()}` };
  return { filled: lvl.filled, steps: lvl.steps, isDefault: false, label: `Effort ${effortName(effort).toLowerCase()}` };
}

/** "deepseek/deepseek-v4-flash" -> "deepseek-v4-flash": the provider prefix costs width the header has not got. */
export function compactModel(label: string | null | undefined): string | null {
  if (!label) return null;
  const i = label.lastIndexOf("/");
  return i >= 0 && i < label.length - 1 ? label.slice(i + 1) : label;
}

/** The ring around the avatar: the context fraction used, coloured by how full it is. */
export interface ContextRing {
  fraction: number;
  tone: Severity;
  percent: number;
  a11y: string;
}

export function contextRing(fraction: number | null | undefined): ContextRing | null {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return null;
  const f = Math.min(1, Math.max(0, fraction));
  const percent = Math.round(f * 100);
  return { fraction: f, tone: severity(f), percent, a11y: `${percent}% of the context window used` };
}

/** The usage gauge beside the preferences button: the 5-hour window (else the week). */
export interface UsageBadge {
  used: number;
  percent: number;
  /** under the ring: which window it is ("5h" / "wk") */
  caption: string;
  tone: Severity;
  a11y: string;
}

export function usageBadge(row: UsageRow | null): UsageBadge | null {
  const g = headerGauge(row);
  if (!g) return null;
  const w = g.window;
  const five = w.kind === "fiveHour" || /5[\s-]?h/i.test(w.label);
  return { used: w.used, percent: pct(w.used), caption: five ? "5h" : "wk", tone: severity(w.used), a11y: g.a11y };
}

/** Line 2 of the header, and the whole header's spoken label. */
export interface HeaderMeta {
  project: string | null;
  status: string;
  model: string | null;
  effort: EffortIndicator;
  autoApprove: boolean;
  a11y: string;
}

export function headerMeta(a: {
  name: string;
  projectName: string | null;
  state: HeaderState;
  model: string | null;
  effort: string | null;
  efforts?: readonly string[];
  autoApprove?: boolean;
  context?: ContextRing | null;
  /** a `/compact` is running (PreCompact seen, no SessionStart yet): it can take a minute or
   * more, and "idle" over it read as "the computer ignored me" (founder report) */
  compacting?: boolean;
}): HeaderMeta {
  const status = a.compacting && a.state !== "needs" ? COMPACTING_TEXT : stateText(a.state);
  const model = compactModel(a.model);
  const effort = effortIndicator(a.effort, a.efforts ?? []);
  const auto = a.autoApprove === true;
  const spoken = [a.name, a.projectName, status, model ? `model ${model}` : null, effort.label];
  if (auto) spoken.push("auto-approve on");
  if (a.context) spoken.push(a.context.a11y);
  return {
    project: a.projectName,
    status,
    model,
    effort,
    autoApprove: auto,
    a11y: `${spoken.filter((x): x is string => !!x).join(", ")}. Session details`,
  };
}
