import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { AGENTS } from "../agents";
import { ChevronRightIcon } from "./Icons";
import { Badge, Button, ButtonRow, Notice, Segmented, SettingRow, SettingsSection } from "./ui";

type Field =
  | "contextDisplay" | "contextWarningTarget" | "contextHardCap" | "checkpointIntervalMinutes"
  | "fleetTotal" | "writersPerRepo" | "readers" | "critics" | "retryRounds"
  | "requireWriterWorktree" | "quotaPausePercent" | "frontChatAgent" | "conductorAgent"
  | "differentReviewProvider" | "requireReview" | "portabilityEnabled";
type Overlay = Partial<Record<Field, boolean | number | string | null>>;
interface PolicyView {
  defaults: Overlay;
  global: Overlay;
  project: Overlay;
  effective: Overlay;
  source: Record<string, "default" | "global" | "project">;
}
interface PolicyDocument { version: number; global: Overlay; projects: Record<string, Overlay> }
interface ImportPreview { current: PolicyDocument; proposed: PolicyDocument }

type Kind = "bool" | "number" | "agent";
interface FieldDef { key: Field; label: string; kind: Kind }

/** The one field that controls sessions today. */
const LIVE: FieldDef[] = [{ key: "contextDisplay", label: "Show context readings", kind: "bool" }];

/**
 * Saved now, enforced by a later phase. Grouped by the phase that will read them, so the
 * page says "Phase 3" once over its seven fields instead of seven times.
 */
const PLANNED: Array<{ phase: string; title: string; fields: FieldDef[] }> = [
  {
    phase: "Phase 2",
    title: "Context budget",
    fields: [
      { key: "contextWarningTarget", label: "Warning target (tokens)", kind: "number" },
      { key: "contextHardCap", label: "Hard cap (tokens)", kind: "number" },
      { key: "checkpointIntervalMinutes", label: "Checkpoint interval (minutes)", kind: "number" },
    ],
  },
  {
    phase: "Phase 3",
    title: "Fleet limits",
    fields: [
      { key: "fleetTotal", label: "Fleet total", kind: "number" },
      { key: "writersPerRepo", label: "Writers per repository", kind: "number" },
      { key: "readers", label: "Readers", kind: "number" },
      { key: "critics", label: "Critics", kind: "number" },
      { key: "retryRounds", label: "Failed rounds", kind: "number" },
      { key: "requireWriterWorktree", label: "Require writer worktree", kind: "bool" },
      { key: "quotaPausePercent", label: "Pause below quota (%)", kind: "number" },
    ],
  },
  {
    phase: "Phases 4–5",
    title: "Lead agents",
    fields: [
      { key: "conductorAgent", label: "Conductor agent", kind: "agent" },
      { key: "frontChatAgent", label: "Front chat agent", kind: "agent" },
    ],
  },
  {
    phase: "Phase 6",
    title: "Review",
    fields: [
      { key: "differentReviewProvider", label: "Different review provider", kind: "bool" },
      { key: "requireReview", label: "Require review", kind: "bool" },
    ],
  },
  {
    phase: "Phase 7",
    title: "Portability",
    fields: [{ key: "portabilityEnabled", label: "Portable context", kind: "bool" }],
  },
];

const ALL_FIELDS: FieldDef[] = [...LIVE, ...PLANNED.flatMap((g) => g.fields)];

interface ImportChange { scope: string; label: string; before: string; after: string }

function importChanges(preview: ImportPreview): ImportChange[] {
  const scopes = ["global", ...new Set([...Object.keys(preview.current.projects), ...Object.keys(preview.proposed.projects)])];
  const changes: ImportChange[] = [];
  for (const scope of scopes) {
    const before = scope === "global" ? preview.current.global : preview.current.projects[scope] ?? {};
    const after = scope === "global" ? preview.proposed.global : preview.proposed.projects[scope] ?? {};
    for (const { key, label } of ALL_FIELDS) {
      if (before[key] !== after[key]) changes.push({ scope, label, before: valueLabel(before[key]), after: valueLabel(after[key]) });
    }
  }
  return changes;
}

function sourceKey(field: Field): string { return field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`); }
function valueLabel(value: Overlay[Field]): string {
  if (value == null) return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return AGENTS.find((a) => a.id === value)?.label ?? value;
  return value.toLocaleString();
}

export function OrchestrationPanel({ openRouting }: { openRouting: () => void }) {
  const projects = useStore((s) => s.projects);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const project = useMemo(() => projects.find((p) => p.id === selectedProjectId) ?? projects[0], [projects, selectedProjectId]);
  const [scope, setScope] = useState<"global" | "project">("global");
  const scopeId = scope === "project" ? project?.id ?? null : null;
  const [loaded, setLoaded] = useState<{ scopeId: string | null; view: PolicyView } | null>(null);
  const view = loaded?.scopeId === scopeId ? loaded.view : null;
  const [error, setError] = useState("");
  const [json, setJson] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [copied, setCopied] = useState(false);
  const [plannedOpen, setPlannedOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void invoke<PolicyView>("orchestration_policy_view", { projectId: scopeId })
      .then((v) => { if (active) { setLoaded({ scopeId, view: v }); setError(""); } })
      .catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [scopeId]);

  async function write(overlay: Overlay) {
    try {
      const updated = await invoke<PolicyView>("set_orchestration_overlay", { projectId: scopeId, overlay });
      setLoaded({ scopeId, view: updated });
      setError("");
    } catch (e) { setError(String(e)); }
  }

  async function exportJson() {
    try { setJson(await invoke<string>("export_orchestration_policy")); setPreview(null); setError(""); }
    catch (e) { setError(String(e)); }
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (e) { setError(String(e)); }
  }

  async function inspectImport() {
    try { setPreview(await invoke<ImportPreview>("preview_orchestration_import", { json })); setError(""); }
    catch (e) { setPreview(null); setError(String(e)); }
  }

  async function applyImport() {
    try {
      await invoke("import_orchestration_policy", { json });
      setLoaded({ scopeId, view: await invoke<PolicyView>("orchestration_policy_view", { projectId: scopeId }) });
      setPreview(null); setError("");
    } catch (e) { setError(String(e)); }
  }

  const local = view ? (scopeId ? view.project : view.global) : {};
  const changes = preview ? importChanges(preview) : [];

  /** Where the value in force came from, phrased for the scope being edited. */
  function originBadge(key: Field) {
    const source = view?.source[sourceKey(key)];
    if (source === "default") return <Badge tone="muted">Default</Badge>;
    if (source === "global" && scopeId) return <Badge>From Global</Badge>;
    return <Badge tone="accent">Set here</Badge>;
  }

  function resetButton(key: Field) {
    if (local[key] == null) return null;
    return (
      <Button variant="ghost" onClick={() => void write({ ...local, [key]: null })}>
        Reset
      </Button>
    );
  }

  const plannedCount = PLANNED.reduce((n, g) => n + g.fields.length, 0);

  return (
    <div className="orch-panel">
      <p className="settings-intro">
        How Conduit coordinates its agents. Project values override Global; anything left unset
        inherits.
      </p>

      <div className="orch-scope">
        <Segmented
          label="Policy scope"
          value={scope}
          onChange={setScope}
          options={[
            { value: "global", label: "Global" },
            {
              value: "project",
              label: project?.name ?? "This project",
              disabled: !project,
              title: project ? `Overrides for ${project.name} only` : "Open a project to set overrides",
            },
          ]}
        />
        <span className="orch-scope-hint">
          {scope === "global"
            ? "Applies to every project unless it overrides a value."
            : `Overrides Global for ${project?.name ?? "this project"} only.`}
        </span>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {!view ? (
        <p className="settings-intro">Loading policy…</p>
      ) : (
        <>
          <SettingsSection title="Context">
            {LIVE.map(({ key, label }) => (
              <SettingRow
                key={key}
                id={`orch-${key}`}
                title={label}
                badge={originBadge(key)}
                detail="Draw a ring on each session's tab and canvas card showing how full its context window is."
                checked={Boolean(view.effective[key])}
                onChange={(on) => void write({ ...local, [key]: on })}
                trailing={resetButton(key)}
              />
            ))}
          </SettingsSection>

          <section className="ui-section">
            <button
              type="button"
              className={`orch-disclosure${plannedOpen ? " open" : ""}`}
              aria-expanded={plannedOpen}
              aria-controls="orch-planned"
              onClick={() => setPlannedOpen((v) => !v)}
            >
              <ChevronRightIcon size={11} className="orch-disclosure-caret" />
              <span className="ui-section-title">Planned</span>
              <Badge tone="muted">{plannedCount} settings</Badge>
            </button>
            <p className="ui-section-desc">
              Limits and role rules for upcoming releases. They are kept in your policy and can be
              imported below, but nothing reads them yet.
            </p>
            {plannedOpen && (
              <div id="orch-planned" className="orch-planned">
                {PLANNED.map((group) => (
                  <SettingsSection
                    key={group.title}
                    title={group.title}
                    actions={<Badge tone="muted">{group.phase}</Badge>}
                  >
                    {group.fields.map(({ key, label }) => (
                      <SettingRow
                        key={key}
                        title={label}
                        disabled
                        trailing={
                          <span className="orch-value">{valueLabel(view.effective[key])}</span>
                        }
                      />
                    ))}
                  </SettingsSection>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <SettingsSection
        title="Policy file"
        description="Move a policy between machines. The file holds preferences only — no keys, paths or session data. Paste one in, review the changes, then apply."
        flush
      >
        <textarea
          aria-label="Policy JSON"
          className="ui-textarea"
          rows={7}
          spellCheck={false}
          placeholder='{ "version": 1, "global": { … }, "projects": { … } }'
          value={json}
          onChange={(e) => { setJson(e.target.value); setPreview(null); }}
        />
        <div className="orch-file-actions">
          <ButtonRow align="start">
            <Button onClick={() => void exportJson()}>Export current</Button>
            <Button variant="ghost" disabled={!json} onClick={() => void copyJson()}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </ButtonRow>
          <Button disabled={!json.trim()} onClick={() => void inspectImport()}>
            Review import
          </Button>
        </div>

        {preview && (
          <div className="orch-diff">
            {changes.length === 0 ? (
              <p className="orch-diff-empty">This file matches your current policy. Nothing to apply.</p>
            ) : (
              <>
                <div className="orch-diff-head">
                  {changes.length} {changes.length === 1 ? "change" : "changes"}
                </div>
                <ul className="orch-diff-list">
                  {changes.map((c) => (
                    <li key={`${c.scope}:${c.label}`} className="orch-diff-row">
                      <span className="orch-diff-scope">
                        {c.scope === "global" ? "Global" : projects.find((p) => p.id === c.scope)?.name ?? c.scope}
                      </span>
                      <span className="orch-diff-label">{c.label}</span>
                      <span className="orch-diff-values">
                        <s>{c.before}</s>
                        <span aria-hidden="true">→</span>
                        <strong>{c.after}</strong>
                      </span>
                    </li>
                  ))}
                </ul>
                <ButtonRow>
                  <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
                  <Button variant="primary" onClick={() => void applyImport()}>Apply import</Button>
                </ButtonRow>
              </>
            )}
          </div>
        )}
      </SettingsSection>

      <div className="orch-footnote">
        <span>Which agent takes which kind of task is set in Routing.</span>
        <Button variant="ghost" onClick={openRouting}>
          Open Routing
          <ChevronRightIcon size={10} />
        </Button>
      </div>
    </div>
  );
}
