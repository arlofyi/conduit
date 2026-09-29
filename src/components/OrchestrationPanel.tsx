import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

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

function importChanges(preview: ImportPreview): string[] {
  const scopes = ["global", ...new Set([...Object.keys(preview.current.projects), ...Object.keys(preview.proposed.projects)])];
  const changes: string[] = [];
  for (const scope of scopes) {
    const before = scope === "global" ? preview.current.global : preview.current.projects[scope] ?? {};
    const after = scope === "global" ? preview.proposed.global : preview.proposed.projects[scope] ?? {};
    for (const { key, label } of FIELDS) {
      if (before[key] !== after[key]) changes.push(`${scope} · ${label}: ${effectiveLabel(before[key])} → ${effectiveLabel(after[key])}`);
    }
  }
  return changes;
}

const FIELDS: Array<{ key: Field; label: string; kind: "bool" | "number" | "agent"; phase: string; available: boolean }> = [
  { key: "contextDisplay", label: "Show context readings", kind: "bool", phase: "P1", available: true },
  { key: "contextWarningTarget", label: "Warning target (tokens)", kind: "number", phase: "P2", available: false },
  { key: "contextHardCap", label: "Hard cap (tokens)", kind: "number", phase: "P2", available: false },
  { key: "checkpointIntervalMinutes", label: "Checkpoint interval (minutes)", kind: "number", phase: "P2", available: false },
  { key: "fleetTotal", label: "Fleet total", kind: "number", phase: "P3", available: false },
  { key: "writersPerRepo", label: "Writers per repository", kind: "number", phase: "P3", available: false },
  { key: "readers", label: "Readers", kind: "number", phase: "P3", available: false },
  { key: "critics", label: "Critics", kind: "number", phase: "P3", available: false },
  { key: "retryRounds", label: "Failed rounds", kind: "number", phase: "P3", available: false },
  { key: "requireWriterWorktree", label: "Require writer worktree", kind: "bool", phase: "P3", available: false },
  { key: "quotaPausePercent", label: "Pause below quota (%)", kind: "number", phase: "P3", available: false },
  { key: "frontChatAgent", label: "Front chat agent", kind: "agent", phase: "P5", available: false },
  { key: "conductorAgent", label: "Conductor agent", kind: "agent", phase: "P4", available: false },
  { key: "differentReviewProvider", label: "Different review provider", kind: "bool", phase: "P6", available: false },
  { key: "requireReview", label: "Require review", kind: "bool", phase: "P6", available: false },
  { key: "portabilityEnabled", label: "Portable context", kind: "bool", phase: "P7", available: false },
];

function sourceKey(field: Field): string { return field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`); }
function effectiveLabel(value: Overlay[Field]): string {
  if (value == null) return "Unset";
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

export function OrchestrationPanel({ openRouting }: { openRouting: () => void }) {
  const projects = useStore((s) => s.projects);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const project = useMemo(() => projects.find((p) => p.id === selectedProjectId) ?? projects[0], [projects, selectedProjectId]);
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [view, setView] = useState<PolicyView | null>(null);
  const [error, setError] = useState("");
  const [json, setJson] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  useEffect(() => {
    let active = true;
    void invoke<PolicyView>("orchestration_policy_view", { projectId: scopeId })
      .then((v) => { if (active) { setView(v); setError(""); } })
      .catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [scopeId]);

  async function write(overlay: Overlay) {
    try {
      setView(await invoke<PolicyView>("set_orchestration_overlay", { projectId: scopeId, overlay }));
      setError("");
    } catch (e) { setError(String(e)); }
  }

  async function exportJson() {
    try { setJson(await invoke<string>("export_orchestration_policy")); setPreview(null); setError(""); }
    catch (e) { setError(String(e)); }
  }

  async function inspectImport() {
    try { setPreview(await invoke<ImportPreview>("preview_orchestration_import", { json })); setError(""); }
    catch (e) { setPreview(null); setError(String(e)); }
  }

  async function applyImport() {
    try {
      await invoke("import_orchestration_policy", { json });
      setView(await invoke<PolicyView>("orchestration_policy_view", { projectId: scopeId }));
      setPreview(null); setError("");
    } catch (e) { setError(String(e)); }
  }

  return <div className="routing-panel">
    <p className="settings-intro">Context display and future orchestration preferences. Limits and role rules are saved for later phases; they do not control sessions yet.</p>
    <div className="route-scope">
      <button className={`route-scope-btn${scopeId === null ? " on" : ""}`} onClick={() => setScopeId(null)}>Global</button>
      <button className={`route-scope-btn${scopeId !== null ? " on" : ""}`} disabled={!project} onClick={() => project && setScopeId(project.id)}>{project?.name ?? "This project"}</button>
    </div>
    <p className="settings-intro">Agent routes are configured in <button className="route-btn" onClick={openRouting}>Routing settings</button>.</p>
    {error && <p role="alert">{error}</p>}
    {!view ? <p>Loading policy…</p> : FIELDS.map(({ key, label, kind, phase, available }) => {
      const local = scopeId ? view.project : view.global;
      const inherited = local[key] == null;
      const source = view.source[sourceKey(key)];
      const effective = view.effective[key];
      const reason = available ? "" : `Available in ${phase}; this setting has no effect in P1.`;
      return <div className="route-task" key={key}>
        <div className="route-task-head"><span className="route-task-name">{label}</span><span className="route-origin">{source === "default" ? "built-in default" : source === "global" && scopeId ? "inherited from Global" : "set here"}</span>
          {!inherited && <button className="route-btn route-reset" onClick={() => void write({ ...local, [key]: null })}>Reset</button>}
        </div>
        <p className="route-hint">Effective: {effectiveLabel(effective)}. {reason}</p>
        {kind === "bool" ? <label><input type="checkbox" checked={Boolean(effective)} disabled={!available} onChange={(e) => void write({ ...local, [key]: e.target.checked })} /> Enabled</label>
          : <input aria-label={label} type={kind === "number" ? "number" : "text"} value={String(effective ?? "")} disabled={!available} onChange={(e) => void write({ ...local, [key]: kind === "number" ? Number(e.target.value) : e.target.value })} />}
      </div>;
    })}
    <div className="route-task">
      <div className="route-task-head"><span className="route-task-name">Policy JSON</span></div>
      <p className="route-hint">Export contains policy preferences only. Paste JSON, preview changes, then apply.</p>
      <button className="route-btn" onClick={() => void exportJson()}>Export to text</button>
      <textarea aria-label="Policy JSON" rows={8} value={json} onChange={(e) => { setJson(e.target.value); setPreview(null); }} />
      <button className="route-btn" onClick={() => void inspectImport()}>Preview import</button>
      {preview && <div><p>Changes</p>{importChanges(preview).length ? <ul>{importChanges(preview).map((line) => <li key={line}>{line}</li>)}</ul> : <p>No changes.</p>}<button className="route-btn" disabled={importChanges(preview).length === 0} onClick={() => void applyImport()}>Apply import</button></div>}
    </div>
  </div>;
}
