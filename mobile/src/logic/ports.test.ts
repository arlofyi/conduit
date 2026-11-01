import { localPortFor, mirrorMappings, mirrorPlan, parsePortsFrame, portRows, processLabel, sameMappings } from "./ports";

describe("localPortFor", () => {
  it("keeps an unprivileged port", () => {
    expect(localPortFor(5173)).toBe(5173);
    expect(localPortFor(1024)).toBe(1024);
  });
  it("moves a privileged port above 10000", () => {
    expect(localPortFor(80)).toBe(10080);
    expect(localPortFor(443)).toBe(10443);
  });
});

describe("parsePortsFrame", () => {
  it("reads the wire shape, sorted, deduped", () => {
    expect(
      parsePortsFrame({
        type: "ports",
        enabled: true,
        ports: [
          { port: 8000, process: "python.exe" },
          { port: 3000, process: null },
          { port: 3000, process: "node" },
        ],
      }),
    ).toEqual({
      enabled: true,
      ports: [
        { port: 3000, process: null },
        { port: 8000, process: "python.exe" },
      ],
    });
  });
  it("drops malformed entries instead of throwing", () => {
    expect(
      parsePortsFrame({ type: "ports", enabled: true, ports: [null, { port: "80" }, { port: 0 }, { port: 70000 }, { port: 1.5 }] }),
    ).toEqual({ enabled: true, ports: [] });
  });
  it("reads anything but true as disabled", () => {
    expect(parsePortsFrame({ type: "ports", ports: [] })?.enabled).toBe(false);
  });
  it("ignores other frames", () => {
    expect(parsePortsFrame({ type: "macs" })).toBeNull();
    expect(parsePortsFrame(null)).toBeNull();
  });
});

describe("mirrorMappings", () => {
  it("maps every port, keeping the first of a collision", () => {
    expect(mirrorMappings([{ port: 80, process: null }, { port: 10080, process: null }, { port: 3000, process: null }])).toEqual([
      { remote: 80, local: 10080 },
      { remote: 3000, local: 3000 },
    ]);
  });
});

describe("sameMappings", () => {
  it("ignores order", () => {
    expect(sameMappings([{ remote: 1, local: 1 }, { remote: 2, local: 2 }], [{ remote: 2, local: 2 }, { remote: 1, local: 1 }])).toBe(true);
  });
  it("sees a change", () => {
    expect(sameMappings([{ remote: 1, local: 1 }], [{ remote: 1, local: 2 }])).toBe(false);
    expect(sameMappings([], [{ remote: 1, local: 1 }])).toBe(false);
  });
});

describe("processLabel", () => {
  it("names relays for what they are and drops .exe", () => {
    expect(processLabel("com.docker.backend.exe")).toBe("Docker");
    expect(processLabel("wslrelay.exe")).toBe("WSL");
    expect(processLabel("node.exe")).toBe("node");
    expect(processLabel(null)).toBeNull();
  });
});

describe("portRows", () => {
  const view = { enabled: true, ports: [{ port: 80, process: "nginx.exe" }, { port: 5173, process: "node.exe" }] };

  it("is empty when the computer has it off", () => {
    expect(portRows({ ...view, enabled: false }, true, [])).toEqual([]);
    expect(portRows(null, true, [])).toEqual([]);
  });

  it("shows ports as off with no URL while not mirroring", () => {
    const rows = portRows(view, false, []);
    expect(rows.map((r) => [r.port, r.state, r.url])).toEqual([
      [80, "off", null],
      [5173, "off", null],
    ]);
    expect(rows[0].title).toBe("localhost:10080");
    expect(rows[0].subtitle).toBe("nginx · :80 on your computer");
    expect(rows[1].subtitle).toBe("node");
  });

  it("follows the mirror's per-port state", () => {
    const rows = portRows(view, true, [
      { remote: 80, local: 10080, listening: false, error: "in use" },
      { remote: 5173, local: 5173, listening: true, error: null },
    ]);
    expect(rows.map((r) => [r.state, r.url])).toEqual([
      ["inUse", null],
      ["ready", "http://localhost:5173"],
    ]);
  });

  it("is starting until the listener reports", () => {
    expect(portRows(view, true, [])[1].state).toBe("starting");
  });
});

describe("mirrorPlan", () => {
  const view = { enabled: true, ports: [{ port: 5173, process: "node" }] };
  const base = { want: true, view, address: "ws://100.1.2.3:8456", token: "t", running: false, applied: null };
  const applied = { url: "ws://100.1.2.3:8456", token: "t", ports: [{ remote: 5173, local: 5173 }] };

  it("starts when wanted and there is something to mirror", () => {
    expect(mirrorPlan(base)).toEqual({ kind: "start", applied });
  });
  it("does nothing once running with the same set", () => {
    expect(mirrorPlan({ ...base, running: true, applied })).toEqual({ kind: "none" });
  });
  it("re-applies when the set changes", () => {
    const more = { enabled: true, ports: [...view.ports, { port: 8000, process: null }] };
    expect(mirrorPlan({ ...base, view: more, running: true, applied }).kind).toBe("start");
  });
  it("restarts a mirror that died under it", () => {
    expect(mirrorPlan({ ...base, running: false, applied }).kind).toBe("start");
  });
  it("keeps running through a redial (no address)", () => {
    expect(mirrorPlan({ ...base, address: null, running: true, applied })).toEqual({ kind: "none" });
  });
  it("waits for the first answer", () => {
    expect(mirrorPlan({ ...base, view: null })).toEqual({ kind: "none" });
  });
  it("stops on the switch, the computer, or nothing to mirror", () => {
    expect(mirrorPlan({ ...base, want: false, running: true, applied }).kind).toBe("stop");
    expect(mirrorPlan({ ...base, view: { enabled: false, ports: [] }, running: true, applied }).kind).toBe("stop");
    expect(mirrorPlan({ ...base, view: { enabled: true, ports: [] }, running: true, applied }).kind).toBe("stop");
    expect(mirrorPlan({ ...base, want: false })).toEqual({ kind: "none" });
  });
});
