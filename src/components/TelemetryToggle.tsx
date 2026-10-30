import { useStore } from "../store";
import { SettingRow } from "./ui";

/**
 * Opt-out control for anonymous usage telemetry. Framed positively (on =
 * sharing on) to avoid a confusing double negative. Shared by Settings and the
 * onboarding wizard. The store flag drives the engagement heartbeat in App.
 */
export function TelemetryToggle() {
  const telemetryOptOut = useStore((s) => s.telemetryOptOut);
  const setTelemetryOptOut = useStore((s) => s.setTelemetryOptOut);

  return (
    <SettingRow
      id="telemetry"
      title="Share anonymous usage statistics"
      checked={!telemetryOptOut}
      onChange={(on) => setTelemetryOptOut(!on)}
    />
  );
}
