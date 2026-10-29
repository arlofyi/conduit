/**
 * Wire protocol for the Conduit mobile bridge (the Rust `bridge.rs` WebSocket).
 * These types mirror the server→client / client→server JSON exactly. A mapping
 * layer (live.ts) turns them into the UI types in src/data/types.ts.
 */

// ---- server → client ----

export interface WireSession {
  id: string;
  name: string;
  branch?: string | null;
  agent: "claude" | "codex" | "gemini";
  running: boolean;
  useWorktree?: boolean;
  worktreePath?: string | null;
}

export interface WireProject {
  id: string;
  name: string;
  path: string;
  sessions: WireSession[];
}

export interface WireQuestionOption {
  label: string;
  description: string;
}
export interface WireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: WireQuestionOption[];
}

export interface WireDiffLine {
  kind: "add" | "del" | "ctx" | "gap";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}
export interface WireDiff {
  filePath: string;
  added: number;
  removed: number;
  created: boolean;
  lines: WireDiffLine[];
  more: number;
}

/** A transcript-derived chat item (no id on the wire). Kinds mirror src-tauri/src/transcript_item_kinds.json. */
export type WireChatItem =
  | { kind: "bubble"; role: "user" | "assistant"; text: string }
  | {
      kind: "event";
      event: string;
      label: string;
      mono?: string | null;
      ok?: string | null;
      toolUseId?: string | null;
    }
  | {
      kind: "result";
      toolUseId: string;
      isError: boolean;
      errorText: string | null;
      diff: WireDiff | null;
    }
  | {
      kind: "usage";
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | { kind: "task"; taskId: string | null; status: string; summary: string }
  | { kind: "peer"; from: string; text: string }
  | { kind: "auto"; label: string; text: string }
  | { kind: "command"; name: string; args: string }
  | { kind: "command_output"; text: string; stream: "stdout" | "stderr" }
  | { kind: "skill"; name: string }
  | { kind: "image"; mediaType: string; data: string | null }
  | { kind: "divider"; label: string; tone: "info" | "warning" }
  | { kind: "question"; toolUseId: string; questions: WireQuestion[] }
  | { kind: "plan"; markdown: string }
  | { kind: "note"; tag: string; text: string };

export type ServerMsg =
  | { type: "projects"; projects: WireProject[] }
  | { type: "size"; cols: number; rows: number }
  | { type: "history"; items: WireChatItem[] }
  | { type: "chat"; item: WireChatItem }
  | { type: "status"; event: string; body: unknown }
  | { type: "output"; data: string } // base64 PTY bytes — chat UI ignores
  | { type: "error"; message: string };

// ---- client → server ----

export type ClientMsg =
  | { type: "list" }
  | { type: "attach"; session_id: string }
  | { type: "input"; session_id: string; data: string }
  | { type: "resize"; session_id: string; cols: number; rows: number };

/** Default dev endpoint: the desktop bridge on loopback (Simulator reaches this). */
export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8456";
