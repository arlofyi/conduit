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

export type DiffLine = {
  kind: "add" | "del" | "ctx" | "gap";
  text: string;
  oldNo: number | null;
  newNo: number | null;
};
export type Diff = {
  filePath: string;
  added: number;
  removed: number;
  created: boolean;
  lines: DiffLine[];
  more: number;
};

/** Fields every item may carry. `seq` is the item's absolute index in the whole parsed
 *  conversation, stamped by `session_transcript` BEFORE it tails to the view limit -- a
 *  stable row key as the window slides. Absent on the bridge and root-chat paths. */
type ItemBase = { seq?: number };

type ItemBody =
  | { kind: "bubble"; role: "user" | "assistant"; text: string }
  | {
      kind: "event";
      event: string;
      label: string;
      mono: string | null;
      toolUseId: string | null;
    }
  | {
      kind: "result";
      toolUseId: string;
      isError: boolean;
      errorText: string | null;
      diff: Diff | null;
    }
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

export type EventItem = Extract<TranscriptItem, { kind: "event" }>;

/** Every kind the pane draws. `usage` is bookkeeping, not a row; `result` is consumed by
 *  pairing with its event. */
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
  "result",
];

/** A tool call with its outcome folded in. */
export type Call = {
  event: EventItem;
  status: "running" | "ok" | "error";
  errorText: string | null;
  diff: Diff | null;
};

export type ChatRow =
  | { type: "item"; item: TranscriptItem }
  | { type: "call"; call: Call }
  | { type: "tools"; calls: Call[] };

/** Quiet = has a result, not an error, no diff. Only quiet calls fold. */
const isQuiet = (c: Call) => c.status === "ok" && c.diff === null;

/** Pair each event with its result by `toolUseId` across the whole list (results arrive on
 *  later lines, past usage lines and bubbles), drop `usage` and `result`, and fold runs of
 *  >= 2 quiet calls. `usage`/`result` are invisible so they never split a run. An orphan
 *  result (its call fell off the tail) is dropped. */
export function groupTools(items: TranscriptItem[]): ChatRow[] {
  const results = new Map<string, Extract<TranscriptItem, { kind: "result" }>>();
  for (const it of items) if (it.kind === "result") results.set(it.toolUseId, it);

  const rows: ChatRow[] = [];
  let run: Call[] = [];
  const flush = () => {
    if (run.length >= 2) rows.push({ type: "tools", calls: run });
    else for (const call of run) rows.push({ type: "call", call });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "usage" || item.kind === "result") continue;
    if (item.kind === "event") {
      const r = item.toolUseId ? results.get(item.toolUseId) : undefined;
      const call: Call = r
        ? { event: item, status: r.isError ? "error" : "ok", errorText: r.errorText, diff: r.diff }
        : { event: item, status: "running", errorText: null, diff: null };
      if (isQuiet(call)) {
        run.push(call);
      } else {
        flush();
        rows.push({ type: "call", call });
      }
      continue;
    }
    flush();
    rows.push({ type: "item", item });
  }
  flush();
  return rows;
}

/** One-line digest of a folded run: buckets in descending count (stable on first seen). */
export function groupLabel(calls: Call[]): string {
  const buckets: [string, string, string][] = [];
  const counts = new Map<string, number>();
  const spec = (k: string): [string, string, string] =>
    k === "bash"
      ? ["bash", "ran %d shell command", "s"]
      : k === "read"
        ? ["read", "read %d file", "s"]
        : k === "search"
          ? ["search", "searched %d time", "s"]
          : k === "web"
            ? ["web", "browsed %d page", "s"]
            : ["other", "called %d tool", "s"];
  for (const c of calls) {
    const sp = spec(c.event.event);
    if (!counts.has(sp[0])) buckets.push(sp);
    counts.set(sp[0], (counts.get(sp[0]) ?? 0) + 1);
  }
  const text = buckets
    .map((b, i) => ({ b, i, n: counts.get(b[0])! }))
    .sort((x, y) => y.n - x.n || x.i - y.i)
    .map(({ b, n }) => b[1].replace("%d", String(n)) + (n === 1 ? "" : b[2]))
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
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
