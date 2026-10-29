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

function isSavedMac(v: unknown): v is SavedMac {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.deviceId === "string" &&
    o.deviceId.length > 0 &&
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
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  const writeIndex = (ids: string[]) => be.set(INDEX, JSON.stringify(ids));

  async function list(): Promise<SavedMac[]> {
    const ids = await readIndex();
    const out: SavedMac[] = [];
    const kept: string[] = [];
    for (const id of ids) {
      let mac: SavedMac | null = null;
      try {
        const raw = await be.get(slot(id));
        const parsed = raw ? JSON.parse(raw) : null;
        if (isSavedMac(parsed) && parsed.deviceId === id) mac = parsed;
      } catch {
        mac = null;
      }
      if (mac) {
        out.push(mac);
        kept.push(id);
      } else {
        await be.del(slot(id));
      }
    }
    if (kept.length !== ids.length) await writeIndex(kept);
    return out;
  }

  async function save(mac: SavedMac): Promise<void> {
    await be.set(slot(mac.deviceId), JSON.stringify(mac));
    const ids = await readIndex();
    if (!ids.includes(mac.deviceId)) await writeIndex([...ids, mac.deviceId]);
  }

  async function forget(deviceId: string): Promise<void> {
    await be.del(slot(deviceId));
    await writeIndex((await readIndex()).filter((i) => i !== deviceId));
    if ((await be.get(CURRENT)) === deviceId) await be.del(CURRENT);
  }

  async function current(): Promise<SavedMac | null> {
    const id = await be.get(CURRENT);
    if (!id) return null;
    return (await list()).find((m) => m.deviceId === id) ?? null;
  }

  async function setCurrent(deviceId: string): Promise<void> {
    await be.set(CURRENT, deviceId);
  }

  return { list, save, forget, current, setCurrent };
}

export type MacStore = ReturnType<typeof createMacStore>;
