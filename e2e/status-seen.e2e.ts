import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { E2E_DATA_DIR, e2eDataDir } from "../wdio.conf";

/**
 * The sidebar's status accessories, in the real window: a finished session keeps its dot
 * until it has been in front of the user, and a session that needs the user says what for.
 *
 * `statusRules.test.ts` covers the rules. What only this can check is the wiring: the
 * hook stream reaching the row, the dot surviving while the session is unselected or the
 * window is unfocused, and clearing once both are true.
 *
 * Status is driven by posting the hook events a real agent would, to the app's own hook
 * server. The sessions do start a real `claude` (as `cli-launcher.e2e.ts` does), in a
 * fresh non-git temp directory so it never records into the developer's continuity DB.
 */

type ShimStatus = { installed: boolean; path: string | null };
type Session = { id: string; name: string };
type Project = { id: string; name: string; sessions: Session[] };

const env = { ...process.env, CONDUIT_DATA_DIR_NAME: E2E_DATA_DIR };

const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  browser.execute(
    (c: string, a: Record<string, unknown> | undefined) => (window as any).__TAURI__.core.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>;

async function hook(sessionId: string, event: string, body: Record<string, unknown> = {}) {
  const endpoint = readFileSync(join(e2eDataDir(), "hook-endpoint.sh"), "utf8");
  const port = /CONDUIT_HOOK_PORT=(\d+)/.exec(endpoint)?.[1];
  if (!port) throw new Error(`no hook port in ${endpoint}`);
  await fetch(`http://127.0.0.1:${port}/hook?session=${sessionId}&event=${event}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** What one sidebar row shows: its done dot and its needs-you pill. */
const row = (name: string): Promise<{ found: boolean; done: boolean; pill: string | null; selected: boolean }> =>
  browser.execute((want: string) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(".session-row")).find((r) =>
      (r.textContent ?? "").includes(want),
    );
    return {
      found: !!el,
      done: !!el?.querySelector(".dot.done"),
      pill: el?.querySelector(".pill-needs")?.textContent?.trim() ?? null,
      selected: !!el?.classList.contains("selected"),
    };
  }, name) as Promise<{ found: boolean; done: boolean; pill: string | null; selected: boolean }>;

const clickRow = (name: string) =>
  browser.execute((want: string) => {
    Array.from(document.querySelectorAll<HTMLElement>(".session-row"))
      .find((r) => (r.textContent ?? "").includes(want))
      ?.click();
  }, name);

/** The window's focus as the app tracks it, set the way the OS would. */
const setFocused = (focused: boolean) =>
  browser.execute((f: boolean) => {
    window.dispatchEvent(new Event(f ? "focus" : "blur"));
  }, focused);

/** Longer than the done-holdoff (3 s) the seen rule waits out. */
const PAST_HOLDOFF_MS = 4_500;

describe("session status in the sidebar", () => {
  let a: Session;
  let b: Session;

  before(async () => {
    const status = (await browser.execute(() =>
      (window as any).__TAURI__.core.invoke("install_cli_shim"),
    )) as ShimStatus;
    if (!status?.path) throw new Error("install_cli_shim did not report a path");
    const project = join(mkdtempSync(join(tmpdir(), "conduit-e2e-seen-")), "seen-project");
    mkdirSync(project, { recursive: true });
    for (const name of ["seen-alpha", "seen-beta"]) {
      execFileSync(status.path, [project, "--agent", "claude", "--name", name], { env });
      await browser.waitUntil(async () => (await row(name)).found, {
        timeout: 30_000,
        timeoutMsg: `session ${name} never appeared`,
      });
    }
    const projects = await invoke<Project[]>("load_projects");
    const sessions = projects.find((p) => p.name === "seen-project")?.sessions ?? [];
    a = sessions.find((s) => s.name === "seen-alpha")!;
    b = sessions.find((s) => s.name === "seen-beta")!;
    if (!a || !b) throw new Error("the two sessions were not created");
    // beta was created last and is the one in front.
    await browser.waitUntil(async () => (await row("seen-beta")).selected, { timeout: 10_000 });
    await setFocused(true);
  });

  it("keeps the finished dot on a session that is not in front", async () => {
    await hook(a.id, "prompt");
    await hook(a.id, "stop");
    await browser.waitUntil(async () => (await row("seen-alpha")).done, {
      timeout: 10_000,
      timeoutMsg: "the finished session never showed its dot",
    });
    await browser.pause(PAST_HOLDOFF_MS);
    expect((await row("seen-alpha")).done).toBe(true);
  });

  it("clears it once the session has been in front of the user", async () => {
    await clickRow("seen-alpha");
    await browser.waitUntil(async () => (await row("seen-alpha")).selected, { timeout: 10_000 });
    await browser.waitUntil(async () => !(await row("seen-alpha")).done, {
      timeout: 10_000,
      timeoutMsg: "the dot never cleared after the session was looked at",
    });
  });

  it("keeps it on the selected session while the window is not focused", async () => {
    // The blur comes with nothing clicked after it: a click in a real window brings a real
    // focus event with it, which would undo this.
    await setFocused(false);
    await hook(a.id, "prompt");
    await hook(a.id, "stop");
    await browser.waitUntil(async () => (await row("seen-alpha")).done, { timeout: 10_000 });
    await browser.pause(PAST_HOLDOFF_MS);
    expect((await row("seen-alpha")).done).toBe(true);
    // The user comes back to the window: now it has been seen.
    await setFocused(true);
    await browser.waitUntil(async () => !(await row("seen-alpha")).done, {
      timeout: 10_000,
      timeoutMsg: "the dot never cleared after the window regained focus",
    });
  });

  it("says what a session needs you for", async () => {
    // alpha is in front; beta is the one asking.
    await hook(b.id, "prompt");
    await hook(b.id, "notification", { notification_type: "permission_prompt", message: "allow?" });
    await browser.waitUntil(async () => (await row("seen-beta")).pill === "approve?", {
      timeout: 10_000,
      timeoutMsg: "a permission prompt did not read as approve?",
    });

    await hook(b.id, "prompt");
    await hook(b.id, "notification", { notification_type: "elicitation_dialog", message: "which one?" });
    await browser.waitUntil(async () => (await row("seen-beta")).pill === "question", {
      timeout: 10_000,
      timeoutMsg: "a question did not read as question",
    });

    await hook(b.id, "prompt");
    await hook(b.id, "notification", { message: "needs your input" });
    await browser.waitUntil(async () => (await row("seen-beta")).pill === "needs you", {
      timeout: 10_000,
      timeoutMsg: "an untyped notification did not keep the plain pill",
    });
  });

  it("drops the pill when the turn moves on", async () => {
    await hook(b.id, "prompt");
    await browser.waitUntil(async () => (await row("seen-beta")).pill === null, { timeout: 10_000 });
  });
});
