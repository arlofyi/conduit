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
  // ---- session controls (2026-11-01 spec section 2); absent from older desktops ----
  /** the effort level the session runs at (applies at its next start) */
  effort?: string | null;
  /** pinned "keep running": idle auto-stop skips it */
  keepRunning?: boolean;
  /** the `usage` row (`key`) this session's agent account draws from */
  usageKey?: string | null;
  // ---- auto-approve (2026-11-01 spec section 5, Round 4); absent from older desktops ----
  /** Conduit answers this session's permission prompts itself */
  autoApprove?: boolean;
  // ---- failure (StopFailure); absent from older desktops ----
  /** the last turn ended on an error: its kind ("rate_limit", ...; "error" for a private
   * session); null when the last turn did not fail */
  failed?: string | null;
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
  /** the answer to an explicit `list` when the view has not changed since the last `projects`
   * this socket got (the computer sends identical views only once) */
  | { type: "listed"; unchanged?: boolean }
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
  | { type: "sessionActionResult"; requestId: string; action: "stop" | "delete"; done: string[]; skipped: { id: string; reason: string }[] }
  /** answer to `ports`: the computer's local web apps a phone may mirror (empty when off) */
  | { type: "ports"; enabled: boolean; ports: { port: number; process: string | null }[] }
  /** tunnel sockets only: the computer accepted a `tunnel` frame; raw TCP bytes follow */
  | { type: "tunnelOk"; port: number }
  // ---- session controls + usage (2026-11-01 spec section 2) ----
  | WireSessionOptionsMsg
  | WireSessionSetResult
  | WireUsageMsg
  // ---- the file browser (desktop phone_fs.rs); every answer echoes its requestId ----
  | WireFsListResult
  | WireFsReadResult
  | WireFsWriteResult
  | WireFsChunk
  // ---- the general chat (desktop root_chat.rs via bridge.rs) ----
  | { type: "rootChats"; chats: WireRootChat[] }
  | { type: "rootChatCreated"; requestId: string; chat: WireRootChat }
  | { type: "rootChatHistory"; chatId: string; items: WireChatItem[]; running: boolean }
  | { type: "rootChatScoped"; chatId: string; ok: boolean; scope: WireScope | null }
  | { type: "rootChatSettings"; requestId: string; ok: boolean; chat?: WireRootChat | null; note?: string | null }
  | WireRootChatOptions
  | WireRootChatEvent;

// ---- general chat (root chat, HQ): a non-coding chat across projects ----

/** Which projects a general chat may see: whole profiles (`null` = Default) plus single
 * projects; `allProfiles` is everything. A chat's `scope: null` also means every project. */
export interface WireScope {
  allProfiles: boolean;
  profiles: (string | null)[];
  projects: string[];
}

export interface WireRootChat {
  id: string;
  title: string;
  /** the profile the chat is listed under (`null` = Default) */
  profileId: string | null;
  scope: WireScope | null;
  /** unix SECONDS */
  createdAt: number;
  running: boolean;
  // ---- chat options (2026-11-01 contract §3); older desktops omit them all ----
  /** "claude" | "antigravity", fixed for the chat's life */
  agent?: string;
  /** null = the agent's default */
  model?: string | null;
  effort?: string | null;
  /** deep research: more effort plus a research brief */
  research?: boolean;
  /** user MCP server names opted in */
  mcps?: string[];
}

/** Answer to `rootchatoptions`: what a general chat can be set to on this computer. */
export interface WireRootChatOptions {
  type: "rootChatOptions";
  requestId: string;
  agents: { id: string; label: string; models: { id: string; label: string }[]; efforts: string[] }[];
  skills: { name: string; description?: string | null }[];
  mcps: { name: string }[];
}

/** A chat's options as `rootchatcreate` / `rootchatsettings` carry them (absent = unchanged
 * or the computer's default). */
export interface WireRootChatSettings {
  agent?: string;
  model?: string;
  effort?: string;
  research?: boolean;
  mcps?: string[];
}

/** Pushed to every socket that has sent any rootchat* frame. `user` = a turn started (from
 * this phone or the computer); `item` = a chat item in the session-chat shapes. */
export type WireRootChatEvent =
  | { type: "rootChatEvent"; event: "user"; chatId: string; text: string }
  | { type: "rootChatEvent"; event: "item"; chatId: string; item: WireChatItem }
  | { type: "rootChatEvent"; event: "done"; chatId: string; isError: boolean; result?: string | null; costUsd?: number | null; numTurns?: number | null }
  | { type: "rootChatEvent"; event: "error"; chatId: string; message: string };

// ---- file browser (phone_fs.rs) ----

/** One entry of a session directory. A `link` is shown but can never be opened; a `sensitive`
 * name (.env, a key) asks before it is read and is never writable. */
export interface WireFsEntry {
  name: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
  link?: true;
  sensitive?: true;
}

/** `error` is one of "not available" | "not found" | "confirm" | "read-only" | "conflict" |
 * "too large" or free text; a frame carrying it has none of the success fields. */
export type WireFsListResult =
  | { type: "fsListResult"; requestId: string; path: string; entries: WireFsEntry[]; truncated: number; error?: undefined }
  | { type: "fsListResult"; requestId: string; error: string };

export interface WireFsText {
  path: string;
  /** "" when `binary` */
  content: string;
  binary: boolean;
  /** over the 1 MB text cap: a read-only preview of the start */
  truncated: boolean;
  readOnly: boolean;
  size: number;
  mtimeMs: number;
  sensitive?: boolean;
}
export type WireFsReadResult =
  | ({ type: "fsReadResult"; requestId: string; error?: undefined } & WireFsText)
  | { type: "fsReadResult"; requestId: string; error: string };

export type WireFsWriteResult =
  | { type: "fsWriteResult"; requestId: string; path: string; mtimeMs: number; size: number; error?: undefined }
  | { type: "fsWriteResult"; requestId: string; error: string };

/** One piece of a download (base64, 1-based `seq`); each one not `done` is acked with `fsack`. */
export type WireFsChunk =
  | { type: "fsChunk"; requestId: string; seq: number; data: string; done: boolean; size: number; name: string; error?: undefined }
  | { type: "fsChunk"; requestId: string; error: string };

export type WireFsReply = WireFsListResult | WireFsReadResult | WireFsWriteResult | WireFsChunk;

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
  | { type: "spawn"; project_id: string; prompt: string; agent?: string; worktree?: boolean; name?: string }
  | { type: "interrupt"; sessionId: string }
  | { type: "answer"; askId: string; answers: Record<string, string> }
  | { type: "approve"; id: string; allow: boolean }
  | { type: "upload"; sessionId: string; requestId: string; name: string; data: string; seq: number; done: boolean }
  | { type: "sessionaction"; requestId: string; action: "stop" | "delete"; sessionIds: string[] }
  | { type: "ports" }
  // ---- session controls + usage (2026-11-01 spec section 2) ----
  | { type: "sessionoptions"; sessionId: string; requestId: string }
  | ({ type: "sessionset"; sessionId: string; requestId: string } & SessionSetPatch)
  | { type: "usage"; requestId: string }
  | { type: "fslist"; sessionId: string; requestId: string; path: string }
  | { type: "fsread"; sessionId: string; requestId: string; path: string; confirm?: boolean }
  | { type: "fswrite"; sessionId: string; requestId: string; path: string; content: string; baseMtimeMs: number; baseSize: number }
  | { type: "fsdownload"; sessionId: string; requestId: string; path: string; confirm?: boolean }
  | { type: "fsack"; requestId: string }
  | { type: "rootchats" }
  | ({ type: "rootchatcreate"; requestId: string; profileId: string | null; scope: WireScope | null } & WireRootChatSettings)
  | ({ type: "rootchatsettings"; chatId: string; requestId: string } & Omit<WireRootChatSettings, "agent">)
  | { type: "rootchatoptions"; requestId: string }
  | { type: "rootchathistory"; chatId: string }
  | { type: "rootchatsend"; chatId: string; text: string }
  | { type: "rootchatstop"; chatId: string }
  | { type: "rootchatscope"; chatId: string; scope: WireScope | null };

export const authMsg = (token: string): ClientMsg => ({ type: "auth", token });

export function pairMsg(
  a: { secret: string; deviceName: string; nonce: string } | { request: true; deviceName: string; nonce: string },
): ClientMsg {
  return "secret" in a
    ? { type: "pair", secret: a.secret, deviceName: a.deviceName, nonce: a.nonce }
    : { type: "pair", request: true, deviceName: a.deviceName, nonce: a.nonce };
}

export const discoverMsg = (): ClientMsg => ({ type: "discover" });
/** Ask for the computer's local web apps; answered by `ports`. (The `tunnel` frame that opens
 * one is sent by the native mirror on its own socket, never on this one.) */
export const portsMsg = (): ClientMsg => ({ type: "ports" });
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
/** List one folder of a session's directory ("" = its root); answered by `fsListResult`. */
export const fsListMsg = (sessionId: string, requestId: string, path: string): ClientMsg => ({ type: "fslist", sessionId, requestId, path });
/** Read a file as text; `confirm` opens a secret the computer flagged. Answered by `fsReadResult`. */
export const fsReadMsg = (sessionId: string, requestId: string, path: string, confirm = false): ClientMsg => ({
  type: "fsread",
  sessionId,
  requestId,
  path,
  ...(confirm ? { confirm: true } : {}),
});
/** Save an edit. `base` is the stat of the read the edit started from: a file changed on the
 * computer since is refused as "conflict", never overwritten. Answered by `fsWriteResult`. */
export const fsWriteMsg = (
  sessionId: string,
  requestId: string,
  path: string,
  content: string,
  base: { mtimeMs: number; size: number },
): ClientMsg => ({ type: "fswrite", sessionId, requestId, path, content, baseMtimeMs: base.mtimeMs, baseSize: base.size });
/** Download a file as `fsChunk` frames (the computer sends the next only after an `fsack`). */
export const fsDownloadMsg = (sessionId: string, requestId: string, path: string, confirm = false): ClientMsg => ({
  type: "fsdownload",
  sessionId,
  requestId,
  path,
  ...(confirm ? { confirm: true } : {}),
});
export const fsAckMsg = (requestId: string): ClientMsg => ({ type: "fsack", requestId });

// General chat. The first rootchat* frame on a socket subscribes it to `rootChatEvent`.
/** List every general chat; answered by `rootChats`. */
export const rootChatsMsg = (): ClientMsg => ({ type: "rootchats" });
/** Start a general chat listed under `profileId`; answered by `rootChatCreated`. The options
 * ride along only when set, so an older desktop sees the frame it always did. */
export const rootChatCreateMsg = (
  requestId: string,
  profileId: string | null,
  scope: WireScope | null,
  settings: WireRootChatSettings = {},
): ClientMsg => ({
  type: "rootchatcreate",
  requestId,
  profileId,
  scope,
  ...definedOnly(settings),
});
/** Change a chat's options (only the fields named); answered by `rootChatSettings`. A model or
 * effort of "" means the agent's default. */
export const rootChatSettingsMsg = (chatId: string, requestId: string, patch: Omit<WireRootChatSettings, "agent">): ClientMsg => ({
  type: "rootchatsettings",
  chatId,
  requestId,
  ...definedOnly(patch),
});
/** What a chat can be set to (agents, models, efforts, skills, MCP servers); answered by
 * `rootChatOptions`. An older desktop never answers. */
export const rootChatOptionsMsg = (requestId: string): ClientMsg => ({ type: "rootchatoptions", requestId });

function definedOnly<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
/** A chat's history so far; answered by `rootChatHistory`. */
export const rootChatHistoryMsg = (chatId: string): ClientMsg => ({ type: "rootchathistory", chatId });
/** One message: the turn streams back as `rootChatEvent`s (a refusal as an `error` event). */
export const rootChatSendMsg = (chatId: string, text: string): ClientMsg => ({ type: "rootchatsend", chatId, text });
export const rootChatStopMsg = (chatId: string): ClientMsg => ({ type: "rootchatstop", chatId });
/** Change which projects a chat covers (`null` = every project); answered by `rootChatScoped`. */
export const rootChatScopeMsg = (chatId: string, scope: WireScope | null): ClientMsg => ({ type: "rootchatscope", chatId, scope });
/** Start a new session in a project; the Mac answers `spawned` or `error`. An empty `prompt`
 * starts the agent idle; a blank `name` lets the Mac derive one from the prompt. */
export const spawnMsg = (projectId: string, prompt: string, agent: string, name = ""): ClientMsg => ({
  type: "spawn",
  project_id: projectId,
  prompt,
  agent,
  ...(name.trim() ? { name: name.trim() } : {}),
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
  if (files > 0) return 1200 + 300 * files;
  // A slash command opens Claude Code's command menu as it arrives, and an Enter in the same
  // burst is taken by the menu: `/compact` sat in the composer until the user pressed Enter.
  return isSlashCommand(text) ? SLASH_SUBMIT_DELAY_MS : 0;
}

/** How long a slash command's Enter waits for Claude Code's command menu to draw. */
export const SLASH_SUBMIT_DELAY_MS = 600;

/** One line starting with `/`, like `/compact` or `/model opus`. */
export function isSlashCommand(text: string): boolean {
  const t = text.trim();
  return /^\/[A-Za-z]/.test(t) && !t.includes("\n");
}

// ---- session controls + usage (2026-11-01 spec sections 2 and 4) ----
// Every field is read defensively by logic/sessionOptions.ts and logic/usage.ts: an older
// desktop omits them, and the Rust side was written in parallel against these names.

export interface WireModelOption {
  id: string;
  label: string;
}
export interface WireCommandOption {
  name: string;
  description: string;
  kind: "builtin" | "command" | "skill";
}
export interface WireMcpOption {
  name: string;
  source: string;
  enabled: boolean;
}

/** The answer to `sessionoptions`: what this session can be switched to and steered with. */
export interface WireSessionOptionsMsg {
  type: "sessionOptions";
  requestId: string;
  sessionId: string;
  agent: string;
  model: string | null;
  effort: string | null;
  keepRunning: boolean;
  /** true: a model change applies now (the agent's own /model); false: at the next start */
  modelLive: boolean;
  models: WireModelOption[];
  efforts: string[];
  commands: WireCommandOption[];
  mcps: WireMcpOption[];
  // ---- auto-approve (Round 4); absent from older desktops ----
  autoApprove?: boolean;
  /** the agent has an auto-approve switch (Antigravity for now) */
  autoApproveSupported?: boolean;
}

/** Only the keys present are changed. */
export interface SessionSetPatch {
  model?: string;
  effort?: string;
  name?: string;
  keepRunning?: boolean;
  /** Round 4: Conduit allows every request of this session itself */
  autoApprove?: boolean;
}

export interface WireSessionSetResult {
  type: "sessionSetResult";
  requestId: string;
  ok: boolean;
  /** what happened ("Switched to Sonnet", "Applies at the next start", why it was refused) */
  note: string | null;
}

export interface WireUsageWindow {
  /** desktop WinKind: "fiveHour" | "weekly" | "weeklyOpus" | "context" | "credit" */
  kind: string;
  label: string;
  /** fraction CONSUMED, 0..1 */
  used: number;
  resetsAt: string | number | null;
}

/** One usage row: one agent account (`key` matches a session's `usageKey`). */
export interface WireUsageRow {
  key: string;
  agent: string;
  label: string;
  plan: string | null;
  windows: WireUsageWindow[];
  /** prepaid credit (OpenRouter): `limit` null = uncapped, so no bar */
  money?: { spent: number; limit: number | null; remaining: number | null } | null;
  models?: (string | WireModelOption)[] | null;
  updatedAt: number | string | null;
  source: string | null;
}

export interface WireUsageMsg {
  type: "usage";
  requestId: string;
  agents: WireUsageRow[];
}

/** Ask for a session's models, efforts, commands/skills and MCP servers; answered by `sessionOptions`. */
export const sessionOptionsMsg = (sessionId: string, requestId: string): ClientMsg => ({ type: "sessionoptions", sessionId, requestId });
/** Change a session's model / effort / name / keep-running; answered by `sessionSetResult`. */
export const sessionSetMsg = (sessionId: string, requestId: string, patch: SessionSetPatch): ClientMsg => ({
  type: "sessionset",
  sessionId,
  requestId,
  ...(patch.model !== undefined ? { model: patch.model } : {}),
  ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
  ...(patch.name !== undefined ? { name: patch.name } : {}),
  ...(patch.keepRunning !== undefined ? { keepRunning: patch.keepRunning } : {}),
  ...(patch.autoApprove !== undefined ? { autoApprove: patch.autoApprove } : {}),
});
/** Ask for every agent account's cached usage; answered by `usage`. */
export const usageMsg = (requestId: string): ClientMsg => ({ type: "usage", requestId });
