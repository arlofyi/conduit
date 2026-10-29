/** The typed transcript item model, mirroring `transcript.rs` / `transcript_user.rs`.
 *
 *  Kept free of store/Tauri imports so it stays importable under the node-env vitest.
 *  `src-tauri/src/transcript_item_kinds.json` is the manifest of kinds Rust can emit; a
 *  test pins `RENDERED_KINDS` to it so a new Rust kind cannot ship without a decision here. */

export type QuestionOption = { label: string; description: string };
export type QuestionSpec = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
};

/** Fields every item may carry. `seq` is the item's absolute index in the whole parsed
 *  conversation, stamped by `session_transcript` BEFORE it tails to the view limit -- a
 *  stable row key as the window slides. Absent on the bridge and root-chat paths. */
type ItemBase = { seq?: number };

type ItemBody =
  | { kind: "bubble"; role: "user" | "assistant"; text: string }
  | { kind: "event"; event: string; label: string; mono: string | null }
  | {
      kind: "usage";
      model: string | null;
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
  | { kind: "question"; toolUseId: string; questions: QuestionSpec[] }
  | { kind: "plan"; markdown: string }
  | { kind: "note"; tag: string; text: string };

export type TranscriptItem = ItemBase & ItemBody;

type EventItem = Extract<TranscriptItem, { kind: "event" }>;

/** Every kind the pane draws. `usage` is bookkeeping, not a row. */
export const RENDERED_KINDS: readonly string[] = [
  "bubble",
  "event",
  "task",
  "peer",
  "auto",
  "command",
  "command_output",
  "skill",
  "image",
  "divider",
  "question",
  "plan",
  "note",
];

export type ChatRow =
  | { type: "item"; item: TranscriptItem }
  | { type: "tools"; events: EventItem[] };

/** Drop `usage` and fold each run of consecutive tool events into one row. A `usage` line
 *  between two events does not break the run: it is invisible, so it must not split it. */
export function groupTools(items: TranscriptItem[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let run: EventItem[] | null = null;
  for (const item of items) {
    if (item.kind === "usage") continue;
    if (item.kind === "event") {
      if (!run) {
        run = [];
        rows.push({ type: "tools", events: run });
      }
      run.push(item);
      continue;
    }
    run = null;
    rows.push({ type: "item", item });
  }
  return rows;
}

/** One-line digest of a tool run: per event kind in first-seen order, the verb plus the
 *  target when it happened once, else a count. */
export function toolsSummary(events: EventItem[]): string {
  const order: string[] = [];
  const groups = new Map<string, EventItem[]>();
  for (const e of events) {
    let g = groups.get(e.event);
    if (!g) {
      g = [];
      groups.set(e.event, g);
      order.push(e.event);
    }
    g.push(e);
  }
  return order
    .map((k) => {
      const g = groups.get(k)!;
      const label = g[0].label;
      if (g.length === 1) return g[0].mono ? `${label} ${g[0].mono}` : label;
      const unit = k === "read" || k === "edit" ? "files" : "times";
      return `${label} ${g.length} ${unit}`;
    })
    .join(" · ");
}

const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Data URI for an inline image, or null. Only exact raster types pass: the type came off
 *  a transcript file, and SVG is a document format that can carry script. */
export function imageSrc(item: { mediaType: string; data: string | null }): string | null {
  if (item.data === null || !RASTER_TYPES.has(item.mediaType)) return null;
  return `data:${item.mediaType};base64,${item.data}`;
}

/** How a background-task notification reads in the pane. */
export function taskLine(status: string): { mark: "ok" | "bad" | "info"; text: string } {
  switch (status) {
    case "completed":
      return { mark: "ok", text: "Background task finished" };
    case "failed":
    case "error":
      return { mark: "bad", text: "Background task failed" };
    case "stopped":
    case "killed":
      return { mark: "info", text: "Background task stopped" };
    default:
      return { mark: "info", text: "Background task update" };
  }
}
