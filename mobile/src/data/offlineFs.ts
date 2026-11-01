/**
 * The real file system behind logic/offlineStore.ts: JSON files under the app's DOCUMENT folder
 * (`conduit-offline/`), which the OS does not purge the way it purges the cache folder. Native
 * module: never imported by anything under jest.
 */
import { Directory, File, Paths } from "expo-file-system";
import { OfflineStore, type CacheFs } from "../logic/offlineStore";

const ROOT = "conduit-offline";

const root = () => new Directory(Paths.document, ROOT);

/** `dir/file.json` -> a File under the root (paths are built by offlineCache, never by a peer). */
function fileAt(path: string): File {
  const parts = path.split("/").filter(Boolean);
  return new File(root(), ...parts);
}

export const expoCacheFs: CacheFs = {
  async read(path) {
    try {
      const f = fileAt(path);
      if (!f.exists) return null;
      return await f.text();
    } catch {
      return null;
    }
  },
  write(path, text) {
    const parts = path.split("/").filter(Boolean);
    const dir = new Directory(root(), ...parts.slice(0, -1));
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const f = new File(dir, parts[parts.length - 1]);
    if (!f.exists) f.create({ overwrite: true });
    f.write(text);
  },
  remove(path) {
    const f = fileAt(path);
    if (f.exists) f.delete();
  },
  removeDir(path) {
    const d = new Directory(root(), ...path.split("/").filter(Boolean));
    if (d.exists) d.delete();
  },
  listDirs() {
    const r = root();
    if (!r.exists) return [];
    return r.list().filter((e): e is Directory => e instanceof Directory).map((d) => d.name);
  },
  size(path) {
    const d = path ? new Directory(root(), ...path.split("/").filter(Boolean)) : root();
    if (!d.exists) return 0;
    return d.size ?? 0;
  },
};

/** The one store for the app. */
export const offlineStore = new OfflineStore(expoCacheFs);
