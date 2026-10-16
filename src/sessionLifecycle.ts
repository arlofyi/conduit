// When sessions start and stop on their own: the launch rule and the idle auto-stop.
//
// A session's PROCESS is disposable and its conversation is not -- every agent resumes
// where it left off (`claude --resume`, agy `--conversation`). Each live Claude session
// measured 0.8 to 0.96 GB with its MCP servers, so a finished agent kept running for the
// rest of the day is the single biggest cost Conduit has. This module decides:
//
//   * at launch, which sessions come back by themselves: only those whose agent was still
//     working when Conduit closed (the Rust hook listener persists `Session.agentState`
//     on every change, so this holds after a crash or an update install too);
//   * while running, which finished sessions to stop after a quiet period.
//
// Pure and standalone (no store import) so the node-env vitest can cover it; same reason
// `startup.ts` and `usageRows.ts` exist.

export type LaunchRestore = "working" | "project" | "none";

export interface SessionLifecyclePrefs {
  /**
   * `working` (default): on launch, start only sessions whose agent was mid-task when
   * Conduit closed; everything else waits for you. `project`: the old behaviour -- opening
   * a project starts every one of its sessions. `none`: nothing starts by itself.
   */
  launchRestore: LaunchRestore;
  /** Also bring back, at launch, sessions that were waiting on you. Default off. */
  resumeWaitingOnLaunch: boolean;
  /** Stop a session once its agent has finished and the session has been quiet. */
  autoStopIdle: boolean;
  /** Minutes after the agent finishes before auto-stop. Default 5. */
  autoStopMinutes: number;
  /** Also auto-stop sessions whose agent is waiting on you (same delay). Default off. */
  autoStopWaiting: boolean;
  /** Also auto-stop the session(s) currently on screen. Default off. */
  autoStopVisible: boolean;
  /** Return Claude's shell to the session folder after every command. Default on. */
  keepAgentsInProject: boolean;
}

export const DEFAULT_LIFECYCLE: SessionLifecyclePrefs = {
  launchRestore: "working",
  resumeWaitingOnLaunch: false,
  autoStopIdle: true,
  autoStopMinutes: 5,
  autoStopWaiting: false,
  autoStopVisible: false,
  keepAgentsInProject: true,
};

export const MIN_AUTO_STOP_MINUTES = 1;
export const MAX_AUTO_STOP_MINUTES = 24 * 60;

export function clampMinutes(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return DEFAULT_LIFECYCLE.autoStopMinutes;
  return Math.min(MAX_AUTO_STOP_MINUTES, Math.max(MIN_AUTO_STOP_MINUTES, Math.round(v)));
}

/**
 * Read the stored prefs. Unknown or malformed fields fall back to the defaults one by one,
 * so adding a field later never resets the others. With nothing stored yet, the legacy
 * "Restore sessions when opening a project" switch decides only whether the user had
 * opted OUT of automatic starts (`"0"` maps to `none`); its default-on maps to the new
 * default, because starting every session of a project is what this replaces.
 */
export function parseLifecycle(raw: string | null, legacyRestore: string | null): SessionLifecyclePrefs {
  let stored: Record<string, unknown> = {};
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object") stored = v as Record<string, unknown>;
    } catch {
      /* unreadable -- defaults */
    }
  } else if (legacyRestore === "0") {
    stored = { launchRestore: "none" };
  }
  const bool = (k: keyof SessionLifecyclePrefs) =>
    typeof stored[k] === "boolean" ? (stored[k] as boolean) : (DEFAULT_LIFECYCLE[k] as boolean);
  const mode = stored.launchRestore;
  return {
    launchRestore:
      mode === "working" || mode === "project" || mode === "none"
        ? mode
        : DEFAULT_LIFECYCLE.launchRestore,
    resumeWaitingOnLaunch: bool("resumeWaitingOnLaunch"),
    autoStopIdle: bool("autoStopIdle"),
    autoStopMinutes:
      stored.autoStopMinutes === undefined
        ? DEFAULT_LIFECYCLE.autoStopMinutes
        : clampMinutes(stored.autoStopMinutes),
    autoStopWaiting: bool("autoStopWaiting"),
    autoStopVisible: bool("autoStopVisible"),
    keepAgentsInProject: bool("keepAgentsInProject"),
  };
}

export interface LifecycleSession {
  id: string;
  stopped?: boolean;
  /** Last persisted agent activity: running | needsInput | done | idle. */
  agentState?: string | null;
  role?: string;
}

/** The sessions that start by themselves when Conduit launches. */
export function launchResumeTargets(
  sessions: LifecycleSession[],
  prefs: Pick<SessionLifecyclePrefs, "launchRestore" | "resumeWaitingOnLaunch">,
): Set<string> {
  const out = new Set<string>();
  if (prefs.launchRestore !== "working") return out;
  for (const s of sessions) {
    if (s.stopped) continue;
    if (s.agentState === "running") out.add(s.id);
    else if (prefs.resumeWaitingOnLaunch && s.agentState === "needsInput") out.add(s.id);
  }
  return out;
}

export interface LiveStatus {
  status: string;
  /** When `status` was last asserted, epoch ms. Absent = never reported this run. */
  updatedAt?: number;
}

export interface IdleStopInput {
  now: number;
  sessions: (LifecycleSession & { projectId: string })[];
  live: Record<string, LiveStatus | undefined>;
  /** Sessions currently on screen. */
  visible: Set<string>;
  prefs: Pick<
    SessionLifecyclePrefs,
    "autoStopIdle" | "autoStopMinutes" | "autoStopWaiting" | "autoStopVisible"
  >;
}

/**
 * Sessions to stop now. A candidate has reported this run (a `live` entry with a time --
 * which is also how we know it has a running process), its agent has finished (`done` or
 * `idle`; `needsInput` only when opted in), and that status is at least the configured
 * minutes old. A `running` agent is never stopped. Conductors are exempt: they sit idle
 * between worker results by design, and a stopped one cannot be woken.
 */
export function idleStopTargets(input: IdleStopInput): { projectId: string; sessionId: string }[] {
  const { now, sessions, live, visible, prefs } = input;
  if (!prefs.autoStopIdle) return [];
  const quietMs = clampMinutes(prefs.autoStopMinutes) * 60_000;
  const out: { projectId: string; sessionId: string }[] = [];
  for (const s of sessions) {
    if (s.stopped || s.role === "conductor") continue;
    if (!prefs.autoStopVisible && visible.has(s.id)) continue;
    const l = live[s.id];
    if (!l || l.updatedAt === undefined) continue;
    const finished =
      l.status === "done" || l.status === "idle" || (prefs.autoStopWaiting && l.status === "needsInput");
    if (!finished) continue;
    if (now - l.updatedAt < quietMs) continue;
    out.push({ projectId: s.projectId, sessionId: s.id });
  }
  return out;
}
