/**
 * Wire protocol for the Conduit mobile bridge (the Rust `bridge.rs` WebSocket).
 * These types mirror the server→client / client→server JSON exactly. A mapping
 * layer (live.ts) turns them into the UI types in src/data/types.ts.
 */

// ---- server → client ----

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

// ---- typed `projects` view (desktop bridge_view.rs) ----

export type WireStatus = "idle" | "running" | "needsInput" | "done";

export type WireNeeds = { kind: "ask"; text: string | null } | { kind: "input"; text: null } | null;

export interface WireViewSession {
  id: string;
  name: string;
  /** lowercase desktop AgentId; unknown ids render as "?" */
  agent: string;
  branch: string | null;
  model: string | null;
  stopped: boolean;
  running: boolean;
  /** private / local-only: listed but never previewed or openable */
  silo: boolean;
  status: WireStatus;
  activity: string | null;
  /** unix ms */
  updatedAt: number | null;
  needs: WireNeeds;
}

export interface WireViewProject {
  id: string;
  name: string;
  profileId: string | null;
  /** user-chosen colour only; the phone derives the accent otherwise */
  color: string | null;
  sessions: WireViewSession[];
}

export interface WireProfile {
  id: string | null;
  name: string;
}

export interface WireProjectsView {
  profiles: WireProfile[];
  activeProfileId: string | null;
  projects: WireViewProject[];
}

export interface WireMac {
  name: string;
  dnsName: string;
  ip: string;
  port: number;
  online: boolean;
  conduitVersion: string;
}

export type PairFailReason = "declined" | "expired" | "replaced" | "off" | "error";

/** The only protocol version this build speaks. */
export const PROTOCOL_VERSION = 1;

export type ServerMsg =
  | { type: "hello"; macName: string; conduitVersion: string; protocolVersion: number }
  | { type: "authOk"; deviceId: string }
  | { type: "error"; message: string }
  | { type: "pairPending"; requestId: string }
  | { type: "pairResult"; ok: true; token: string; deviceId: string }
  | { type: "pairResult"; ok: false; reason: string }
  | { type: "macs"; macs: WireMac[] }
  | ({ type: "projects" } & WireProjectsView)
  | { type: "context"; sessionId: string; used: number; window: number; fraction: number; model: string | null }
  | { type: "size"; cols: number; rows: number }
  | { type: "history"; items: WireChatItem[] }
  | { type: "chat"; item: WireChatItem }
  | { type: "status"; event: string; body: unknown }
  | { type: "output"; data: string } // base64 PTY bytes — chat UI ignores
  | { type: "killed"; sessionId: string }
  | { type: "gitresult"; action: string; [k: string]: unknown }
  | { type: "spawned"; sessionId: string; name: string; projectId: string };

// ---- client → server ----
// Spellings are mixed ON PURPOSE (pinned by Rust tests): attach/input/resize/git/kill/spawn use
// snake_case, pair uses camelCase deviceName, interrupt uses camelCase sessionId.

export type ClientMsg =
  | { type: "auth"; token: string }
  | { type: "pair"; secret?: string; request?: true; deviceName: string; nonce: string }
  | { type: "discover" }
  | { type: "list" }
  | { type: "attach"; session_id: string }
  | { type: "input"; session_id: string; data: string }
  | { type: "resize"; session_id: string; cols: number; rows: number }
  | { type: "git"; session_id: string; action: "changes" | "diff"; path?: string }
  | { type: "kill"; session_id: string }
  | { type: "spawn"; project_id: string; prompt: string; agent?: string; worktree?: boolean }
  | { type: "interrupt"; sessionId: string };

export const authMsg = (token: string): ClientMsg => ({ type: "auth", token });

export function pairMsg(
  a: { secret: string; deviceName: string; nonce: string } | { request: true; deviceName: string; nonce: string },
): ClientMsg {
  return "secret" in a
    ? { type: "pair", secret: a.secret, deviceName: a.deviceName, nonce: a.nonce }
    : { type: "pair", request: true, deviceName: a.deviceName, nonce: a.nonce };
}

export const discoverMsg = (): ClientMsg => ({ type: "discover" });
export const listMsg = (): ClientMsg => ({ type: "list" });
export const attachMsg = (id: string): ClientMsg => ({ type: "attach", session_id: id });
export const inputMsg = (id: string, data: string): ClientMsg => ({ type: "input", session_id: id, data });
export const interruptMsg = (id: string): ClientMsg => ({ type: "interrupt", sessionId: id });
