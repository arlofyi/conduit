import { invoke } from "@tauri-apps/api/core";
import { createDedupe, toReport, type ErrorKind } from "./diagnostics";

// Forwards UI errors to the local log (`log_frontend_error` in diag.rs). Fire-and-forget:
// reporting must never throw, and a failed report must never itself be reported (that is
// how an error handler turns one fault into a loop).

const allow = createDedupe();

export function reportError(
  kind: ErrorKind,
  thrown: unknown,
  source: string,
  componentStack?: string | null,
): void {
  try {
    const report = toReport(kind, thrown, source, componentStack);
    if (!allow(report, Date.now())) return;
    void invoke("log_frontend_error", { report }).catch(() => {});
  } catch {
    /* never let reporting fail loudly */
  }
}

let installed = false;

/** `window` error + unhandled rejection -> the local log. Idempotent. */
export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => {
    // A failed <img>/<script> load also fires "error" (on the element, captured here
    // only with capture: true, which we do not use) -- this is the script-error path.
    reportError("error", e.error ?? e.message, "window");
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportError("rejection", e.reason, "window");
  });
}
