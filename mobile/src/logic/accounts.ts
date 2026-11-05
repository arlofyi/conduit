/**
 * Which agent account a session starts on, or is moved to, from the phone.
 *
 * The computer sends accounts as opaque refs plus their labels (`WireAccounts`); a session
 * carries its own pin (`accountRef`) and a project its per-agent default. Each option is
 * paired with that account's usage row, so the picker can say "Weekly limit reached · back
 * Fri 3 PM" BEFORE a session is started on a spent account -- the point of putting the two
 * together.
 */
import type { WireAccount, WireProjectsView } from "../bridge/protocol";
import { availability, type Availability, type UsageRow } from "./usage";

export interface AccountOption {
  /** "" = follow the project/global default */
  ref: string;
  /** what the chip reads */
  label: string;
  /** "Default · Arlo" spelled out for a screen reader / detail line */
  detail: string | null;
  availability: Availability;
}

/** The registered accounts signed in for `agent`. */
export function accountsFor(view: WireProjectsView | null, agent: string): WireAccount[] {
  return view?.accounts?.list.filter((a) => a.agents.includes(agent)) ?? [];
}

function rowByKey(rows: readonly UsageRow[] | null, key: string | undefined): UsageRow | null {
  if (!rows || !key) return null;
  return rows.find((r) => r.key === key) ?? null;
}

/**
 * The options for a session of `agent` in `projectId`: "Default" first (naming the account it
 * resolves to), then every account tagged for the agent. Empty when there is nothing to pick
 * between -- no registered account for this agent, or an older computer.
 */
export function accountOptions(
  view: WireProjectsView | null,
  projectId: string | null,
  agent: string,
  rows: readonly UsageRow[] | null,
): AccountOption[] {
  const list = accountsFor(view, agent);
  if (list.length === 0) return [];
  const project = view?.projects.find((p) => p.id === projectId) ?? null;
  const defRef = project?.defaultAccounts?.[agent];
  const def = defRef ? list.find((a) => a.ref === defRef) ?? null : null;
  const defKey = def ? def.usage[agent] : view?.accounts?.defaultUsage[agent];
  const opts: AccountOption[] = [
    {
      ref: "",
      label: def ? `Default · ${def.label}` : "Default",
      detail: def ? `The project's default account, ${def.label}` : "This computer's own sign-in",
      availability: availability(rowByKey(rows, defKey)),
    },
  ];
  for (const a of list) {
    opts.push({ ref: a.ref, label: a.label, detail: null, availability: availability(rowByKey(rows, a.usage[agent])) });
  }
  return opts;
}

/**
 * The option to preselect for a NEW session: the default, unless it is spent and another
 * account is usable now -- then the usable one, and the picker says why.
 */
export function suggestedAccount(opts: readonly AccountOption[]): string {
  const def = opts.find((o) => o.ref === "");
  if (!def || def.availability.state !== "blocked") return "";
  const usable = opts.find((o) => o.ref !== "" && (o.availability.state === "ok" || o.availability.state === "low"));
  return usable ? usable.ref : "";
}

/** The option a session is on now: its pin, else "" (the default). */
export function currentAccountRef(session: { accountRef?: string | null } | null | undefined): string {
  return session?.accountRef ?? "";
}
