import { createMacStore, type KeyValueBackend } from "./macStore";
import type { SavedMac } from "./types";

function memory(): KeyValueBackend & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    del: async (k) => void m.delete(k),
  };
}
const mk = (id: string): SavedMac => ({ deviceId: id, token: "tok-" + id, macName: "Mac " + id, dnsName: id + ".ts.net", ip: "100.64.0.1", port: 8455, pairedAt: 5 });

describe("macStore", () => {
  it("store_round_trip", async () => {
    const s = createMacStore(memory());
    await s.save(mk("a"));
    await s.save(mk("b"));
    await s.save({ ...mk("a"), macName: "Renamed" });
    const list = await s.list();
    expect(list.map((x) => x.deviceId)).toEqual(["a", "b"]);
    expect(list[0].macName).toBe("Renamed");
    expect(await s.current()).toBeNull();
    await s.setCurrent("b");
    expect((await s.current())?.deviceId).toBe("b");
  });
  it("forget_removes_from_index", async () => {
    const be = memory();
    const s = createMacStore(be);
    await s.save(mk("a"));
    await s.save(mk("b"));
    await s.setCurrent("a");
    await s.forget("a");
    expect((await s.list()).map((x) => x.deviceId)).toEqual(["b"]);
    expect(be.m.has("mac.a")).toBe(false);
    expect(await s.current()).toBeNull();
    expect(be.m.has("macs.current")).toBe(false);
  });
  it("corrupt_slot_is_dropped", async () => {
    const be = memory();
    const s = createMacStore(be);
    await s.save(mk("a"));
    await s.save(mk("b"));
    be.m.set("mac.a", "{not json");
    be.m.set("mac.b", JSON.stringify({ deviceId: "b" })); // missing fields
    expect(await s.list()).toEqual([]);
    expect(be.m.has("mac.a")).toBe(false);
    expect(be.m.has("mac.b")).toBe(false);
    expect(JSON.parse(be.m.get("macs.index")!)).toEqual([]);
  });
  it("corrupt_index_is_empty", async () => {
    const be = memory();
    be.m.set("macs.index", "garbage");
    expect(await createMacStore(be).list()).toEqual([]);
  });
});
