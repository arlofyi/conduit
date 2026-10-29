import { probeLoopback, probePort, type ProbeSocket } from "./probe";

/** Fake sockets: ports in `answers` say hello right away; everything else never answers. */
function factory(answers: Record<number, string>, closed: string[]) {
  return (url: string): ProbeSocket => {
    const port = Number(url.split(":").pop());
    const s: ProbeSocket = {
      onmessage: null,
      onclose: null,
      onerror: null,
      close: () => void closed.push(url),
    };
    if (answers[port] !== undefined) {
      setTimeout(() =>
        s.onmessage?.({
          data: JSON.stringify({ type: "hello", macName: answers[port], conduitVersion: "0.50.0", protocolVersion: 1 }),
        }),
      );
    } else if (port % 2 === 0) {
      setTimeout(() => s.onclose?.()); // connection refused
    }
    return s;
  };
}

describe("probe", () => {
  it("lists_every_answering_conduit_in_port_order_and_closes_sockets", async () => {
    const closed: string[] = [];
    const found = await probeLoopback(factory({ 8456: "Installed", 8460: "Dev" }, closed), 20);
    expect(found).toEqual([
      { port: 8456, macName: "Installed", conduitVersion: "0.50.0" },
      { port: 8460, macName: "Dev", conduitVersion: "0.50.0" },
    ]);
    expect(closed).toContain("ws://127.0.0.1:8456");
    expect(closed).toContain("ws://127.0.0.1:8460");
    expect(closed).toHaveLength(20);
  });

  it("silent_port_times_out_to_null", async () => {
    expect(await probePort(8455, factory({}, []), 10)).toBeNull();
  });

  it("non_hello_garbage_is_null", async () => {
    const make = (): ProbeSocket => {
      const s: ProbeSocket = { onmessage: null, onclose: null, onerror: null, close: () => undefined };
      setTimeout(() => s.onmessage?.({ data: "not json" }));
      return s;
    };
    expect(await probePort(8455, make, 50)).toBeNull();
  });
});
