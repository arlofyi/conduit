import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { e2eDataDir } from "../wdio.conf";

/**
 * Settings -> Privacy shows the statistics request itself, and turning sharing off
 * deletes the anonymous id.
 *
 * `telemetry.rs` tests that the preview is built by the same function as the real request
 * and that the stated reason matches the gate. Only this checks that the page shows it,
 * and that the switch reaches the file on disk.
 *
 * The app under test is a debug build, so it never sends; the page must say exactly that.
 */

const text = (selector: string): Promise<string[]> =>
  browser.execute(
    (sel: string) => Array.from(document.querySelectorAll(sel)).map((e) => (e.textContent ?? "").trim()),
    selector,
  ) as Promise<string[]>;

const click = (selector: string, exact?: string): Promise<boolean> =>
  browser.execute(
    (sel: string, want: string | null) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find(
        (e) => want === null || (e.textContent ?? "").trim() === want,
      );
      el?.click();
      return !!el;
    },
    selector,
    exact ?? null,
  ) as Promise<boolean>;

const idFile = () => join(e2eDataDir(), "telemetry_client_id");

describe("Settings -> Privacy", () => {
  before(async () => {
    // An id as a release build would have left it.
    mkdirSync(e2eDataDir(), { recursive: true });
    writeFileSync(idFile(), "11111111-2222-4333-8444-555555555555");
    expect(await click(".settings-btn")).toBe(true);
    await browser.waitUntil(async () => (await text(".settings-nav-item")).includes("Privacy"), {
      timeout: 10_000,
      timeoutMsg: "Settings did not open",
    });
    expect(await click(".settings-nav-item", "Privacy")).toBe(true);
    await browser.waitUntil(async () => (await text(".telemetry-state")).length === 1, {
      timeout: 10_000,
      timeoutMsg: "the statistics preview never rendered",
    });
  });

  after(async () => {
    await browser.keys("Escape");
  });

  it("says this build is not sending, and why", async () => {
    const [state] = await text(".telemetry-state");
    expect(state).toContain("Not sending");
    expect(state).toContain("development build");
  });

  it("shows the whole request: four keys, five properties, the id on disk", async () => {
    const [raw] = await text(".telemetry-payload");
    const payload = JSON.parse(raw);
    expect(Object.keys(payload).sort()).toEqual(["api_key", "distinct_id", "event", "properties"]);
    expect(Object.keys(payload.properties).sort()).toEqual([
      "$process_person_profile",
      "app_version",
      "engagement_time_msec",
      "os",
      "session_id",
    ]);
    expect(payload.distinct_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(payload.properties.app_version).toMatch(/^\d+\.\d+\.\d+/);
    expect((await text(".telemetry-facts code"))[0]).toMatch(/^https:\/\//);
  });

  it("turning sharing off says so and deletes the id from disk", async () => {
    expect(existsSync(idFile())).toBe(true);
    expect(await click("#setting-switch-telemetry")).toBe(true);
    await browser.waitUntil(async () => ((await text(".telemetry-state"))[0] ?? "").includes("You turned sharing off"), {
      timeout: 10_000,
      timeoutMsg: "the page did not reflect sharing being turned off",
    });
    await browser.waitUntil(async () => !existsSync(idFile()), {
      timeout: 10_000,
      timeoutMsg: "the anonymous id is still on disk after opting out",
    });
    // With no id, the preview does not invent one by being looked at.
    const payload = JSON.parse((await text(".telemetry-payload"))[0]);
    expect(payload.distinct_id).toContain("created the first time");
    expect(existsSync(idFile())).toBe(false);
  });

  it("turning it back on returns to the build's own reason", async () => {
    expect(await click("#setting-switch-telemetry")).toBe(true);
    await browser.waitUntil(async () => ((await text(".telemetry-state"))[0] ?? "").includes("development build"), {
      timeout: 10_000,
    });
  });
});
