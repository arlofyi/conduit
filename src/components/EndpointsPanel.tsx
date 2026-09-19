import { useState } from "react";
import { AGENTS, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";
import { EndpointEditor } from "./EndpointEditor";

/**
 * Settings → Model endpoints. The global, per-agent half of the same setting the Model tab
 * shows for one session: this is where the default every new session inherits is edited.
 *
 * Only agents with a real injection seam appear (`AgentMeta.supportsEndpoint`) — OpenCode
 * through `OPENCODE_CONFIG_CONTENT`, Hermes through its managed-scope overlay. Listing an
 * agent Conduit cannot actually redirect would be an offer the spawn cannot keep, which is
 * the same rule the Model tab follows for its per-session controls.
 */
export function EndpointsPanel() {
  const agents = AGENTS.filter((a) => a.supportsEndpoint);
  const [open, setOpen] = useState<AgentId>(agents[0]?.id ?? "opencode");

  if (agents.length === 0) {
    return <p className="placeholder">No agent here supports a Conduit-managed endpoint.</p>;
  }

  return (
    <div className="ep-panel">
      <div className="mp-chips">
        {agents.map((a) => (
          <button
            key={a.id}
            className={`mp-chip${open === a.id ? " active" : ""}`}
            onClick={() => setOpen(a.id)}
          >
            <AgentGlyph id={a.id} size={12} />
            {a.label}
          </button>
        ))}
      </div>
      <EndpointEditor agent={open} />
    </div>
  );
}
