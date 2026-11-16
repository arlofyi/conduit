/** Jobs (`conduit run`): pure rules for the Jobs panel. The engine is `jobs.rs`. */

/** One job as `jobs_list` returns it (`jobs::JobView`). */
export interface Job {
  id: string;
  name: string;
  command: string;
  cwd: string;
  /** The Conduit session whose agent started it, when the shim ran inside one. */
  owner: string | null;
  startedMs: number;
  endedMs: number | null;
  running: boolean;
  exitCode: number | null;
  killed: boolean;
}

export type JobTone = "running" | "ok" | "failed" | "stopped";

/** What one job is doing, in the words the panel shows. */
export function jobStatus(job: Pick<Job, "running" | "exitCode" | "killed">): { tone: JobTone; text: string } {
  if (job.running) return { tone: "running", text: "running" };
  // A job the user stopped did not fail: its exit code is only the signal that ended it.
  if (job.killed) return { tone: "stopped", text: "stopped" };
  if (job.exitCode === 0) return { tone: "ok", text: "done" };
  return { tone: "failed", text: `exit ${job.exitCode ?? "?"}` };
}

/** How long a job has run or ran: `8s`, `2m 05s`, `1h 03m`. */
export function jobDuration(job: Pick<Job, "startedMs" | "endedMs">, now: number): string {
  const total = Math.max(0, Math.floor(((job.endedMs ?? now) - job.startedMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${two(m)}m`;
  if (m > 0) return `${m}m ${two(s)}s`;
  return `${s}s`;
}

/** Running jobs first, then the most recently started. */
export function sortJobs<J extends Pick<Job, "running" | "startedMs">>(jobs: J[]): J[] {
  return [...jobs].sort((a, b) => Number(b.running) - Number(a.running) || b.startedMs - a.startedMs);
}

interface ProjectLike {
  id: string;
  path: string;
  sessions: { id: string; worktreePath?: string | null }[];
}

/** `dir` is `root` or inside it. Compared on separators so `/repo2` is not inside `/repo`. */
function within(dir: string, root: string): boolean {
  if (!root) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const d = norm(dir);
  const r = norm(root);
  return d === r || d.startsWith(`${r}/`);
}

function projectOf(job: Pick<Job, "owner" | "cwd">, projects: ProjectLike[]): string | null {
  // The owner decides when there is one: a session can run a job anywhere on disk.
  if (job.owner) {
    const owned = projects.find((p) => p.sessions.some((s) => s.id === job.owner));
    if (owned) return owned.id;
  }
  const byDir = projects.find(
    (p) => within(job.cwd, p.path) || p.sessions.some((s) => !!s.worktreePath && within(job.cwd, s.worktreePath)),
  );
  return byDir?.id ?? null;
}

/**
 * The jobs a project's panel shows: its own, plus any that belong to NO project. A job
 * started from a plain terminal in a folder Conduit does not know has no other place to
 * appear, and hiding it would leave a process running that the user cannot see or stop.
 */
export function jobsForProject<J extends Pick<Job, "owner" | "cwd">>(
  jobs: J[],
  projectId: string,
  projects: ProjectLike[],
): J[] {
  return jobs.filter((j) => {
    const home = projectOf(j, projects);
    return home === projectId || home === null;
  });
}

/** The tab's label: how many are running, or nothing extra when none is. */
export function jobsTabLabel(jobs: Pick<Job, "running">[]): string {
  const running = jobs.filter((j) => j.running).length;
  return running > 0 ? `Jobs ${running}` : "Jobs";
}
