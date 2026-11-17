import { ask } from "@tauri-apps/plugin-dialog";

/**
 * Ask a yes/no question and WAIT for the answer.
 *
 * The browser's `confirm()` cannot be used here: tauri-plugin-dialog replaces it with an
 * async function, so a bare call returns a Promise -- always truthy -- and the action it
 * was guarding runs before the dialog is even drawn. `confirm.seam.test.ts` keeps bare
 * calls out of the source. A dialog that fails to open answers `false`: no answer is
 * never a yes.
 */
export async function confirmDialog(message: string): Promise<boolean> {
  try {
    return await ask(message, { title: "Conduit", kind: "warning" });
  } catch (e) {
    console.error("confirm dialog failed:", e);
    return false;
  }
}
