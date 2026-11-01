/**
 * "Save to folder" (Android Storage Access Framework): pure helpers. The native half is
 * data/saveFolder.ts.
 */

/** The SecureStore key that remembers the last folder the reader picked (a SAF tree URI). */
export const SAVE_FOLDER_KEY = "saveFolder";

/**
 * A readable name for a SAF tree URI, for "Saved to <folder>":
 * `content://com.android.externalstorage.documents/tree/primary%3ADownload%2FConduit` ->
 * "Conduit"; the volume root (`primary:`) -> "Internal storage". Anything unrecognised ->
 * "the folder you picked".
 */
export function folderLabel(uri: string | null | undefined): string {
  const fallback = "the folder you picked";
  if (!uri) return fallback;
  const m = /\/tree\/([^/?#]+)/.exec(uri);
  if (!m) return fallback;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return fallback;
  }
  const colon = id.indexOf(":");
  const volume = colon >= 0 ? id.slice(0, colon) : "";
  const path = (colon >= 0 ? id.slice(colon + 1) : id).replace(/\/+$/, "");
  if (!path) return volume === "primary" ? "Internal storage" : volume || fallback;
  const last = path.split("/").filter(Boolean).pop();
  return last || fallback;
}

/** expo-file-system's picker rejects with ERR_PICKER_CANCELLED when the reader backs out. */
export function isPickerCancel(e: unknown): boolean {
  const o = e as { code?: unknown; message?: unknown } | null;
  const code = typeof o?.code === "string" ? o.code : "";
  const message = typeof o?.message === "string" ? o.message : String(e ?? "");
  return /CANCEL/i.test(code) || /cancel/i.test(message);
}

export type SaveOutcome = { ok: true; folder: string } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: string };
