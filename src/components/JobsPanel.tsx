import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { jobDuration, jobStatus, sortJobs, type Job } from "../jobs";
import { useJobOutput } from "../hooks/useJobs";

/**
 * The right column's Jobs tab: commands an agent handed to Conduit with `conduit run`
 * instead of running in its own shell. A job is work the user would otherwise not see at
 * all -- it has no terminal -- so this is where it is watched and where it can be stopped.
 */
export function JobsPanel({ jobs, sessionNames }: { jobs: Job[]; sessionNames: Record<string, string> }) {
  const ordered = sortJobs(jobs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Follow the newest job until the user picks one; a pick that has since been pruned
  // falls back the same way.
  const selected = ordered.find((j) => j.id === selectedId) ?? ordered[0];
  const output = useJobOutput(selected);

  // One clock for every duration on screen, ticking only while something is running.
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = jobs.some((j) => j.running);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  // Keep the newest output in view unless the user has scrolled up to read.
  const outRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = outRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [output, selected?.id]);

  if (ordered.length === 0) {
    return (
      <p className="placeholder" style={{ padding: 12 }}>
        No jobs. An agent starts one with <code>conduit run --bg -- &lt;command&gt;</code>.
      </p>
    );
  }
  return (
    <div className="jobs-panel">
      <div className="jobs-list" role="listbox" aria-label="Jobs">
        {ordered.map((job) => {
          const status = jobStatus(job);
          const owner = job.owner ? sessionNames[job.owner] : undefined;
          return (
            <div
              key={job.id}
              role="option"
              aria-selected={job.id === selected?.id}
              tabIndex={0}
              className={`job-row ${job.id === selected?.id ? "selected" : ""}`}
              onClick={() => setSelectedId(job.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedId(job.id);
                }
              }}
              title={`${job.command}\n${job.cwd}`}
            >
              <span className={`job-dot ${status.tone}`} />
              <span className="job-id">{job.id}</span>
              <span className="job-name">{job.name}</span>
              <span className="job-command">{job.command}</span>
              <span className="job-meta">
                {owner ? `${owner} · ` : ""}
                {status.text} · {jobDuration(job, now)}
              </span>
              {job.running && (
                <button
                  className="job-stop"
                  title="Stop this job and everything it started"
                  onClick={(e) => {
                    e.stopPropagation();
                    void invoke("job_kill", { id: job.id });
                  }}
                >
                  Stop
                </button>
              )}
            </div>
          );
        })}
      </div>
      <pre
        className="job-output"
        ref={outRef}
        aria-label={selected ? `Output of ${selected.name}` : undefined}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {output || (selected?.running ? "No output yet." : "This job printed nothing.")}
      </pre>
    </div>
  );
}
