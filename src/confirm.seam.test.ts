import { describe, expect, it } from "vitest";
// @ts-expect-error node builtins are deliberately untyped here (see store.seam.test.ts)
import { readdirSync, readFileSync, statSync } from "node:fs";
// @ts-expect-error same reason as above
import { join } from "node:path";

/**
 * `window.confirm` is not synchronous in this app.
 *
 * `tauri-plugin-dialog` injects an init script that replaces it with an ASYNC function
 * (`window.confirm = async function …`), so a bare call returns a Promise. A Promise is
 * truthy: `if (!confirm(msg)) return;` never returns, and `if (confirm(msg)) remove()`
 * always removes. The dialog still appears, a moment later, over work that has already
 * been done -- which is how "Delete session?" came to be asked after the session was gone.
 *
 * A typecheck cannot see this: lib.dom.d.ts still declares `confirm(): boolean`. So the
 * rule is enforced here: ask through `confirmDialog` (src/confirmDialog.ts), awaited.
 */

const SOURCE_EXT = /\.(ts|tsx)$/;
/** A bare `confirm(` / `alert(` call, or one through `window.` -- not `foo.confirm(`,
 *  not `pair_confirm(`. */
const SYNC_DIALOG = /(?<![\w.])(?:window\.)?(?:confirm|alert)\(/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (SOURCE_EXT.test(entry)) acc.push(path.replace(/\\/g, "/"));
  }
  return acc;
}

describe("confirm seam", () => {
  it("never calls the browser's confirm/alert, which Tauri makes async", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      if (file.endsWith(".test.ts")) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line: string, i: number) => {
          const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
          if (SYNC_DIALOG.test(code)) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(
      offenders,
      `These lines call confirm()/alert() as if it answered synchronously:\n` +
        offenders.map((o) => `  - ${o}`).join("\n") +
        `\n\nUse \`await confirmDialog(message)\` from src/confirmDialog.ts.`,
    ).toEqual([]);
  });
});
