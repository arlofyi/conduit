import { Fragment, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useStore } from "../store";
import { Button, ButtonRow, SettingsSection } from "./ui";
import { COUNTER_LABELS, displayPath, formatUptime } from "../diagnostics";

/** `diag::diagnostics` (diag.rs). Everything here is local; `report` is pre-redacted. */
interface DiagnosticsView {
  version: string;
  os: string;
  arch: string;
  logDir: string;
  logFile: string;
  uptimeSecs: number;
  counters: { key: string; value: number }[];
  summary: string;
  recent: string[];
  report: string;
}

const REPO_URL = "https://github.com/uziiuzair/conduit";
const SITE_URL = "https://arlo.fyi";

function openExternal(url: string) {
  void invoke("open_external", { url }).catch(() => {});
}

export function AboutPanel() {
  const [version, setVersion] = useState("");
  const phase = useStore((s) => s.updatePhase);
  const info = useStore((s) => s.updateInfo);
  const error = useStore((s) => s.updateError);
  const check = useStore((s) => s.checkForUpdates);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const link = (url: string, label: string) => (
    <a
      className="about-link"
      role="link"
      tabIndex={0}
      onClick={() => openExternal(url)}
      onKeyDown={(e) => e.key === "Enter" && openExternal(url)}
    >
      {label}
    </a>
  );

  // Status text for the manual check. "available"/"downloading" are handled by the
  // global UpdateNotice; here we cover checking / up-to-date / error.
  const status = (): string => {
    if (phase === "checking") return "Checking…";
    if (phase === "downloading") return "Downloading…";
    if (phase === "available" && info) return `Update available: ${info.version}`;
    if (phase === "error") return error ? `Update failed: ${error}` : "Update failed";
    return version ? "You're up to date." : "";
  };

  return (
    <div className="about-panel">
      <div className="about-wordmark">Conduit</div>
      <p className="settings-intro">
        Multiple real Claude Code terminals across your projects, in one window.
      </p>
      <p className="about-credit">
        Built with love by Uzair Hayat, Fahed Yasin, and Usman Kaisser at{" "}
        {link(SITE_URL, "Arlo")}.
      </p>
      <dl className="about-facts">
        <dt>Version</dt>
        <dd>{version || "..."}</dd>
        <dt>Updates</dt>
        <dd className="about-updates">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void check({ manual: true })}
            disabled={phase === "checking" || phase === "downloading"}
          >
            Check for updates
          </Button>
          <span className="about-update-status">{status()}</span>
        </dd>
        <dt>Source</dt>
        <dd>{link(REPO_URL, "github.com/uziiuzair/conduit")}</dd>
        <dt>License</dt>
        <dd>MIT</dd>
        <dt>Includes</dt>
        <dd className="about-prose">
          Screen rules for Antigravity, Gemini and OpenCode from{" "}
          {link("https://github.com/herdrdev/herdr", "Herdr")}, used unmodified under the{" "}
          {link("https://www.apache.org/licenses/LICENSE-2.0", "Apache License 2.0")}. Copyright the Herdr
          authors.
        </dd>
      </dl>
      <DiagnosticsSection />
    </div>
  );
}

/** Local-only health: this run's counters, the latest errors, and the log folder. */
function DiagnosticsSection() {
  const [view, setView] = useState<DiagnosticsView | null>(null);
  const [note, setNote] = useState("");

  const refresh = () => {
    void invoke<DiagnosticsView>("diagnostics")
      .then(setView)
      .catch(() => setNote("Diagnostics are unavailable."));
  };
  useEffect(refresh, []);

  const openLogs = () => {
    if (!view) return;
    // Reveal the live log file (selects it in Finder/Explorer); before the first line is
    // written there is no file yet, so fall back to the folder.
    void invoke("reveal_path", { path: view.logFile })
      .catch(() => invoke("reveal_path", { path: view.logDir }))
      .catch(() => setNote(`Logs are in ${view.logDir}`));
  };

  const copy = () => {
    void invoke<DiagnosticsView>("diagnostics")
      .then((v) => {
        setView(v);
        return navigator.clipboard.writeText(v.report);
      })
      .then(() => setNote("Copied. Paths under your home folder and anything that looks like a secret are redacted."))
      .catch(() => setNote("Could not copy."));
  };

  const shown = view?.counters.filter(
    (c) => c.value > 0 || ["sessions_spawned", "errors", "panics"].includes(c.key),
  );

  return (
    <SettingsSection
      title="Diagnostics"
      description="Errors and crashes are written to a log file on this computer. Nothing is sent anywhere."
      actions={
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      }
      flush
    >
      {/* Its own card, not the section's default body: that one is a 2px-padded shell
          built for full-width setting rows, and anything else sits flush against its
          border. */}
      <div className="diag-card">
        <dl className="about-facts">
          <dt>This run</dt>
          <dd>{view ? `up ${formatUptime(view.uptimeSecs)}` : "..."}</dd>
          {shown?.map((c) => (
            <Fragment key={c.key}>
              <dt>{COUNTER_LABELS[c.key] ?? c.key}</dt>
              <dd>{c.value}</dd>
            </Fragment>
          ))}
          <dt>Log folder</dt>
          <dd className="diag-path" title={view?.logDir}>
            {view ? displayPath(view.logDir) : "..."}
          </dd>
        </dl>
        {view && view.recent.length > 0 && (
          <details className="diag-recent">
            <summary>Recent errors and warnings ({view.recent.length})</summary>
            <pre>{view.recent.map((l) => l.trimEnd()).join(String.fromCharCode(10))}</pre>
          </details>
        )}
        <div className="diag-actions">
          <ButtonRow align="start">
            <Button variant="secondary" size="sm" onClick={openLogs} disabled={!view}>
              Open logs folder
            </Button>
            <Button variant="secondary" size="sm" onClick={copy}>
              Copy diagnostics
            </Button>
          </ButtonRow>
          {note && <p className="diag-note">{note}</p>}
        </div>
      </div>
    </SettingsSection>
  );
}
