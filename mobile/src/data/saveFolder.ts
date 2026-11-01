/**
 * "Save to folder" on Android: write a downloaded file into a folder the reader picked through
 * the Storage Access Framework (expo-file-system's `Directory.pickDirectoryAsync`, which takes
 * a persistable grant). The last folder is remembered, so the next save goes straight there; a
 * folder whose grant is gone (revoked, deleted, another phone restore) asks again.
 *
 * Android only: iOS has no SAF, and its share sheet's "Save to Files" is the native answer.
 * Native modules: never imported by anything under jest.
 */
import { Directory, File } from "expo-file-system";
import { folderLabel, isPickerCancel, SAVE_FOLDER_KEY, type SaveOutcome } from "../logic/saveFolder";
import { secureBackend } from "./secureBackend";

export async function rememberedFolder(): Promise<string | null> {
  try {
    return await secureBackend.get(SAVE_FOLDER_KEY);
  } catch {
    return null;
  }
}

function nameOf(dir: Directory, uri: string): string {
  try {
    const n = dir.name;
    if (n && !n.includes("%") && !n.includes(":")) return n;
  } catch {
    // fall through to the URI
  }
  return folderLabel(uri);
}

/** Write `bytes` as a new file in `dirUri`; null when the folder can't be written (the grant
 * is gone). SAF names a clash "name (1)" itself, so nothing is ever overwritten. */
function writeInto(dirUri: string, name: string, mime: string, bytes: Uint8Array): string | null {
  try {
    const dir = new Directory(dirUri);
    const file = dir.createFile(name, mime);
    file.write(bytes);
    return nameOf(dir, dirUri);
  } catch {
    return null;
  }
}

/**
 * Save the cached download at `srcUri` as `name`. `chooseNew` skips the remembered folder and
 * opens the picker ("Choose another folder").
 */
export async function saveToFolder(srcUri: string, name: string, mime: string, chooseNew = false): Promise<SaveOutcome> {
  let bytes: Uint8Array;
  try {
    bytes = await new File(srcUri).bytes();
  } catch (e) {
    return { ok: false, cancelled: false, error: `Couldn't read the download: ${e instanceof Error ? e.message : String(e)}` };
  }
  const last = await rememberedFolder();
  if (last && !chooseNew) {
    const folder = writeInto(last, name, mime, bytes);
    if (folder) return { ok: true, folder };
  }
  let picked: Directory;
  try {
    picked = await Directory.pickDirectoryAsync(last ?? undefined);
  } catch (e) {
    if (isPickerCancel(e)) return { ok: false, cancelled: true };
    return { ok: false, cancelled: false, error: e instanceof Error ? e.message : String(e) };
  }
  const folder = writeInto(picked.uri, name, mime, bytes);
  if (!folder) return { ok: false, cancelled: false, error: "This phone wouldn't let Conduit write to that folder. Pick another one." };
  try {
    await secureBackend.set(SAVE_FOLDER_KEY, picked.uri);
  } catch {
    // saved anyway; the next save just asks again
  }
  return { ok: true, folder };
}
