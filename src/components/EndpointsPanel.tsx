import { useEffect, useState } from "react";
import { AGENTS, agentMeta, type AgentId } from "../agents";
import { useStore, EMPTY_PROVIDER, type EndpointView } from "../store";
import { AgentGlyph } from "./AgentGlyph";
import { PlusIcon } from "./Icons";
import { EndpointEditor, presetMeta } from "./EndpointEditor";
import { Button, Segmented, SettingsSection } from "./ui";

/**
 * Settings → Model endpoints. The global, per-agent half of the same setting the Model tab
 * shows for one session: this is where the default every new session inherits is edited.
 *
 * Only agents with a real injection seam appear (`AgentMeta.supportsEndpoint`) — OpenCode
 * through `OPENCODE_CONFIG_CONTENT`, Hermes through its managed-scope overlay. Listing an
 * agent Conduit cannot actually redirect would be an offer the spawn cannot keep, which is
 * the same rule the Model tab follows for its per-session controls.
 *
 * **An agent has a POOL of endpoints, and one of them is active.** The editor below always
 * edits the active one; the list above is how a second is added and how the active one is
 * chosen. That split is not cosmetic — the pool is what Conduit writes into the agent's own
 * config, which is the only reason `/model --provider` can move a running session from a
 * local model to OpenRouter without restarting it.
 */
export function EndpointsPanel() {
  const agents = AGENTS.filter((a) => a.supportsEndpoint);
  const [open, setOpen] = useState<AgentId>(agents[0]?.id ?? "opencode");

  if (agents.length === 0) {
    return <p className="placeholder">No agent here supports a Conduit-managed endpoint.</p>;
  }

  return (
    <div className="ep-panel">
      <Segmented
        value={open}
        onChange={setOpen}
        label="Choose an agent"
        options={agents.map((a) => ({
          value: a.id,
          label: (
            <>
              <AgentGlyph id={a.id} size={12} />
              {a.label}
            </>
          ),
        }))}
      />
      <EndpointPool agent={open} />
      <EndpointEditor agent={open} />
    </div>
  );
}

/**
 * The list of endpoints configured for one agent.
 *
 * Clicking a row makes it active, which is also what points the editor below at it — there
 * is deliberately no second "edit this row" affordance, because two ways to edit the same
 * endpoint is how the two ends up disagreeing with the one.
 */
function EndpointPool({ agent }: { agent: AgentId }) {
  const pools = useStore((s) => s.endpointPools);
  const load = useStore((s) => s.loadEndpointPools);
  const setEndpointPool = useStore((s) => s.setEndpointPool);
  const setProviderSettings = useStore((s) => s.setProviderSettings);
  const setEndpointKey = useStore((s) => s.setEndpointKey);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  // Close an open key field when the agent changes: it belongs to one endpoint of one
  // agent, and carrying a typed secret across would offer to save it somewhere else.
  useEffect(() => {
    setKeyFor(null);
    setKeyDraft("");
  }, [agent]);

  const rows: EndpointView[] = pools[agent] ?? [];
  const meta = agentMeta(agent);
  // Whether this agent can be moved between endpoints mid-conversation at all. When it
  // cannot, say so once at the bottom rather than disabling a chip on every row.
  const liveSwitch = rows.some((r) => r.providerSlug);

  const activate = (row: EndpointView) => {
    void setProviderSettings(agent, row.settings);
  };

  const remove = (row: EndpointView) => {
    const kept = rows.filter((r) => r.settings.baseUrl !== row.settings.baseUrl);
    void setEndpointPool(
      agent,
      kept.map((r) => r.settings),
    );
    // Removing the ACTIVE endpoint leaves the agent on nothing rather than silently
    // promoting a neighbour: which endpoint a session spawns on is the user's choice, and
    // guessing it is how a session ends up somewhere they never picked.
    if (row.active) void setProviderSettings(agent, EMPTY_PROVIDER);
  };

  const saveKey = async (row: EndpointView) => {
    await setEndpointKey(agent, row.settings.baseUrl, keyDraft);
    setKeyDraft("");
    setKeyFor(null);
  };

  return (
    <div className="ep-pool">
      <SettingsSection
        title={`Endpoints for ${meta.label}`}
        actions={
          <Button
            onClick={() => {
              // A blank active endpoint is what puts the editor below into "configure a new
              // one" mode. It is not added to the pool until it has a URL — an unaddressable
              // row would render a provider nothing can switch to.
              void setProviderSettings(agent, EMPTY_PROVIDER);
            }}
          >
            <PlusIcon size={11} />
            Add endpoint
          </Button>
        }
        flush
      >

      {rows.length === 0 ? (
        <p className="mp-note">
          No endpoint configured. Pick a preset below; add a second one to switch between
          them {liveSwitch ? "without restarting" : "later"}.
        </p>
      ) : (
        <ul className="ep-rows">
          {rows.map((r) => {
            const def = presetMeta(r.settings.preset);
            const open = keyFor === r.settings.baseUrl;
            return (
              <li key={r.settings.baseUrl} className={`ep-row${r.active ? " active" : ""}`}>
                <button className="ep-row-main" onClick={() => activate(r)}>
                  <span className="ep-row-name">
                    {def?.label ?? r.settings.preset ?? "Endpoint"}
                    {r.active ? <span className="ep-badge">active</span> : null}
                    {r.hasKey ? <span className="ep-badge key">key</span> : null}
                  </span>
                  <span className="ep-row-detail">
                    {r.settings.model || "no model pinned"} · {r.settings.baseUrl}
                  </span>
                  {r.providerSlug ? (
                    <span className="ep-row-slug" title="Switchable mid-session">
                      {r.providerSlug}
                    </span>
                  ) : null}
                </button>
                <span className="ep-row-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setKeyFor(open ? null : r.settings.baseUrl);
                      setKeyDraft("");
                    }}
                  >
                    {r.hasKey ? "Replace key" : "Add key"}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => remove(r)}
                  >
                    Remove
                  </Button>
                </span>
                {open ? (
                  <div className="ep-row-key">
                    <input
                      type="password"
                      value={keyDraft}
                      autoFocus
                      spellCheck={false}
                      placeholder={def?.keyHint ?? "API key for this endpoint"}
                      onChange={(e) => setKeyDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveKey(r);
                        if (e.key === "Escape") setKeyFor(null);
                      }}
                    />
                    <Button variant="primary" size="sm" onClick={() => void saveKey(r)}>
                      Save
                    </Button>
                    {r.hasKey ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          await setEndpointKey(agent, r.settings.baseUrl, "");
                          setKeyFor(null);
                        }}
                      >
                        Clear
                      </Button>
                    ) : null}
                    {/* Said on every key field, because "held in memory" is the part that
                        explains why it must be entered again after a restart. */}
                    <span className="mp-note">
                      Held in memory for this run only — never written to disk.
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > 1 && !liveSwitch ? (
        <p className="mp-note">
          {meta.label} reads its endpoint once at start, so switching between these restarts
          the session.
        </p>
      ) : null}
      </SettingsSection>
    </div>
  );
}
