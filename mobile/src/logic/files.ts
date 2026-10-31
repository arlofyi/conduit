/**
 * The phone's file browser, pure parts: paths inside a session's directory, the breadcrumb,
 * how a listing is ordered and labelled, what kind of file a name is, and what each refusal
 * from the computer (desktop `phone_fs.rs`) means to the reader.
 *
 * Paths are RELATIVE to the session's directory and "/"-separated on every platform, with ""
 * as the root -- the computer resolves them, and refuses anything that leaves the directory.
 */
import type { WireFsEntry } from "../bridge/protocol";

/** An image larger than this is offered as a download instead of drawn inline. */
export const INLINE_IMAGE_MAX = 16 * 1024 * 1024;
/** The computer's own download cap (phone_fs.rs DOWNLOAD_CAP). */
export const DOWNLOAD_MAX = 50 * 1024 * 1024;

/** Trim slashes and empty segments: " /a//b/ " -> "a/b". */
export function normPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

export function joinPath(dir: string, name: string): string {
  const d = normPath(dir);
  const n = normPath(name);
  return d ? (n ? `${d}/${n}` : d) : n;
}

/** The folder holding `path`; the root's parent is the root. */
export function parentPath(path: string): string {
  const parts = normPath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

/** The last segment: "src/app.ts" -> "app.ts"; the root has none. */
export function baseName(path: string): string {
  const parts = normPath(path).split("/");
  return parts[parts.length - 1] ?? "";
}

export interface Crumb {
  /** shown text; the root reads as `rootLabel` */
  label: string;
  path: string;
}

/** The root, then each folder down to `path` (inclusive). */
export function crumbs(path: string, rootLabel: string): Crumb[] {
  const out: Crumb[] = [{ label: rootLabel, path: "" }];
  let acc = "";
  for (const seg of normPath(path).split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg;
    out.push({ label: seg, path: acc });
  }
  return out;
}

/** Folders first, then files, each by name ignoring case (numbers in natural order). */
export function sortEntries(entries: readonly WireFsEntry[]): WireFsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

/** "0 B" / "812 B" / "4.2 KB" / "3.4 MB" / "1.2 GB" */
export function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export type FileKind = "image" | "markdown" | "text";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "heic", "heif"]);
const MARKDOWN_EXT = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

function ext(name: string): string {
  const n = baseName(name).toLowerCase();
  const dot = n.lastIndexOf(".");
  return dot > 0 ? n.slice(dot + 1) : "";
}

/** How the viewer opens a file. Everything not an image or markdown is tried as text (the
 * computer says `binary` when it is not). SVG is text: it is code, and drawing it would need
 * a renderer the app does not ship. */
export function fileKind(name: string): FileKind {
  const e = ext(name);
  if (IMAGE_EXT.has(e)) return "image";
  if (MARKDOWN_EXT.has(e)) return "markdown";
  return "text";
}

const LANGS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript (JSX)",
  js: "JavaScript",
  jsx: "JavaScript (JSX)",
  mjs: "JavaScript",
  cjs: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  rs: "Rust",
  py: "Python",
  go: "Go",
  rb: "Ruby",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C header",
  cpp: "C++",
  cc: "C++",
  hpp: "C++ header",
  cs: "C#",
  php: "PHP",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  bat: "Batch",
  cmd: "Batch",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  svg: "SVG",
  xml: "XML",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  ini: "INI",
  sql: "SQL",
  md: "Markdown",
  markdown: "Markdown",
  mdx: "MDX",
  txt: "Plain text",
  log: "Log",
  csv: "CSV",
  lock: "Lockfile",
};

const NAMED: Record<string, string> = {
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  license: "Plain text",
  readme: "Plain text",
  ".gitignore": "Git ignore",
  ".env": "Environment",
};

/** A short language label for the viewer's header, or null when there is no good guess. */
export function languageOf(name: string): string | null {
  const n = baseName(name).toLowerCase();
  if (NAMED[n]) return NAMED[n];
  if (n.startsWith(".env")) return "Environment";
  return LANGS[ext(n)] ?? null;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
};

/** The type the share sheet is told; anything unknown is offered as plain bytes. */
export function mimeOf(name: string): string {
  const e = ext(name);
  if (MIME[e]) return MIME[e];
  if (fileKind(name) === "text" && LANGS[e]) return "text/plain";
  return "application/octet-stream";
}

/** The computer's "this looks like a secret" refusal: ask, then resend with `confirm`. */
export const NEEDS_CONFIRM = "confirm";
export const CONFLICT = "conflict";
/** Phone-side failures, spelled like the computer's so one function words them all. */
export const TIMEOUT = "timeout";
export const NOT_CONNECTED = "not connected";
export const PRIVATE = "private session";
export const CANCELLED = "cancelled";

export const SECRET_PROMPT = "This looks like a secret (.env, key). Open anyway?";

/** What a refusal means to the reader. */
export function fsErrorText(error: string): string {
  switch (error) {
    case "not available":
      return "This can't be opened from the phone.";
    case "not found":
      return "Not found on your computer. It may have been moved or deleted.";
    case "read-only":
      return "This file can't be changed from the phone.";
    case CONFLICT:
      return "The file changed on your computer since you opened it.";
    case "too large":
      return "Too large to open on the phone.";
    case NEEDS_CONFIRM:
      return SECRET_PROMPT;
    case TIMEOUT:
      return "Your computer didn't answer. Check the connection and try again.";
    case NOT_CONNECTED:
      return "Not connected to your computer.";
    case PRIVATE:
      return "This session is private: its files stay on your computer.";
    case CANCELLED:
      return "Cancelled.";
    default:
      return error ? error.charAt(0).toUpperCase() + error.slice(1) : "Something went wrong.";
  }
}

/** A file the editor may offer to change: whole, text, and not a secret. */
export function canEdit(r: { binary: boolean; truncated: boolean; readOnly: boolean; sensitive?: boolean }): boolean {
  return !r.binary && !r.truncated && !r.readOnly && !r.sensitive;
}

/** The text split into lines for the numbered viewer ("a\nb\n" is two lines, not three). */
export function splitLines(text: string): string[] {
  if (text === "") return [""];
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A name safe to create in the phone's cache: no separators, no reserved characters. */
export function cacheName(name: string): string {
  const clean = baseName(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return clean && clean !== "." && clean !== ".." ? clean.slice(0, 120) : "file";
}

/** The second line of a listing row: "4.2 KB · Yesterday" for a file, the time for a folder. */
export function entryDetail(e: WireFsEntry, when: string): string {
  if (e.link) return "Link";
  if (e.dir) return when;
  return when ? `${formatSize(e.size)} · ${when}` : formatSize(e.size);
}
