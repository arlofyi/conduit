import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Job } from "../jobs";

/**
 * Every job (`conduit run`), kept current. Rust emits `jobs-changed` when one starts or
 * ends -- the only two things that change the list -- so there is no polling here. The
 * listener is registered BEFORE the first fetch: a job that starts in between would
 * otherwise be missed until the next one.
 */
export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      invoke<Job[]>("jobs_list")
        .then((list) => {
          if (alive) setJobs(list);
        })
        .catch(() => {});
    };
    const unlisten = listen("jobs-changed", refresh);
    refresh();
    return () => {
      alive = false;
      void unlisten.then((f) => f());
    };
  }, []);
  return jobs;
}

/** How many trailing lines the panel shows. More is in `conduit read <job> --lines N`. */
const OUTPUT_LINES = 400;
/** How often a RUNNING job's output is re-read. A finished job is read once. */
const OUTPUT_POLL_MS = 1000;

/** The tail of one job's output, re-read while it runs. */
export function useJobOutput(job: Pick<Job, "id" | "running"> | undefined): string {
  const [text, setText] = useState("");
  const id = job?.id;
  const running = job?.running ?? false;
  useEffect(() => {
    if (!id) {
      setText("");
      return;
    }
    let alive = true;
    const read = () => {
      invoke<string>("job_output", { id, lines: OUTPUT_LINES })
        .then((t) => {
          if (alive) setText(t);
        })
        .catch(() => {});
    };
    read();
    // `running` is a dependency, so the flip to finished re-runs this and reads the last
    // lines once more -- the ones written after the final poll.
    const timer = running ? setInterval(read, OUTPUT_POLL_MS) : undefined;
    return () => {
      alive = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [id, running]);
  return text;
}
