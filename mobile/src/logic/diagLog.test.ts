import {
  bump,
  cleanDetail,
  countersReport,
  emptyCounters,
  errorDetail,
  formatLine,
  LOG_MAX_BYTES,
  MAX_DETAIL,
  parseCounters,
  RECENT_ERRORS,
  recordError,
  redact,
  rotatedNames,
  rotationPlan,
  shouldRotate,
  startRun,
  utf8Bytes,
} from "./diagLog";

const TOKEN = "kq3V9xZ2mL7pR4tY8wB1nC6dF0gH5jK2sA9eU3iO7";

describe("redact", () => {
  it("drops a token from a JSON frame", () => {
    const out = redact(`{"type":"auth","token":"${TOKEN}"}`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(`"token":"<redacted>"`);
    expect(out).toContain(`"type":"auth"`);
  });

  it("drops pairing secrets, nonces and device tokens under any key spelling", () => {
    for (const k of ["secret", "pairSecret", "deviceToken", "nonce", "apiKey", "password"]) {
      const out = redact(`{"${k}": "short-value"}`);
      expect(out).not.toContain("short-value");
    }
  });

  it("drops key=value and Bearer forms", () => {
    expect(redact("GET /x?token=abc123&port=8455")).toBe("GET /x?token=<redacted>&port=8455");
    expect(redact("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redact("secret: hunter2")).toBe("secret: <redacted>");
  });

  it("keeps an address's host and port, never its credentials, path or query", () => {
    expect(redact("dial ws://me:pw@100.64.0.7:8455/ws?token=zzz failed")).toBe("dial ws://100.64.0.7:8455 failed");
    expect(redact("https://mac.tailnet.ts.net:8455/a/b")).toBe("https://mac.tailnet.ts.net:8455");
  });

  it("hides the user's own file URIs", () => {
    expect(redact("Couldn't read file:///data/user/0/x/cache/conduit-files/dl-1/secret-plan.pdf")).toBe("Couldn't read <uri>");
    expect(redact("write content://com.android.externalstorage/tree/primary%3ADocs failed")).toBe("write <uri> failed");
  });

  it("hides absolute file paths but keeps short ones and URLs", () => {
    expect(redact("ENOENT /Users/me/work/plan/notes.md")).toBe("ENOENT <path>");
    expect(redact(String.raw`denied C:\Users\me\proj\a.txt here`)).toBe("denied <path> here");
    expect(redact("at render (index.android.bundle:1:20)")).toBe("at render (index.android.bundle:1:20)");
    expect(redact("dial ws://100.64.0.7:8455/ws failed")).toBe("dial ws://100.64.0.7:8455 failed");
    expect(redact("phase a/b")).toBe("phase a/b");
  });

  it("removes long opaque runs (tokens with no key)", () => {
    expect(redact(`refused ${TOKEN} now`)).toBe("refused <redacted> now");
    // ordinary words and short ids survive
    expect(redact("the system refused to start the watcher")).toBe("the system refused to start the watcher");
  });
});

describe("cleanDetail / errorDetail", () => {
  it("folds newlines and caps length", () => {
    const d = cleanDetail("a\nb\r\n c " + "word ".repeat(400));
    expect(d.startsWith("a | b | c")).toBe(true);
    expect(d.length).toBe(MAX_DETAIL);
    expect(d.endsWith("…")).toBe(true);
  });

  it("names an Error with its code and message, redacted", () => {
    const e = Object.assign(new Error(`bad token=${TOKEN}`), { code: "ERR_BG_WATCH_START" });
    expect(errorDetail(e)).toBe("[ERR_BG_WATCH_START] bad token=<redacted>");
  });

  it("adds top stack frames only when asked", () => {
    const e = new TypeError("x is undefined");
    e.stack = "TypeError: x is undefined\n    at render (index.bundle:1:20)\n    at commit (index.bundle:1:99)\n    at more (index.bundle:2:1)";
    expect(errorDetail(e)).toBe("TypeError: x is undefined");
    expect(errorDetail(e, 2)).toBe("TypeError: x is undefined @ at render (index.bundle:1:20) < at commit (index.bundle:1:99)");
  });

  it("handles strings, plain objects and junk", () => {
    expect(errorDetail("boom")).toBe("boom");
    expect(errorDetail({ message: "obj" })).toBe("obj");
    expect(errorDetail(undefined)).toBe("undefined");
  });
});

describe("formatLine", () => {
  it("is one timestamped, levelled, sourced line", () => {
    const line = formatLine({ at: Date.UTC(2026, 10, 1, 9, 30), level: "error", source: "bridge", event: "conn.failed", detail: "closed\nagain" });
    expect(line).toBe("2026-11-01T09:30:00.000Z ERROR bridge conn.failed: closed | again\n");
  });

  it("omits an empty detail and redacts a present one", () => {
    expect(formatLine({ at: 0, level: "info", source: "app", event: "start" })).toBe("1970-01-01T00:00:00.000Z INFO  app start\n");
    expect(formatLine({ at: 0, level: "warn", source: "x", event: "y", detail: `"token":"${TOKEN}"` })).not.toContain(TOKEN);
  });
});

describe("rotation", () => {
  it("names files newest first", () => {
    expect(rotatedNames()).toEqual(["app.log", "app.1.log", "app.2.log"]);
    expect(rotatedNames("native", 2)).toEqual(["native.log", "native.1.log"]);
  });

  it("rotates only when a non-empty file would pass the cap", () => {
    expect(shouldRotate(0, LOG_MAX_BYTES * 2)).toBe(false);
    expect(shouldRotate(LOG_MAX_BYTES - 10, 10)).toBe(false);
    expect(shouldRotate(LOG_MAX_BYTES - 10, 11)).toBe(true);
  });

  it("drops the oldest and shifts the rest without overwriting", () => {
    expect(rotationPlan()).toEqual({
      remove: "app.2.log",
      moves: [
        ["app.1.log", "app.2.log"],
        ["app.log", "app.1.log"],
      ],
    });
  });

  it("simulated: total size stays bounded at keep x max", () => {
    const files = new Map<string, number>();
    const max = 1000;
    for (let i = 0; i < 500; i++) {
      const add = 37;
      const size = files.get("app.log") ?? 0;
      if (shouldRotate(size, add, max)) {
        const plan = rotationPlan("app", 3);
        files.delete(plan.remove);
        for (const [from, to] of plan.moves) {
          const v = files.get(from);
          files.delete(from);
          if (v !== undefined) files.set(to, v);
        }
      }
      files.set("app.log", (files.get("app.log") ?? 0) + add);
    }
    expect([...files.keys()].sort()).toEqual(["app.1.log", "app.2.log", "app.log"]);
    const total = [...files.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(3 * max);
  });

  it("counts UTF-8 bytes", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("—")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("counters", () => {
  it("starts a run: lifetime accumulates, the old run becomes previousRun", () => {
    let c = startRun(emptyCounters(), 100);
    expect(c.run.appStarts).toBe(1);
    expect(c.previousRun).toBeNull();
    c = bump(bump(c, "connects"), "messagesSent", 3);
    c = startRun(c, 200);
    expect(c.lifetime).toMatchObject({ appStarts: 2, connects: 1, messagesSent: 3 });
    expect(c.run).toMatchObject({ appStarts: 1, connects: 0, messagesSent: 0 });
    expect(c.previousRun).toMatchObject({ connects: 1, messagesSent: 3 });
    expect(c.runStartedAt).toBe(200);
  });

  it("records errors newest first, capped, redacted", () => {
    let c = emptyCounters(1);
    for (let i = 0; i < RECENT_ERRORS + 5; i++) {
      c = recordError(c, { at: i, level: "error", source: "js", event: `e${i}`, detail: `token=${TOKEN}` });
    }
    expect(c.run.errorsLogged).toBe(RECENT_ERRORS + 5);
    expect(c.lastErrorAt).toBe(RECENT_ERRORS + 4);
    expect(c.recentErrors).toHaveLength(RECENT_ERRORS);
    expect(c.recentErrors[0].event).toBe(`e${RECENT_ERRORS + 4}`);
    expect(JSON.stringify(c)).not.toContain(TOKEN);
  });

  it("round-trips through JSON and survives junk", () => {
    const c = bump(startRun(emptyCounters(), 5), "reconnects", 2);
    expect(parseCounters(JSON.stringify(c))).toEqual(c);
    expect(parseCounters(null, 9)).toEqual(emptyCounters(9));
    expect(parseCounters("{not json", 9)).toEqual(emptyCounters(9));
    const partial = parseCounters(JSON.stringify({ lifetime: { connects: 4, messagesSent: -1, bogus: 3 }, recentErrors: [{ nope: 1 }] }), 9);
    expect(partial.lifetime.connects).toBe(4);
    expect(partial.lifetime.messagesSent).toBe(0);
    expect(partial.recentErrors).toEqual([]);
  });

  it("reports counters as plain text", () => {
    const r = countersReport(bump(startRun(emptyCounters(), 0), "connects"), 0);
    expect(r).toContain("connects");
    expect(r).toContain("last error never");
  });
});
