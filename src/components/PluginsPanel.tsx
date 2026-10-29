import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { PluginConsentDialog } from "./PluginConsentDialog";
import type { PluginDescriptor, PluginManifest, PluginPermission } from "../plugins/types";
import { Button, ButtonRow } from "./ui";

function statusOf(d: PluginDescriptor): string {
  if (!d.manifest) return "error";
  if (d.problems.length) return "incompatible";
  return d.record?.enabled ? "enabled" : "disabled";
}

/** Enabling requires consent when granted set doesn't already cover the requested perms,
 *  or when the consented manifest version changed (escalation re-consent). */
function needsConsent(d: PluginDescriptor): boolean {
  const req = (d.manifest?.permissions ?? []) as PluginPermission[];
  const granted = d.record?.grantedPermissions ?? [];
  return req.some((p) => !granted.includes(p)) || d.record?.consentedVersion !== d.manifest?.version;
}

export function PluginsPanel() {
  const plugins = useStore((s) => s.plugins);
  const refresh = useStore((s) => s.refreshPlugins);
  const enablePlugin = useStore((s) => s.enablePlugin);
  const disablePlugin = useStore((s) => s.disablePlugin);
  const removePlugin = useStore((s) => s.removePlugin);
  const setAll = useStore((s) => s.setAllPluginsEnabled);
  const [consent, setConsent] = useState<PluginManifest | null>(null);

  useEffect(() => { void refresh(); }, [refresh]);

  const onToggle = (d: PluginDescriptor) => {
    if (d.record?.enabled) { void disablePlugin(d.id); return; }
    if (needsConsent(d)) { setConsent(d.manifest); return; }
    void enablePlugin(d.id, (d.manifest?.permissions ?? []) as PluginPermission[], d.manifest!.version);
  };

  const grant = () => {
    if (!consent) return;
    void enablePlugin(consent.id, (consent.permissions ?? []) as PluginPermission[], consent.version);
    setConsent(null);
  };

  return (
    <div className="plugins-panel">
      <p className="settings-intro">
        Plugins extend Conduit. They run sandboxed and only get the access you grant.
        Drop a plugin folder into the plugins directory, then enable it here.
      </p>
      <ButtonRow align="start">
        <Button variant="secondary" onClick={() => void invoke<string>("open_plugins_dir").then((p) => console.log("plugins dir:", p))}>
          Open plugins folder
        </Button>
        <Button variant="secondary" onClick={() => void refresh()}>Rescan</Button>
        <Button variant="danger" onClick={() => void setAll(false)}>Disable all</Button>
      </ButtonRow>
      <ul className="plugins-list">
        {plugins.map((d) => (
          <li key={d.id} className="plugin-row">
            <div className="plugin-meta">
              <div className="plugin-name">{d.manifest?.name ?? d.id}</div>
              <div className="plugin-sub">
                {d.manifest ? `v${d.manifest.version} — ${statusOf(d)}` : d.problems[0]}
              </div>
              {d.record?.enabled && (
                <div className="plugin-perms">
                  {(d.record.grantedPermissions ?? []).join(", ") || "no permissions"}
                </div>
              )}
            </div>
            <div className="plugin-controls">
              {d.manifest && d.problems.length === 0 && (
                <Button variant="secondary" onClick={() => onToggle(d)}>{d.record?.enabled ? "Disable" : "Enable"}</Button>
              )}
              <Button variant="danger" onClick={() => void removePlugin(d.id)}>Remove</Button>
            </div>
          </li>
        ))}
        {plugins.length === 0 && <li className="plugin-row empty">No plugins installed.</li>}
      </ul>
      {consent && (
        <PluginConsentDialog
          manifest={consent}
          previouslyGranted={
            (plugins.find((p) => p.id === consent.id)?.record?.grantedPermissions ?? []) as PluginPermission[]
          }
          onGrant={grant}
          onCancel={() => setConsent(null)}
        />
      )}
    </div>
  );
}
