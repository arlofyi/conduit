/**
 * Applying a `conduit <path> [...]` invocation: matching its directory against the open
 * projects, then spawning the session it asks for.
 *
 * `Store::add_project` does NOT dedupe by path, so without the match every `conduit .` on
 * an already-open project would add a second copy of it.
 *
 * This module imports the store, so a test must stub `localStorage` and `window` before
 * importing it (see cliOpen.test.ts).
 */
import { invoke } from "@tauri-apps/api/core";
import { AGENTS, type AgentId } from "./agents";
import { eventInThisWindow, normalizeProfileId } from "./profiles";
import { globalSelectedSessionId, useStore, WINDOWED } from "./store";

/** Guard wrapper for per-window listeners, binding the pure (and tested, profiles.test.ts)
 *  `eventInThisWindow` to `WINDOWED` and this window's live profile list. The item's
 *  profile id is a THUNK, not a value: switch mode returns `true` before ever calling it,
 *  so a caller's store lookup (`findSession`, `rootChats.find`, `projects.find`) only runs
 *  when a guard can actually change the outcome -- the property a reviewer checks for each
 *  guard is "does this collapse to today's behavior with the pref off", and this is where
 *  that collapse happens. */
export function inThisWindow(
  getItemProfileId: () => string | null | undefined,
  windowProfileId: string | null,
  profiles: { id: string }[],
): boolean {
  if (!WINDOWED) return true;
  return eventInThisWindow(
    true,
    getItemProfileId(),
    windowProfileId,
    new Set(profiles.map((p) => p.id)),
  );
}

/** Windows paths are case-insensitive and may use either separator. */
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;

function normalize(path: string): string {
  let p = path.trim();
  if (!p) return "";
  if (WINDOWS_PATH.test(p)) p = p.replace(/\\/g, "/").toLowerCase();
  // Strip trailing separators, but never reduce a root to the empty string.
  while (p.length > 1 && (p.endsWith("/") || p.endsWith("\\"))) p = p.slice(0, -1);
  return p;
}

export function matchProjectByPath(
  projects: { id: string; path: string }[],
  path: string,
): string | null {
  const want = normalize(path);
  if (!want || want === "/") return null;
  return projects.find((p) => normalize(p.path) === want)?.id ?? null;
}

/** One `conduit <path> [--agent <id> [--worktree <slug>] [--name <text>] [--prompt-file <file>]
 *  [--provider <p>] [--model <m>] [--effort <e>]]`
 *  invocation's payload -- shared by the live `cli-open` listener and the
 *  `take_pending_opens` boot-time drain. Mirrors Rust's `OpenPayload`; `prompt` is the
 *  prompt file's text, already read by Rust. */
export type CliOpenPayload = {
  path: string;
  agent?: string | null;
  worktree?: string | null;
  name?: string | null;
  prompt?: string | null;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
};

/** Apply one `cli-open` payload: select (or add) its project and spawn `--agent`'s
 *  session if given. Factored out of the live listener so the SAME logic also handles a
 *  payload that arrived while this window didn't exist yet -- queued by the Rust sink
 *  (Finding 1's pending-open path) and drained via `take_pending_opens` once `load()`
 *  resolves. Before that fix, the sink's fallback-to-any-window path would ask App.tsx to
 *  open/focus the right window (the redirect branch below) but had nothing to hand the
 *  payload to once that window existed, so the project was never selected and `--agent`
 *  never spawned. */
export async function applyCliOpenPayload(payload: CliOpenPayload): Promise<void> {
  const st = useStore.getState();
  let projectId = matchProjectByPath(st.projects, payload.path);
  // Rust already resolved ONE target window (the matched project's own profile window,
  // else the focused window, else "main") before emitting -- but a fallback edge
  // (ambiguous focus) can still land the event here for a project that isn't this
  // window's. Redirect rather than handle it locally in that case.
  if (projectId && WINDOWED) {
    const project = st.projects.find((p) => p.id === projectId);
    if (!inThisWindow(() => project?.profileId, st.windowProfile.profileId, st.profiles)) {
      const knownIds = new Set(st.profiles.map((p) => p.id));
      void invoke("open_profile_window", {
        profileId: normalizeProfileId(project?.profileId, knownIds),
      });
      return;
    }
  }
  if (!projectId) {
    // Store::add_project does not dedupe, which is what makes the match above
    // load-bearing rather than an optimization.
    await st.addProject(payload.path);
    projectId = useStore.getState().selectedProjectId;
  } else {
    st.selectProject(projectId);
  }
  // `--agent` creates a session unconditionally and never resumes an existing
  // one, so its effect never depends on `restoreSessionsOnOpen`.
  if (projectId && payload.agent) {
    // An agent id invented by whatever called the CLI must never render as a promise:
    // `AgentId`'s deserialize is deliberately lenient, so an unknown id would silently
    // spawn Claude under it. Same check `decisionRoute` makes.
    if (!AGENTS.some((a) => a.id === payload.agent)) {
      useStore.getState().pushToast(`conduit: unknown agent "${payload.agent}"`, "error");
      return;
    }
    // `--provider` / `--model` / `--effort` pin the NEW session, which is what lets one
    // agent launch another under conditions it chose -- a Hermes session on a local model
    // starting a worker on OpenRouter, say. Provider and model ride in `addSession` so the
    // session is created WITH them rather than corrected after its terminal has spawned.
    // The provider is resolved to the agent's own slug on the Rust side, where the
    // endpoint pool lives.
    await useStore.getState().addSession(projectId, {
      agent: payload.agent as AgentId,
      name: payload.name ?? undefined,
      useWorktree: !!payload.worktree,
      worktreeSlug: payload.worktree ?? null,
      prompt: payload.prompt ?? null,
      model: payload.model ?? null,
      provider: payload.provider ?? null,
    });
    if (payload.effort) {
      const id = globalSelectedSessionId(useStore.getState());
      if (id) await useStore.getState().setSessionEffort(id, payload.effort);
    }
  }
}
