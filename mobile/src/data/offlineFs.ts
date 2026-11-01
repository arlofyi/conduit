/**
 * The real file system behind logic/offlineStore.ts: JSON files under `conduit-offline/`. Native
 * module: never imported by anything under jest.
 *
 * WHERE differs per platform, because saved chats must not leave the phone through a backup:
 * - iOS: the CACHE folder. The document folder is backed up to iCloud, and expo-file-system has
 *   no way to set "exclude from backup" on a file. The trade-off: iOS may purge the cache when
 *   storage runs low, which costs the offline copy (the computer still has everything).
 * - Android: the DOCUMENT folder (`filesDir`), which the OS does not purge. It is NOT in Auto
 *   Backup only because expo-secure-store's config plugin installs backup rules that include
 *   nothing but its own shared preferences (`@xml/secure_store_backup_rules`). If that plugin is
 *   ever removed, or another set of backup rules replaces its, this folder would be backed up:
 *   exclude it there, or move it to the cache folder here.
 */
import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { OfflineStore, type CacheFs } from "../logic/offlineStore";

const ROOT = "conduit-offline";
const IOS = Platform.OS === "ios";

const root = () => new Directory(IOS ? Paths.cache : Paths.document, ROOT);

/** Builds before this one kept the iOS copy in the (backed-up) document folder: delete it once.
 * Not moved -- it is only a cache, and the next connection saves a fresh copy. */
let migrated = false;
function migrateOnce(): void {
  if (migrated || !IOS) return;
  migrated = true;
  try {
    const old = new Directory(Paths.document, ROOT);
    if (old.exists) old.delete();
  } catch {
    // try again next launch
  }
}
migrateOnce();

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
