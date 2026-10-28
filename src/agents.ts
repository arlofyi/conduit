export type AgentId =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "antigravity"
  | "commandcode"
  | "hermes";

export interface AgentMeta {
  id: AgentId;
  label: string;
  /** Monogram letter shown in the glyph. */
  letter: string;
  /** CSS color token for the glyph tint. */
  tint: string;
  /** Whether Conduit's worktree isolation is offered for this agent (Phase 1: Claude only). */
  supportsWorktree: boolean;
  /** Whether the MCP matrix can manage servers for this agent (OpenCode: not yet — Tier 3). */
  supportsMcp: boolean;
  /** Whether this CLI takes `--model` per invocation, so a route can pin one.
   *  Mirrors `ProviderAdapter::supports_model_flags` — the Rust side is what actually
   *  gates the flag; this only decides whether the routing editor offers a model box, so
   *  it cannot promise something the spawn will not do. */
  supportsModelFlags: boolean;
  /** Models this agent accepts, for the routing editor's picker. Empty = free text or
   *  fetched at runtime (Command Code's ~58 come from `--list-models`). */
  models?: string[];
  /** Reasoning-effort levels this CLI accepts, in ascending order. Absent = this agent
   *  takes no effort flag, so the UI must not offer one. The values are the CLI's own —
   *  Hermes accepts a wider set than Claude, and the flag is spelled differently too
   *  (`--reasoning`, see `ProviderAdapter::effort_flag`), which is why this cannot be one
   *  shared list. */
  effortLevels?: string[];
  /** Whether Conduit can point this agent at a chosen OpenAI-compatible endpoint
   *  (`ProviderSettings`). Only agents with a real injection seam qualify: OpenCode via
   *  `OPENCODE_CONFIG_CONTENT`, Hermes via its managed-scope overlay. */
  supportsEndpoint?: boolean;
}

/** Claude's five, from `claude --help`. */
const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"];

export const AGENTS: AgentMeta[] = [
  { id: "claude",   label: "Claude Code", letter: "C", tint: "#ce8a6e", supportsWorktree: true,  supportsMcp: true,  supportsModelFlags: true,  models: ["opus", "sonnet", "haiku"], effortLevels: CLAUDE_EFFORT },
  { id: "codex",    label: "Codex CLI",   letter: "x", tint: "#9aa6b2", supportsWorktree: false, supportsMcp: true,  supportsModelFlags: false },
  { id: "gemini",   label: "Gemini CLI",  letter: "G", tint: "#7e9cff", supportsWorktree: false, supportsMcp: true,  supportsModelFlags: false },
  { id: "opencode", label: "OpenCode",    letter: "o", tint: "#6cc29a", supportsWorktree: false, supportsMcp: false, supportsModelFlags: false, supportsEndpoint: true },
  { id: "antigravity", label: "Antigravity", letter: "A", tint: "#a78bfa", supportsWorktree: false, supportsMcp: false, supportsModelFlags: false },
  // Command Code's binary is `cmd` on Unix and `cmdc` on Windows -- the monogram stays a
  // plain "c" so it reads the same on both. `supportsMcp` because `cmd mcp add/remove`
  // takes the same flags Claude's does; `supportsWorktree` stays off because Command Code
  // manages its own worktrees (`-w`) and two managers over one directory is a decision
  // that has not been made yet.
  { id: "commandcode", label: "Command Code", letter: "c", tint: "#e0b341", supportsWorktree: false, supportsMcp: true, supportsModelFlags: true, effortLevels: CLAUDE_EFFORT },
  // Hermes ships no brand mark here, so AgentGlyph falls back to the letter rather than a
  // guessed logo. supportsMcp because `hermes mcp add/remove` takes the same shape Claude'''s
  // does; supportsWorktree stays off because Hermes manages its own (`-w`). Its models are
  // free text on purpose -- what is valid depends entirely on the endpoint the session is
  // pointed at (any OpenRouter model, or whatever a local server serves), so a fixed list
  // would be wrong the moment the endpoint changed.
  { id: "hermes", label: "Hermes Agent", letter: "H", tint: "#b58cff", supportsWorktree: false, supportsMcp: true, supportsModelFlags: true, supportsEndpoint: true, effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
];

export const DEFAULT_AGENT: AgentId = "claude";

export function agentMeta(id: AgentId): AgentMeta {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[0];
}

/** Result of the Rust `detect_agents` PATH scan (mirrors AgentInfo in agent.rs). */
export interface AgentInfo {
  id: AgentId;
  label: string;
  binary: string;
  found: boolean;
  path?: string | null;
  /** One-click install command for this agent, or null when there's no known installer. */
  installCommand?: string | null;
}

/** MCP server definition — mirrors the Rust McpServer struct (serde rename_all = "camelCase"). */
export interface McpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: [string, string][];
}
