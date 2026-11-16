import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

/** `telemetry::TelemetryPreview`. */
interface Preview {
  sending: boolean;
  reason: string | null;
  endpoint: string;
  payload: unknown;
  cadence: string;
}

/**
 * Settings -> Privacy: exactly what the usage statistics are, read from the same Rust
 * function that builds the real request. "No code or prompts are sent" is a claim; this
 * is the request itself, so the user can check the claim rather than take it.
 */
export function TelemetryPreview() {
  const optedOut = useStore((s) => s.telemetryOptOut);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<Preview>("telemetry_preview", { optedOut })
      .then((p) => {
        if (alive) setPreview(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [optedOut]);

  if (!preview) return null;
  return (
    <div className="telemetry-preview">
      <p className={`telemetry-state ${preview.sending ? "on" : "off"}`} role="status">
        <span className="telemetry-dot" aria-hidden />
        {preview.sending ? "Sending" : "Not sending"}
        {preview.reason && <span className="telemetry-reason"> — {preview.reason}</span>}
      </p>
      <dl className="telemetry-facts">
        <dt>Where</dt>
        <dd>
          <code>{preview.endpoint}</code>
        </dd>
        <dt>When</dt>
        <dd>{preview.cadence}</dd>
      </dl>
      <p className="telemetry-label">
        {preview.sending ? "This is the whole request:" : "If sharing were on, this would be the whole request:"}
      </p>
      <pre className="telemetry-payload" aria-label="The statistics request">
        {JSON.stringify(preview.payload, null, 2)}
      </pre>
      <p className="telemetry-note">
        <code>api_key</code> names Conduit&apos;s statistics project, not you. Turning sharing off also
        deletes the random id from this computer.
      </p>
    </div>
  );
}
