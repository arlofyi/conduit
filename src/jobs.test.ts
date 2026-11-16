import { describe, expect, it } from "vitest";
import { jobDuration, jobStatus, jobsForProject, jobsTabLabel, sortJobs } from "./jobs";

describe("job status", () => {
  it("names each end state, and a stopped job is not a failed one", () => {
    expect(jobStatus({ running: true, exitCode: null, killed: false })).toEqual({ tone: "running", text: "running" });
    expect(jobStatus({ running: false, exitCode: 0, killed: false })).toEqual({ tone: "ok", text: "done" });
    expect(jobStatus({ running: false, exitCode: 101, killed: false })).toEqual({ tone: "failed", text: "exit 101" });
    expect(jobStatus({ running: false, exitCode: 143, killed: true })).toEqual({ tone: "stopped", text: "stopped" });
    // Killed but still winding down reads as running until it has actually ended.
    expect(jobStatus({ running: true, exitCode: null, killed: true }).tone).toBe("running");
    expect(jobStatus({ running: false, exitCode: null, killed: false }).text).toBe("exit ?");
  });
});

describe("job duration", () => {
  const t0 = 1_700_000_000_000;
  it("counts to now while running and to the end once finished", () => {
    expect(jobDuration({ startedMs: t0, endedMs: null }, t0 + 8_400)).toBe("8s");
    expect(jobDuration({ startedMs: t0, endedMs: t0 + 125_000 }, t0 + 999_999)).toBe("2m 05s");
    expect(jobDuration({ startedMs: t0, endedMs: t0 + 3_780_000 }, t0)).toBe("1h 03m");
    expect(jobDuration({ startedMs: t0, endedMs: null }, t0)).toBe("0s");
  });
  it("never goes negative when the clocks disagree", () => {
    expect(jobDuration({ startedMs: t0, endedMs: null }, t0 - 5_000)).toBe("0s");
  });
});

describe("job order", () => {
  it("puts running jobs first, then the newest", () => {
    const jobs = [
      { id: "a", running: false, startedMs: 30 },
      { id: "b", running: true, startedMs: 10 },
      { id: "c", running: false, startedMs: 40 },
      { id: "d", running: true, startedMs: 20 },
    ];
    expect(sortJobs(jobs).map((j) => j.id)).toEqual(["d", "b", "c", "a"]);
    // The input is not reordered in place.
    expect(jobs[0].id).toBe("a");
  });
});

describe("which project shows a job", () => {
  const projects = [
    { id: "p1", path: "/code/repo", sessions: [{ id: "s1", worktreePath: "/code/repo/.claude/worktrees/x" }] },
    { id: "p2", path: "/code/repo2", sessions: [{ id: "s2", worktreePath: "/elsewhere/wt" }] },
  ];
  const ids = (list: { id: string }[]) => list.map((j) => j.id);
  const job = (id: string, owner: string | null, cwd: string) => ({ id, owner, cwd });

  it("follows the owning session, wherever on disk the job ran", () => {
    const jobs = [job("a", "s1", "/tmp"), job("b", "s2", "/code/repo")];
    expect(ids(jobsForProject(jobs, "p1", projects))).toEqual(["a"]);
    expect(ids(jobsForProject(jobs, "p2", projects))).toEqual(["b"]);
  });

  it("falls back to the directory, and /repo2 is not inside /repo", () => {
    const jobs = [
      job("a", null, "/code/repo/src"),
      job("b", null, "/code/repo2"),
      job("c", null, "/elsewhere/wt/pkg"),
      job("d", "gone", "/code/repo"),
    ];
    expect(ids(jobsForProject(jobs, "p1", projects))).toEqual(["a", "d"]);
    expect(ids(jobsForProject(jobs, "p2", projects))).toEqual(["b", "c"]);
  });

  it("shows a job that belongs nowhere in every project, so it is never invisible", () => {
    const jobs = [job("a", null, "/somewhere/else"), job("b", "unknown-session", "/var/tmp")];
    expect(ids(jobsForProject(jobs, "p1", projects))).toEqual(["a", "b"]);
    expect(ids(jobsForProject(jobs, "p2", projects))).toEqual(["a", "b"]);
  });

  it("reads Windows paths and trailing separators the same way", () => {
    const win = [{ id: "w", path: "C:\\code\\repo\\", sessions: [] }];
    expect(ids(jobsForProject([job("a", null, "C:\\code\\repo\\src")], "w", win))).toEqual(["a"]);
  });
});

describe("the Jobs tab label", () => {
  it("counts running jobs and says nothing extra when none is", () => {
    expect(jobsTabLabel([])).toBe("Jobs");
    expect(jobsTabLabel([{ running: false }])).toBe("Jobs");
    expect(jobsTabLabel([{ running: true }, { running: false }, { running: true }])).toBe("Jobs 2");
  });
});
