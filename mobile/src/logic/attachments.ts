/**
 * Files attached to a message from the phone (photos, camera shots, documents). Pure.
 *
 * A file is uploaded the moment it is picked (`upload` frame, see the desktop's uploads.rs);
 * the Mac writes it into the session's `.conduit-uploads/` and answers with a path relative
 * to the session directory. The message then names each file as `@<path>`, which Claude Code
 * resolves as an attachment. Design:
 * docs/superpowers/specs/2026-10-31-mobile-attachments-design.md.
 */

/** Must match the desktop's `uploads::MAX_UPLOAD_BYTES`. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Files per message: enough for a set of screenshots, few enough to stay a message. */
export const MAX_ATTACHMENTS = 6;
/** Photos are re-encoded to this longest edge before upload. */
export const PHOTO_MAX_EDGE = 2048;

export type Attachment = {
  id: string;
  name: string;
  kind: "image" | "file";
  /** local URI, for an image thumbnail */
  uri: string;
  state: "uploading" | "ready" | "failed";
  /** relative path on the Mac once uploaded */
  path?: string;
  error?: string;
};

/** Decoded size of a base64 body, without decoding it. */
export function decodedBytes(b64: string): number {
  const s = b64.trim();
  if (!s) return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

export function tooLarge(b64: string): boolean {
  return decodedBytes(b64) > MAX_UPLOAD_BYTES;
}

/** "3.4 MB" / "820 KB" */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * The text that goes to the agent: every uploaded file as `@path`, FIRST, then the typed text.
 * Paths first and a separator after them so Claude's `@` autocomplete is closed again before
 * the Enter that submits (a message ENDING in `@path` could have the Enter pick a suggestion
 * instead of sending). A path with a space is quoted, Claude's own form for one.
 */
export function composeMessage(text: string, attachments: readonly Attachment[]): string {
  const refs = attachments
    .filter((a) => a.state === "ready" && a.path)
    .map((a) => (/\s/.test(a.path as string) ? `@"${a.path}"` : `@${a.path}`));
  const body = text.trim();
  if (refs.length === 0) return body;
  return body ? `${refs.join(" ")} ${body}` : `${refs.join(" ")} `;
}

/** Send is allowed with text or a ready file, and never while a file is still uploading. */
export function canSendWith(text: string, attachments: readonly Attachment[]): boolean {
  if (attachments.some((a) => a.state === "uploading")) return false;
  return text.trim().length > 0 || attachments.some((a) => a.state === "ready");
}

/** A name for a picked asset that came without one (camera shots, some galleries). */
export function nameFor(fileName: string | null | undefined, kind: "image" | "file", n: number, jpeg: boolean): string {
  const base = fileName?.split(/[\\/]/).pop()?.trim();
  if (!base) return kind === "image" ? `photo-${n}.jpg` : `file-${n}`;
  // A re-encoded photo is a JPEG whatever it was picked as (HEIC, PNG).
  if (jpeg) return base.replace(/\.[^.]*$/, "") + ".jpg";
  return base;
}
