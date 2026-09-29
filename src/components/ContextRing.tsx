import type { ContextUsage } from "../store";
import { meterTitle } from "../contextMeter";

/** Render a measured fraction only with a known denominator; missing data says Unknown. */
export function ContextRing({ usage, large = false }: { usage?: ContextUsage; large?: boolean }) {
  const measured = usage && usage.window > 0 && Number.isFinite(usage.fraction);
  const fraction = measured ? Math.max(0, Math.min(1, usage.fraction)) : 0;
  const label = measured ? meterTitle(usage) : "Context Unknown";
  return <span className={`context-ring${large ? " large" : ""}`} title={label} aria-label={label}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle className="context-ring-track" cx="12" cy="12" r="9" />
      {measured && <circle className="context-ring-fill" cx="12" cy="12" r="9" pathLength="1" strokeDasharray={`${fraction} 1`} />}
    </svg>
    <span className="context-ring-label">{measured ? `${Math.round(fraction * 100)}%` : "?"}</span>
  </span>;
}
