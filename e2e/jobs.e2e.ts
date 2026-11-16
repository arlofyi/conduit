import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { E2E_DATA_DIR } from "../wdio.conf";

/**
 * `conduit run`, as the user sees it: an agent hands Conduit a command through the real
 * shim, and the Jobs tab appears, shows its output, and can stop it.
 *
 * `src-tauri/tests/cli_jobs.rs` covers the shim-to-engine chain. What only this can check
 * is the window: the tab existing only while there are jobs, the live output, the Stop
 * button, and the list following a job to its end.
 *
 * No agent is spawned: the shim is run directly, exactly as an agent's shell tool would.
 */

type ShimStatus = { installed: boolean; path: string | null };

const env = { ...process.env, CONDUIT_DATA_DIR_NAME: E2E_DATA_DIR };
delete (env as Record<string, string | undefined>).CONDUIT_SESSION_ID;

const text = (selector: string): Promise<string[]> =>
  browser.execute(
    (sel: string) => Array.from(document.querySelectorAll(sel)).map((e) => (e.textContent ?? "").trim()),
    selector,
  ) as Promise<string[]>;

const clickFirst = (selector: string, startsWith?: string): Promise<boolean> =>
  browser.execute(
    (sel: string, want: string | null) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find(
        (e) => want === null || (e.textContent ?? "").trim().startsWith(want),
      );
      el?.click();
      return !!el;
    },
    selector,
    startsWith ?? null,
  ) as Promise<boolean>;

const jobsTab = async () => (await text(".bottom-panel .panel-tab")).find((t) => t.startsWith("Jobs"));

describe("jobs started with conduit run", () => {
  let shim: string;
  let project: string;

  before(async () => {
    const status = (await browser.execute(() =>
      (window as any).__TAURI__.core.invoke("install_cli_shim"),
    )) as ShimStatus;
    if (!status?.path) throw new Error("install_cli_shim did not report a path");
    shim = status.path;
    // realpath: the shim reports `pwd -P`, and macOS's tmpdir is a symlink.
    project = join(realpathSync(mkdtempSync(join(tmpdir(), "conduit-e2e-jobs-"))), "jobs-project");
    mkdirSync(project, { recursive: true });
    execFileSync(shim, [project], { env });
    await browser.waitUntil(
      async () => (await text(".project-block .name")).includes("jobs-project"),
      { timeout: 20_000, timeoutMsg: "the project never appeared in the sidebar" },
    );
  });

  it("has no Jobs tab until there is a job", async () => {
    expect(await jobsTab()).toBeUndefined();
  });

  it("shows a running job with its output", async () => {
    const id = execFileSync(shim, ["run", "--bg", "--name", "e2e-job", "echo hello-from-job; sleep 60"], {
      env,
      cwd: project,
      encoding: "utf8",
    }).trim();
    expect(id).toMatch(/^j\d+$/);

    await browser.waitUntil(async () => (await jobsTab()) === "Jobs 1", {
      timeout: 10_000,
      timeoutMsg: "the Jobs tab did not appear with one running job",
    });
    expect(await clickFirst(".bottom-panel .panel-tab", "Jobs")).toBe(true);

    await browser.waitUntil(async () => (await text(".job-row .job-name")).includes("e2e-job"), {
      timeout: 5_000,
      timeoutMsg: "the job is not listed",
    });
    expect((await text(".job-row .job-meta"))[0]).toContain("running");
    await browser.waitUntil(async () => ((await text(".job-output"))[0] ?? "").includes("hello-from-job"), {
      timeout: 5_000,
      timeoutMsg: "the job's output never showed",
    });
  });

  it("stops the job from the panel", async () => {
    expect(await clickFirst(".job-stop")).toBe(true);
    await browser.waitUntil(async () => ((await text(".job-row .job-meta"))[0] ?? "").includes("stopped"), {
      timeout: 15_000,
      timeoutMsg: "the job did not read as stopped after Stop",
    });
    // Nothing running: the label drops its count, and the Stop button is gone.
    expect(await jobsTab()).toBe("Jobs");
    expect(await text(".job-stop")).toEqual([]);
  });

  it("reports a failed command's exit code in the shell and in the list", async () => {
    const run = spawnSync(shim, ["run", "--name", "fails", "echo about-to-fail; exit 3"], {
      env,
      cwd: project,
      encoding: "utf8",
    });
    expect(run.status).toBe(3);
    expect(run.stdout).toBe("about-to-fail\n");
    await browser.waitUntil(
      async () => (await text(".job-row")).some((row) => row.includes("fails") && row.includes("exit 3")),
      { timeout: 10_000, timeoutMsg: "the failed job is not shown with its exit code" },
    );
  });
});
