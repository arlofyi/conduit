/** Keychain-backed list of paired Macs: one slot per Mac (`mac.<deviceId>`, small JSON) plus
 * an index (`macs.index`) and the current selection (`macs.current`). The backend is
 * injected so this runs under jest; the real one is in secureBackend.ts. */

import type { SavedMac } from "./types";

export interface KeyValueBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

const INDEX = "macs.index";
const CURRENT = "macs.current";
const slot = (id: string) => `mac.${id}`;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const validId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

function isSavedMac(v: unknown): v is SavedMac {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    validId(o.deviceId) &&
    typeof o.token === "string" &&
    typeof o.macName === "string" &&
    typeof o.dnsName === "string" &&
    typeof o.ip === "string" &&
    typeof o.port === "number" &&
    typeof o.pairedAt === "number"
  );
}

export function createMacStore(be: KeyValueBackend) {
  async function readIndex(): Promise<string[]> {
    const raw = await be.get(INDEX);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter(validId) : [];
    } catch {
      return [];
    }
  }
  const writeIndex = (ids: string[]) => be.set(INDEX, JSON.stringify(ids));

  // Serializes index read-modify-writes so concurrent saves/forgets cannot lose updates.
  let chain: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  async function listInner(): Promise<SavedMac[]> {
    const ids = await readIndex();
    const out: SavedMac[] = [];
    const kept: string[] = [];
    let dropped = false;
    for (const id of ids) {
      let raw: string | null;
      try {
        raw = await be.get(slot(id));
      } catch {
        // Transient read failure: skip for this call, touch nothing.
        kept.push(id);
        continue;
      }
      let mac: SavedMac | null = null;
      try {
        const parsed = raw ? JSON.parse(raw) : null;
        if (isSavedMac(parsed) && parsed.deviceId === id) mac = parsed;
      } catch {
        mac = null;
      }
      if (mac) {
        out.push(mac);
        kept.push(id);
      } else {
        dropped = true;
        try {
          await be.del(slot(id));
        } catch {
          // best-effort cleanup
        }
      }
    }
    if (dropped) {
      try {
        await writeIndex(kept);
      } catch {
        // best-effort cleanup
      }
    }
    return out;
  }

  const list = () => locked(listInner);

  const save = (mac: SavedMac): Promise<void> =>
    locked(async () => {
      if (!validId(mac.deviceId)) throw new Error("invalid deviceId");
      await be.set(slot(mac.deviceId), JSON.stringify(mac));
      const ids = await readIndex();
      if (!ids.includes(mac.deviceId)) await writeIndex([...ids, mac.deviceId]);
    });

  const forget = (deviceId: string): Promise<void> =>
    locked(async () => {
      if (!validId(deviceId)) return;
      await be.del(slot(deviceId));
      await writeIndex((await readIndex()).filter((i) => i !== deviceId));
      if ((await be.get(CURRENT)) === deviceId) await be.del(CURRENT);
    });

  async function current(): Promise<SavedMac | null> {
    const id = await be.get(CURRENT);
    if (!id) return null;
    return (await list()).find((m) => m.deviceId === id) ?? null;
  }

  const setCurrent = (deviceId: string): Promise<void> =>
    locked(() => be.set(CURRENT, deviceId));

  return { list, save, forget, current, setCurrent };
}

export type MacStore = ReturnType<typeof createMacStore>;
