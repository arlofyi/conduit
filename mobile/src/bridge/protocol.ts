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

/** A transcript-derived chat item (no id on the wire). Kinds mirror src-tauri/src/transcript_item_kinds.json.
 * `at` is the transcript line's ISO timestamp, omitted when the line had none. */
export type WireChatItem = WireChatBody & { at?: string };

type WireChatBody =
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

/** The session's last chat bubble as plain text (<= 160 chars); null for silo / non-Claude / none. */
export interface WireLastMessage {
  role: "user" | "assistant";
  text: string;
  /** ISO time of the line; null when it had none */
  at: string | null;
}

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
  lastMessage: WireLastMessage | null;
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

// ---- questions + permissions waiting on a human (bridge_view.rs ask_push / permission_push) ----

/** Who settled a pending item (asks.rs `By`). `cancelled` = the turn moved on: drop it silently. */
export type WireBy = "phone" | "desktop" | "terminal" | "timeout" | "cancelled";

/** A held AskUserQuestion. `kind` is absent from no shipped desktop, but an absent kind reads as "ask". */
export interface WirePendingAsk {
  kind?: "ask";
  id: string;
  sessionId: string;
  /** joins the transcript's `question` item */
  toolUseId: string;
  /** Claude's `tool_input.questions`, verbatim */
  questions: WireQuestion[];
  createdMs: number;
}

/** A held PermissionRequest. No `toolUseId`: it is never joined to a transcript card. */
export interface WirePendingPermission {
  kind: "permission";
  id: string;
  sessionId: string;
  toolName: string;
  /** one line: the command, the file, or the tool name */
  summary: string;
  createdMs: number;
}

/** A silo'd / local-only session's item: exactly these keys, nothing about what it asks. */
export interface WirePendingPrivate {
  kind?: "ask" | "permission";
  id: string;
  sessionId: string;
  private: true;
}

export type WirePendingItem = WirePendingAsk | WirePendingPermission | WirePendingPrivate;

export type PairFailReason = "declined" | "expired" | "replaced" | "off" | "error";

/** The only protocol version this build speaks. */
export const PROTOCOL_VERSION = 1;

export type ServerMsg =
  | { type: "hello"; macName: string; conduitVersion: string; protocolVersion: number }
  | { type: "authOk"; deviceId: string }
  | { type: "error"; message: string; sessionId?: string }
  | { type: "pairPending"; requestId: string }
  | { type: "pairResult"; ok: true; token: string; deviceId: string }
  | { type: "pairResult"; ok: false; reason: string }
  | { type: "macs"; macs: WireMac[] }
  | ({ type: "projects" } & WireProjectsView)
  | { type: "context"; sessionId: string; used: number; window: number; fraction: number; model: string | null }
  | { type: "size"; cols: number; rows: number }
  // `sessionId` names the session the frame is about; absent from desktops before it was added.
  | { type: "history"; sessionId?: string; items: WireChatItem[] }
  | { type: "chat"; sessionId?: string; item: WireChatItem }
  | { type: "status"; sessionId?: string; event: string; body: unknown }
  | { type: "output"; data: string } // base64 PTY bytes — chat UI ignores
  | { type: "killed"; sessionId: string }
  | { type: "gitresult"; action: string; [k: string]: unknown }
  | { type: "spawned"; sessionId: string; name: string; projectId: string }
  // Sent once after trust, then diffs every <= 250 ms (bridge_view.rs push_frames).
  | { type: "pending"; asks: WirePendingItem[]; permissions: WirePendingItem[] }
  | { type: "pendingAdded"; item: WirePendingItem }
  | { type: "resolved"; id: string; by: WireBy }
  // ok:false = already resolved elsewhere, a private session, or answers the Mac would not accept
  | { type: "answerResult"; askId: string; ok: boolean }
  | { type: "approveResult"; id: string; ok: boolean }
  /** the answer to one `upload`: the file's path for the message, or why not */
  /** a non-final upload chunk arrived; send the next */
  | { type: "uploadProgress"; requestId: string; seq: number }
  | { type: "uploadResult"; requestId: string; ok: true; path: string }
  | { type: "uploadResult"; requestId: string; ok: false; error: string }
  /** the answer to one `sessionaction`: what was done, and what was refused and why */
  | { type: "sessionActionResult"; requestId: string; action: "stop" | "delete"; done: string[]; skipped: { id: string; reason: string }[] };

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
  | { type: "interrupt"; sessionId: string }
  | { type: "answer"; askId: string; answers: Record<string, string> }
  | { type: "approve"; id: string; allow: boolean }
  | { type: "upload"; sessionId: string; requestId: string; name: string; data: string; seq: number; done: boolean }
  | { type: "sessionaction"; requestId: string; action: "stop" | "delete"; sessionIds: string[] };

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
/** Answer a held question: exact question text -> answer (multi-select already joined ", "). */
export const answerMsg = (askId: string, answers: Record<string, string>): ClientMsg => ({ type: "answer", askId, answers });
/** Allow or deny a held permission. */
export const approveMsg = (id: string, allow: boolean): ClientMsg => ({ type: "approve", id, allow });
/** One chunk of a file for a session's `.conduit-uploads/`: answered by `uploadProgress`, or
 * `uploadResult` for the last chunk (or a refusal at any chunk). */
export const uploadMsg = (sessionId: string, requestId: string, name: string, data: string, seq: number, done: boolean): ClientMsg => ({
  type: "upload",
  sessionId,
  requestId,
  name,
  data,
  seq,
  done,
});
/** Stop or delete sessions picked on the Chats list; answered by `sessionActionResult`. */
export const sessionActionMsg = (requestId: string, action: "stop" | "delete", sessionIds: string[]): ClientMsg => ({
  type: "sessionaction",
  requestId,
  action,
  sessionIds,
});
/** Start a new session in a project with its first message; the Mac answers `spawned` or `error`. */
export const spawnMsg = (projectId: string, prompt: string, agent: string): ClientMsg => ({
  type: "spawn",
  project_id: projectId,
  prompt,
  agent,
});

/** A chat message as PTY input: bracketed paste around the text, then a bare `\r`.
 * Mirrors the desktop's `pty::paste_and_submit` (src-tauri/src/pty.rs) -- keep them in step.
 * A plain `text + "\r"` works only for short lines: Claude Code reads a long burst as a
 * PASTE, the `\r` lands inside it as one more newline, and the message sits unsent in the
 * composer (seen in the Simulator with an 80-character prompt). The end marker makes the
 * `\r` a keypress even when everything arrives in one read. ESC is dropped from the body
 * so a `CSI 201~` inside it cannot close the paste early. */
export function promptInput(text: string): string {
  return `${pasteInput(text)}\r`;
}

/** The bracketed paste alone, for a prompt whose Enter must come later (`submitDelayMs`). */
export function pasteInput(text: string): string {
  const body = text.split("\u001b").join("");
  return `\u001b[200~${body}\u001b[201~`;
}

/**
 * How long to hold the Enter after the paste, or 0 to send both in one frame. A paste that
 * names uploaded files makes Claude Code turn each `@path` into an attachment as it arrives,
 * and an Enter in the same burst lands while it is still doing that and is dropped: the
 * message sat in Claude's composer as a draft (seen: one image went through, two did not).
 * Plain text keeps the single frame it has always used.
 */
export function submitDelayMs(text: string): number {
  const files = text.split("@.conduit-uploads/").length - 1;
  return files === 0 ? 0 : 1200 + 300 * files;
}
