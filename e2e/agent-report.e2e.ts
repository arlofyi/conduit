import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { E2E_DATA_DIR } from "../wdio.conf";

/**
 * `conduit report`, as the user sees it: a program inside a session reports its own
 * status through the real shim, and the sidebar follows -- with no hook installed for it.
 *
 * `report.rs` tests the translation and `tests/cli_report.rs` the shim. Only this checks
 * the whole path: shim -> the app's hook server -> the row in the window, including a
 * late report being dropped.
 */

type ShimStatus = { installed: boolean; path: string | null };
type Session = { id: string; name: string };
type Project = { id: string; name: string; sessions: Session[] };

const env = { ...process.env, CONDUIT_DATA_DIR_NAME: E2E_DATA_DIR };
delete (env as Record<string, string | undefined>).CONDUIT_SESSION_ID;
delete (env as Record<string, string | undefined>).CONDUIT_HOOK_PORT;

const row = (name: string): Promise<{ found: boolean; running: boolean; done: boolean; needs: boolean }> =>
  browser.execute((want: string) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(".session-row")).find((r) =>
      (r.textContent ?? "").includes(want),
    );
    return {
      found: !!el,
      running: !!el?.querySelector(".dot.running, .pill-activity"),
      done: !!el?.querySelector(".dot.done"),
      needs: !!el?.querySelector(".pill-needs"),
    };
  }, name) as Promise<{ found: boolean; running: boolean; done: boolean; needs: boolean }>;

describe("a program reporting its own status", () => {
  let shim: string;
  let reporter: Session;

  /** Run `conduit report` the way a process inside that session would. */
  const report = (...args: string[]) => {
    const out = spawnSync(shim, ["report", ...args], {
      env: { ...env, CONDUIT_SESSION_ID: reporter.id },
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
  };

  before(async () => {
    const status = (await browser.execute(() =>
      (window as any).__TAURI__.core.invoke("install_cli_shim"),
    )) as ShimStatus;
    if (!status?.path) throw new Error("install_cli_shim did not report a path");
    shim = status.path;
    const project = join(mkdtempSync(join(tmpdir(), "conduit-e2e-report-")), "report-project");
    mkdirSync(project, { recursive: true });
    // Two sessions: the second is the one in front, so the first can show a needs-you
    // badge (the app does not badge the session the user is already looking at).
    // The project first, with no agent: opening is safe to wait on and proves the freshly
    // booted app is taking CLI requests before a session is asked for.
    execFileSync(shim, [project], { env });
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          Array.from(document.querySelectorAll(".project-block .name")).some(
            (e) => (e.textContent ?? "").trim() === "report-project",
          ),
        )) as boolean,
      { timeout: 30_000, timeoutMsg: "the project never appeared" },
    );
    for (const name of ["reporter", "in-front"]) {
      execFileSync(shim, [project, "--agent", "claude", "--name", name], { env });
      await browser.waitUntil(async () => (await row(name)).found, {
        timeout: 30_000,
        timeoutMsg: `session ${name} never appeared`,
      });
    }
    const projects = (await browser.execute(() =>
      (window as any).__TAURI__.core.invoke("load_projects"),
    )) as Project[];
    reporter = projects
      .find((p) => p.name === "report-project")!
      .sessions.find((s) => s.name === "reporter")!;
  });

  it("shows working, then finished", async () => {
    report("--state", "working", "--seq", "1");
    await browser.waitUntil(async () => (await row("reporter")).running, {
      timeout: 10_000,
      timeoutMsg: "a reported `working` did not show as running",
    });
    report("--state", "idle", "--seq", "2");
    await browser.waitUntil(async () => (await row("reporter")).done, {
      timeout: 10_000,
      timeoutMsg: "a reported `idle` did not show as finished",
    });
  });

  it("drops a report that arrives late", async () => {
    // The `working` from before the `idle`, delivered after it.
    report("--state", "working", "--seq", "1");
    await browser.pause(1_500);
    const now = await row("reporter");
    expect(now.running).toBe(false);
    expect(now.done).toBe(true);
  });

  it("shows that it needs the user", async () => {
    report("--state", "working", "--seq", "3");
    await browser.waitUntil(async () => (await row("reporter")).running, { timeout: 10_000 });
    report("--state", "blocked", "--kind", "permission", "--message", "Allow the deploy?", "--seq", "4");
    await browser.waitUntil(async () => (await row("reporter")).needs, {
      timeout: 10_000,
      timeoutMsg: "a reported `blocked` did not show the needs-you pill",
    });
  });

  it("ignores a state it does not know", async () => {
    const out = spawnSync(shim, ["report", "--state", "pondering"], {
      env: { ...env, CONDUIT_SESSION_ID: reporter.id },
      encoding: "utf8",
    });
    expect(out.status).toBe(2);
    expect((await row("reporter")).needs).toBe(true);
  });
});
