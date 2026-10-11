import { useMemo, useState, type ReactNode } from "react";
import { SessionAvatar } from "../avatars";
import type { GraphSnapshot } from "../continuityGraph";
import type { FeedDecision } from "../continuityFeed";
import {
  nodeKeyForAuthorLabel,
  nodeKeyForContinuityId,
  relativeTime,
  relativeUntil,
  isTaskDone,
  isTaskOpen,
  supersedeChain,
  type ActivityRow,
  type FileRow,
  type HandoffRow,
  type ServiceTab,
  type TaskRow,
} from "../continuityTables";
import type { TablesData } from "../hooks/useContinuityTables";
import type { NodeView } from "./ContinuityGraph";

type Ctx = {
  snap: GraphSnapshot;
  views: Record<string, NodeView>;
  now: number;
  onFocusNode: (key: string) => void;
};

/** A row's session, resolved to the graph's own name + avatar. A session that is not on the
 *  graph (outside the snapshot) is a neutral tile with its id's first two characters and is
 *  not clickable — there is nothing to focus. */
function Who({ nodeKey, raw, ctx, compact = false }: { nodeKey: string | null; raw: string; ctx: Ctx; compact?: boolean }) {
  const v = nodeKey ? ctx.views[nodeKey] : undefined;
  if (!nodeKey || !v) {
    return (
      <span className="ctable-who unknown" title={raw}>
        <span className="ctable-anon" aria-hidden="true">{raw.slice(0, 2)}</span>
        {!compact && <span className="ctable-who-name">{raw.length > 14 ? `${raw.slice(0, 13)}…` : raw}</span>}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="ctable-who"
      title={`Show ${v.name} on the graph`}
      aria-label={`Show ${v.name} on the graph`}
      onClick={() => ctx.onFocusNode(nodeKey)}
    >
      <SessionAvatar nodeKey={nodeKey} size={28} tone={v.tone} chipColor={v.chip} />
      {!compact && <span className="ctable-who-name">{v.name}</span>}
    </button>
  );
}

const byId = (id: string | undefined, ctx: Ctx) => (
  <Who nodeKey={id ? nodeKeyForContinuityId(id, ctx.snap) : null} raw={id ?? "—"} ctx={ctx} />
);

function Status({ s }: { s: string }) {
  return <span className={`ctable-status s-${s.replace(/[^a-z_]/gi, "")}`}>{s.replace(/_/g, " ")}</span>;
}

function When({ iso, now }: { iso: string; now: number }) {
  return (
    <time className="ctable-when" dateTime={iso} title={new Date(iso).toLocaleString()}>
      {relativeTime(iso, now)}
    </time>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="ctable">
      <thead>
        <tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** Consecutive repeats collapse: a decision superseded under its own key is "3 revisions",
 *  not `k → k → k`. */
function chainLabel(chain: string[], all: Map<string, FeedDecision>): string | null {
  if (chain.length < 2) return null;
  const keys: string[] = [];
  for (const id of chain) {
    const k = all.get(id)?.decisionKey ?? id;
    if (keys[keys.length - 1] !== k) keys.push(k);
  }
  return keys.length === 1 ? `${chain.length} revisions` : keys.join(" → ");
}

function Decisions({ rows, ctx }: { rows: FeedDecision[]; ctx: Ctx }) {
  const all = useMemo(() => new Map(rows.map((d) => [d.id, d])), [rows]);
  return (
    <Table head={["Key", "Type", "Status", "Author", "When", "Chain"]}>
      {rows.map((d) => {
        const chain = chainLabel(supersedeChain(rows, d.id), all);
        return (
          <tr key={d.id} className={d.status === "active" ? "" : "muted"}>
            <td className="ctable-main">
              <div className="ctable-key">{d.decisionKey}</div>
              <div className="ctable-sub" title={d.content}>{d.content.replace(/\s+/g, " ")}</div>
            </td>
            <td className="ctable-dim">{d.decisionType}</td>
            <td><Status s={d.status} /></td>
            <td>
              <Who nodeKey={nodeKeyForAuthorLabel(d.authorLabel, ctx.snap)} raw={d.authorLabel ?? "unknown"} ctx={ctx} />
            </td>
            <td><When iso={d.createdAt} now={ctx.now} /></td>
            <td className="ctable-chain">{chain ?? <span className="ctable-none">—</span>}</td>
          </tr>
        );
      })}
    </Table>
  );
}

function Handoffs({ rows, ctx }: { rows: HandoffRow[]; ctx: Ctx }) {
  return (
    <Table head={["From → To", "Status", "Context", "Next actions", "When"]}>
      {rows.map((h) => (
        <tr key={h.id}>
          <td>
            <span className="ctable-pair">
              {byId(h.from, ctx)}
              <span className="ctable-arrow" aria-hidden="true">→</span>
              <span className="visually-hidden">to</span>
              {h.to ? byId(h.to, ctx) : <span className="ctable-none">anyone</span>}
            </span>
          </td>
          <td><Status s={h.status} /></td>
          <td className="ctable-prose"><div className="ctable-clamp2" title={h.context}>{h.context}</div></td>
          <td className="ctable-prose">
            {h.nextActions ? (
              <div className="ctable-clamp2" title={h.nextActions}>{h.nextActions}</div>
            ) : (
              <span className="ctable-none">—</span>
            )}
          </td>
          <td><When iso={h.createdAt} now={ctx.now} /></td>
        </tr>
      ))}
    </Table>
  );
}

function Tasks({ rows, ctx }: { rows: TaskRow[]; ctx: Ctx }) {
  return (
    <Table head={["Issue", "Status", "Claimant", "PR", "Expires"]}>
      {rows.map((t) => {
        const open = isTaskOpen(t, ctx.now);
        const done = isTaskDone(t);
        return (
          <tr key={t.id} className={open ? "" : "muted"}>
            <td className="ctable-mono">
              <span className="ctable-dim">{t.repo}</span>#{t.issue}
            </td>
            <td><Status s={t.status} /></td>
            <td>{byId(t.claimant, ctx)}</td>
            <td className="ctable-mono">{t.pr != null ? `#${t.pr}` : <span className="ctable-none">—</span>}</td>
            <td className={`ctable-num ${!done && !open ? "warn" : ""}`}>
              {done ? <span className="ctable-none">—</span> : open ? relativeUntil(t.expiresAt, ctx.now) : "expired"}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

function Files({ rows, ctx }: { rows: FileRow[]; ctx: Ctx }) {
  return (
    <Table head={["Path", "Who", "Tool", "When"]}>
      {rows.map((f) => {
        const cut = f.path.lastIndexOf("/");
        return (
          <tr key={f.path} className={f.collision ? "collision" : ""}>
            <td className="ctable-mono ctable-path" title={f.path}>
              {cut >= 0 && <span className="ctable-dim">{f.path.slice(0, cut + 1)}</span>}
              {f.path.slice(cut + 1)}
              {f.collision && <span className="ctable-collide">{f.sessions.length} sessions</span>}
            </td>
            <td>
              <span className="ctable-stack">
                {f.sessions.map((s) => (
                  <Who key={s} nodeKey={nodeKeyForContinuityId(s, ctx.snap)} raw={s} ctx={ctx} compact={f.sessions.length > 1} />
                ))}
              </span>
            </td>
            <td className="ctable-dim">{f.tools.join(", ")}</td>
            <td><When iso={f.touchedAt} now={ctx.now} /></td>
          </tr>
        );
      })}
    </Table>
  );
}

function Activity({ rows, ctx }: { rows: ActivityRow[]; ctx: Ctx }) {
  const [only, setOnly] = useState<Set<string>>(() => new Set());
  const types = useMemo(() => [...new Set(rows.map((r) => r.type))].sort(), [rows]);
  // A filter for a type that has aged out of the page would hide everything with no chip
  // left to undo it.
  const active = new Set([...only].filter((t) => types.includes(t)));
  const shown = active.size ? rows.filter((r) => active.has(r.type)) : rows;
  const toggle = (t: string) =>
    setOnly((cur) => {
      const next = new Set(cur);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  return (
    <>
      {types.length > 1 && (
        <div className="ctable-filters" role="group" aria-label="Filter by event type">
          {types.map((t) => (
            <button
              key={t}
              type="button"
              className={`ctable-chip ${active.has(t) ? "on" : ""}`}
              aria-pressed={active.has(t)}
              onClick={() => toggle(t)}
            >
              {t}
            </button>
          ))}
          {active.size > 0 && (
            <button type="button" className="ctable-chip clear" onClick={() => setOnly(new Set())}>
              Show all
            </button>
          )}
        </div>
      )}
      <Table head={["When", "Type", "Who", "Payload"]}>
        {shown.map((a) => (
          <tr key={a.id}>
            <td><When iso={a.createdAt} now={ctx.now} /></td>
            <td><span className="ctable-type">{a.type}</span></td>
            <td>{byId(a.session, ctx)}</td>
            <td className="ctable-mono ctable-payload" title={a.payload}>
              {a.payload ?? <span className="ctable-none">—</span>}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}

/** One read-only service table. Rows come from `useContinuityTables` (owned by the view, so
 *  the tab strip's counts and the table share one read). */
export function ContinuityTables({
  tab,
  data,
  snap,
  views,
  now,
  onFocusNode,
}: {
  tab: ServiceTab;
  data: TablesData;
} & Ctx) {
  const ctx: Ctx = { snap, views, now, onFocusNode };
  const view = data[tab];
  let body: ReactNode;
  if (!view) body = <div className="ctable-state">Loading…</div>;
  else if (!view.available) body = <div className="ctable-state">Continuity isn't running for this project.</div>;
  else if (view.rows.length === 0) body = <div className="ctable-state">Nothing here yet.</div>;
  else {
    switch (tab) {
      case "decisions":
        body = <Decisions rows={view.rows as FeedDecision[]} ctx={ctx} />;
        break;
      case "handoffs":
        body = <Handoffs rows={view.rows as HandoffRow[]} ctx={ctx} />;
        break;
      case "tasks":
        body = <Tasks rows={view.rows as TaskRow[]} ctx={ctx} />;
        break;
      case "files":
        body = <Files rows={view.rows as FileRow[]} ctx={ctx} />;
        break;
      case "activity":
        body = <Activity rows={view.rows as ActivityRow[]} ctx={ctx} />;
        break;
    }
  }
  return (
    <div className={`ctable-wrap t-${tab}`} role="tabpanel" aria-labelledby={`continuity-tab-${tab}`}>
      {body}
    </div>
  );
}
