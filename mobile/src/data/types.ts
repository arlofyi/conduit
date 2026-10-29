/** Data model for the mobile companion. Mirrors the desktop's session/status
 * vocabulary (src/store.ts LiveState + src/themes.ts) so the two stay legible
 * to each other. Filled from the desktop bridge. */

import type { WireDiff, WireProjectsView, WireQuestion, WireViewProject, WireViewSession } from "../bridge/protocol";

/** A paired Mac as stored in the Keychain (one slot per Mac). */
export interface SavedMac {
  deviceId: string;
  token: string;
  macName: string;
  dnsName: string;
  ip: string;
  port: number;
  pairedAt: number;
}

/** Same four states as the desktop `SessionStatus` (src/store.ts). */
export type SessionStatus = "idle" | "running" | "needsInput" | "done";

export interface TodoProgress {
  done: number;
  total: number;
}

/** The Mac's typed projects view, as the Chats list reads it (src-tauri/src/bridge_view.rs). */
export type ProjectsView = WireProjectsView;
export type ViewProject = WireViewProject;
export type ViewSession = WireViewSession;

// ---- chat feed items ----

export type ChatRole = "user" | "assistant";
export type EventKind = "read" | "bash" | "edit" | "search" | "web" | "subagent" | "generic";
export type TodoStatus = "pending" | "in_progress" | "completed";

/** Every feed item: `at` is the transcript line's ISO time when it had one (none for items the
 * phone made itself, e.g. its own "Interrupted" divider). */
export interface ItemBase {
  at?: string;
}

export interface BubbleItem extends ItemBase {
  kind: "bubble";
  id: string;
  role: ChatRole;
  text: string;
}

export interface EventItem extends ItemBase {
  kind: "event";
  id: string;
  event: EventKind;
  /** verb, e.g. "read" / "ran" / "edited" */
  label: string;
  /** monospace detail, e.g. "src/auth/login.ts" or "npm test" */
  mono?: string;
  /** trailing ok marker, e.g. "✓ 12" */
  ok?: string;
  /** pairs this call with its `ResultItem` */
  toolUseId?: string;
}

/** A tool call's outcome. Never rendered on its own; `groupFeed` folds it into its call. */
export interface ResultItem extends ItemBase {
  kind: "result";
  id: string;
  toolUseId: string;
  isError: boolean;
  errorText: string | null;
  diff: WireDiff | null;
}

export interface TodosItem extends ItemBase {
  kind: "todos";
  id: string;
  done: number;
  total: number;
  items: { text: string; status: TodoStatus }[];
}

export interface ApprovalItem extends ItemBase {
  kind: "approval";
  id: string;
  tool: string;
  input: string;
  /** undefined while pending; set once answered */
  resolved?: "allow" | "deny";
}

export interface NoticeItem extends ItemBase {
  kind: "notice";
  id: string;
  tone: "ok" | "bad" | "info";
  text: string;
  detail?: string;
}

export interface DividerItem extends ItemBase {
  kind: "divider";
  id: string;
  label: string;
  tone: "info" | "warning";
}

export interface CommandItem extends ItemBase {
  kind: "command";
  id: string;
  name: string;
  args: string;
  output?: string;
}

export interface ImageItem extends ItemBase {
  kind: "image";
  id: string;
  mediaType: string;
  data: string | null;
}

export interface QuestionItem extends ItemBase {
  kind: "question";
  id: string;
  toolUseId: string;
  questions: WireQuestion[];
}

export interface PlanItem extends ItemBase {
  kind: "plan";
  id: string;
  markdown: string;
}

export type ChatItem =
  | BubbleItem
  | EventItem
  | ResultItem
  | TodosItem
  | ApprovalItem
  | NoticeItem
  | DividerItem
  | CommandItem
  | ImageItem
  | QuestionItem
  | PlanItem;
