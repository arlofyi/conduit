import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore, findSession } from "../store";
import { waitingClock } from "../asks";
import {
  alreadyAnsweredCopy,
  permissionOutcomeCopy,
  remoteNote,
  resolvedCopy,
  sortPermissions,
  type PendingPermission,
} from "../permissionView";

/** How long the card's own result stays up if `permission-resolved` never arrives. */
const DONE_FALLBACK_MS = 4500;
/** How long "already answered" stays up before the card drops itself. */
const GONE_MS = 2500;

/** Tool permissions Rust is holding (broker.rs). Oldest docks on top of the question dock,
 *  with a count of the rest. Unlike a question, a permission is never drawn in the graph,
 *  so it always docks here. Mounted in App's `.hold-dock`, never inside the terminal tree. */
export function PermissionDock() {
  // Raw map + memo: a selector returning a fresh array loops in Zustand v5.
  const map = useStore((s) => s.permissions);
  const projects = useStore((s) => s.projects);
  const list = useMemo(() => sortPermissions(Object.values(map)), [map]);
  if (list.length === 0) return null;
  const first = list[0];
  const name = findSession(projects, first.session)?.session.name ?? "A session";
  return (
    <div className="perm-dock">
      <PermissionCard key={first.id} perm={first} sessionName={name} />
      {list.length > 1 && <div className="ask-dock-more">+{list.length - 1} more waiting</div>}
    </div>
  );
}

/** One PermissionRequest: the tool, Rust's one-line summary, Deny / Allow. Claude's own
 *  dialog is still up in the terminal; whichever answers first wins. Buttons only: an
 *  Allow is irreversible, so no window-wide keys and the card never takes focus itself. */
export function PermissionCard({ perm, sessionName }: { perm: PendingPermission; sessionName: string }) {
  const [state, setState] = useState<"idle" | "sending" | "allowed" | "denied" | "gone" | "error">("idle");
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const resolvedBy = useStore((s) => s.permissionResolvedBy[perm.id] ?? null);

  const ownDone = state === "allowed" || state === "denied";
  const remote = ownDone || state === "gone" ? null : remoteNote(resolvedBy, state === "sending");
  const remoteCopy = remote ? resolvedCopy(remote) : null;
  const settled = ownDone || state === "gone" || !!remoteCopy;

  // A missed `permission-resolved` must not leave a stuck card hiding later ones.
  useEffect(() => {
    if (!ownDone && state !== "gone") return;
    const t = setTimeout(() => useStore.getState().removePermission(perm.id), state === "gone" ? GONE_MS : DONE_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [state, ownDone, perm.id]);

  useEffect(() => {
    if (settled) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [settled]);

  const respond = async (allow: boolean) => {
    if (inFlight.current || settled) return;
    inFlight.current = true;
    setState("sending");
    try {
      // true = Conduit's answer reached Claude's hook. NOT proof the tool was stopped.
      const ok = await invoke<boolean>("permission_respond", { id: perm.id, allow });
      setState(ok ? (allow ? "allowed" : "denied") : "gone");
    } catch {
      setState("error");
    } finally {
      inFlight.current = false;
    }
  };

  const outcome = ownDone ? permissionOutcomeCopy(state === "allowed") : null;

  return (
    <div
      className={`ask-card perm-card ${settled ? "done" : ""}`}
      role="group"
      aria-label={`${sessionName} wants to use ${perm.toolName}`}
    >
      {outcome ? (
        <div className="ask-card-done" role="status">
          <span className={state === "allowed" ? "ask-card-ck" : "perm-card-x"} aria-hidden />
          <div>
            {outcome.title} {perm.toolName} for {sessionName}
            {outcome.detail && <small>{outcome.detail}</small>}
          </div>
        </div>
      ) : remoteCopy ? (
        <div className="ask-card-done" role="status">
          <span className="ask-card-ck" aria-hidden />
          <div>
            {remoteCopy}
            <small>
              {perm.toolName} · {sessionName}
            </small>
          </div>
        </div>
      ) : (
        <>
          <p className="ask-card-q">
            Allow <span className="perm-card-tool">{perm.toolName}</span>?
          </p>
          <div className="ask-card-who">
            <span className="ask-card-dot" aria-hidden />
            <span className="ask-card-name">{sessionName}</span>
            <span className="ask-card-sep" aria-hidden>·</span>
            <span className="ask-card-t">waiting {waitingClock(perm.createdMs, now)}</span>
          </div>
          {perm.summary.trim() && <pre className="perm-card-cmd">{perm.summary}</pre>}
          {state === "gone" ? (
            <div className="ask-card-note">{alreadyAnsweredCopy(resolvedBy)}</div>
          ) : (
            <>
              <div className="ask-card-ft">
                <span className="ask-card-hint">Also asking in the terminal</span>
                <span className="ask-card-grow" />
                <button
                  type="button"
                  className="perm-card-deny"
                  disabled={state === "sending"}
                  onClick={() => void respond(false)}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="ask-card-send"
                  disabled={state === "sending"}
                  onClick={() => void respond(true)}
                >
                  Allow
                </button>
              </div>
              {state === "error" && (
                <div className="ask-card-note">Couldn't send — try again or answer in the terminal.</div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
