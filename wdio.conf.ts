import { mkdirSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createContinuityDb } from "./e2e/continuityFixture";

/**
 * GUI end-to-end. Drives the REAL built app through WebdriverIO's embedded provider —
 * the only one that works on macOS, because there is no WKWebView driver and the
 * WebDriver server therefore runs inside the app itself.
 *
 * That is also why the app under test must be built with `--features wdio` and the
 * `tauri.wdio.conf.json` override: neither the plugin nor the global Tauri bridge may
 * exist in a shipped binary. See `src-tauri/build.rs` and `cli_shim.rs`'s guard tests.
 */

/**
 * Isolate the app under test from the developer's real Conduit. The service spawns the
 * app as a child of this process, so it inherits this; `e2e/cli-launcher.e2e.ts` passes
 * the same value to the shim, which is what makes the two agree on a data directory.
 * Set here rather than in a script so a bare `wdio run` cannot skip it.
 */
export const E2E_DATA_DIR = "ConduitTauri-e2e";
process.env.CONDUIT_DATA_DIR_NAME = E2E_DATA_DIR;

/**
 * A hermetic continuity database for every spec. The app reads `CONTINUITY_DB_PATH`
 * (`continuity_read::db_path`) instead of `~/.continuity/continuity.db`, so no spec ever
 * sees the developer's real sessions. Fixed path (not mkdtemp) because the launcher and
 * the workers each evaluate this module and must agree; `onPrepare` creates it fresh.
 * Only the specs write it -- the app never does.
 */
export const E2E_CONTINUITY_DB = join(tmpdir(), "conduit-e2e-continuity", "continuity.db");
process.env.CONTINUITY_DB_PATH = E2E_CONTINUITY_DB;

/**
 * The service SPAWNS this path, so on macOS it must be the executable inside the bundle
 * — a `.app` is a directory and spawning it fails with EACCES. It still has to be the
 * bundled copy rather than `target/debug/conduit-tauri`, because only the bundle carries
 * the Info.plist and the resources (the continuity plugin) the app reads at startup.
 */
const binary =
  platform() === "win32"
    ? resolve("src-tauri/target/debug/conduit-tauri.exe")
    : platform() === "darwin"
      ? resolve("src-tauri/target/debug/bundle/macos/Conduit.app/Contents/MacOS/conduit-tauri")
      : resolve("src-tauri/target/debug/conduit-tauri");

/** Where the app under test keeps its state — `store::data_dir`'s rule, in Node. */
export function e2eDataDir(): string {
  const base =
    platform() === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : platform() === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  return join(base, E2E_DATA_DIR);
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/**/*.e2e.ts"],
  // One app instance: the specs share the app's state deliberately (the second spec
  // asserts the FIRST one's project was not added twice).
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: binary },
    },
  ],
  services: ["@wdio/tauri-service"],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  // A cold app boot plus a real agent spawn is slow; these are wall-clock budgets, not
  // expectations.
  mochaOpts: { ui: "bdd", timeout: 180_000 },

  /**
   * Start from an empty app. The previous run's projects survive in state.json and
   * share this spec's project NAME, so counting sidebar rows by name would see them and
   * the "not added twice" assertion would fail for a reason that is not a bug.
   *
   * Guarded on the marker: this deletes a directory, and it must only ever be the
   * harness's own.
   */
  onPrepare() {
    if (!E2E_DATA_DIR.includes("-e2e")) {
      throw new Error(`refusing to reset ${E2E_DATA_DIR}: not an e2e data directory`);
    }
    rmSync(e2eDataDir(), { recursive: true, force: true });
    rmSync(join(tmpdir(), "conduit-e2e-continuity"), { recursive: true, force: true });
    mkdirSync(join(tmpdir(), "conduit-e2e-continuity"), { recursive: true });
    createContinuityDb(E2E_CONTINUITY_DB);
  },
};
