//! Jobs: slow commands an agent hands to Conduit instead of running in its own shell.
//!
//! An agent's shell tool holds the agent until the command ends: no messages, no worker
//! news, no other work, and the tool's own timeout kills a long build. `conduit run --bg --
//! cargo build` starts the command HERE instead and returns at once; `conduit wait` blocks
//! on it, `conduit read` returns its output. The work is also visible to the person (the
//! Jobs panel) and counts as the session being busy, so idle auto-stop leaves it alone.
//!
//! The entry point is the `conduit` CLI, not an MCP tool, on purpose: the agent calls it
//! through its own shell tool, so the user's existing allow and deny rules for commands
//! still apply. An MCP tool that runs commands would be one switch that skips all of them.
//!
//! `handle_job` is the `/job` route. It is authenticated exactly like `/open` (see
//! `cli_open`), takes no Tauri handle, and answers plain text so a POSIX shell can use the
//! reply without a JSON parser. That is what lets `tests/cli_jobs.rs` run the real shim
//! against the real handler.

use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Request, Response};

/// Jobs running at once, across every session. A runaway loop must not fork without bound.
pub const MAX_RUNNING: usize = 16;
/// Finished jobs kept for `read`; the oldest finished one goes first.
pub const MAX_KEPT: usize = 64;
/// Output kept per job. The tail, because the end of a build is the part that matters.
pub const OUTPUT_CAP: usize = 256 * 1024;
const MAX_COMMAND_BYTES: usize = 8 * 1024;
const MAX_NAME_CHARS: usize = 60;
const MAX_BODY: u64 = 64 * 1024;
pub const DEFAULT_WAIT_SECS: u64 = 50;
pub const MAX_WAIT_SECS: u64 = 600;
const DEFAULT_READ_LINES: usize = 200;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The last `OUTPUT_CAP` bytes a job wrote.
#[derive(Default)]
struct Tail {
    bytes: VecDeque<u8>,
    /// Bytes dropped off the front, so a reader can be told output was cut.
    dropped: u64,
}

impl Tail {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend(chunk);
        if self.bytes.len() > OUTPUT_CAP {
            let over = self.bytes.len() - OUTPUT_CAP;
            self.bytes.drain(..over);
            self.dropped += over as u64;
        }
    }

    /// The last `lines` lines. Lossy on purpose: a cut can land inside a UTF-8 character.
    fn last_lines(&self, lines: usize) -> String {
        let (a, b) = self.bytes.as_slices();
        let mut all = Vec::with_capacity(self.bytes.len());
        all.extend_from_slice(a);
        all.extend_from_slice(b);
        let text = String::from_utf8_lossy(&all);
        let body = text.strip_suffix('\n').unwrap_or(&text);
        let mut start = 0;
        for (seen, (i, _)) in body.rmatch_indices('\n').enumerate() {
            if seen + 1 == lines {
                start = i + 1;
                break;
            }
        }
        let mut out = body[start..].to_string();
        if !out.is_empty() {
            out.push('\n');
        }
        out
    }
}

struct Job {
    id: String,
    name: String,
    command: String,
    cwd: String,
    owner: Option<String>,
    started_ms: u64,
    ended_ms: Option<u64>,
    exit: Option<i32>,
    pid: u32,
    killed: bool,
    output: Arc<Mutex<Tail>>,
}

/// What the Jobs panel and the CLI see of a job.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub name: String,
    pub command: String,
    pub cwd: String,
    /// The Conduit session whose agent started it, when the shim ran inside one.
    pub owner: Option<String>,
    pub started_ms: u64,
    pub ended_ms: Option<u64>,
    pub running: bool,
    pub exit_code: Option<i32>,
    /// Stopped with `conduit kill` or the panel's Stop, rather than ending by itself.
    pub killed: bool,
}

impl Job {
    fn view(&self) -> JobView {
        JobView {
            id: self.id.clone(),
            name: self.name.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            owner: self.owner.clone(),
            started_ms: self.started_ms,
            ended_ms: self.ended_ms,
            running: self.exit.is_none(),
            exit_code: self.exit,
            killed: self.killed,
        }
    }
}

/// What `run` is asked to start.
#[derive(Deserialize, Debug, Default, Clone)]
pub struct RunSpec {
    pub command: String,
    pub cwd: String,
    /// The caller's `PATH`. Conduit is a GUI app and its own PATH has none of the user's
    /// tools on it; the shim runs in the agent's shell, which does.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
}

#[derive(Default)]
struct Inner {
    next: u32,
    jobs: Vec<Job>,
}

type Notifier = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub struct Jobs {
    inner: Mutex<Inner>,
    changed: Condvar,
    /// Called (off the lock) whenever a job starts or ends; the app emits `jobs-changed`.
    notifier: OnceLock<Notifier>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum JobError {
    /// The request itself is wrong (400).
    Bad(String),
    /// No such job (404).
    NotFound,
    /// Too many running (429).
    Busy,
}

impl JobError {
    pub fn status(&self) -> u16 {
        match self {
            JobError::Bad(_) => 400,
            JobError::NotFound => 404,
            JobError::Busy => 429,
        }
    }
    pub fn message(&self) -> String {
        match self {
            JobError::Bad(m) => m.clone(),
            JobError::NotFound => "no such job".into(),
            JobError::Busy => format!("{MAX_RUNNING} jobs are already running"),
        }
    }
}

fn bad(msg: impl Into<String>) -> JobError {
    JobError::Bad(msg.into())
}

/// A job's display name: the given one, else the command's first word.
fn display_name(name: Option<&str>, command: &str) -> String {
    let given = name.map(str::trim).filter(|n| !n.is_empty());
    let base = given.unwrap_or_else(|| command.split_whitespace().next().unwrap_or("job"));
    // Just the program, not its directory.
    let base = if given.is_none() {
        base.rsplit(['/', '\\']).next().unwrap_or(base)
    } else {
        base
    };
    base.chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect()
}

impl Jobs {
    pub fn set_notifier(&self, f: impl Fn() + Send + Sync + 'static) {
        let _ = self.notifier.set(Box::new(f));
    }

    fn notify(&self) {
        self.changed.notify_all();
        if let Some(f) = self.notifier.get() {
            f();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Starts `spec.command` in a shell and returns at once.
    pub fn run(self: &Arc<Self>, spec: RunSpec) -> Result<JobView, JobError> {
        let command = spec.command.trim().to_string();
        if command.is_empty() {
            return Err(bad("no command given"));
        }
        if command.len() > MAX_COMMAND_BYTES {
            return Err(bad("the command is too long"));
        }
        let cwd = Path::new(&spec.cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(bad(format!("not a directory: {}", spec.cwd)));
        }
        let name = display_name(spec.name.as_deref(), &command);
        let owner = spec.session.filter(|s| !s.trim().is_empty());

        let mut inner = self.lock();
        if inner.jobs.iter().filter(|j| j.exit.is_none()).count() >= MAX_RUNNING {
            return Err(JobError::Busy);
        }
        inner.next += 1;
        let id = format!("j{}", inner.next);

        let mut cmd = shell_command(&command);
        cmd.current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("CONDUIT_JOB_ID", &id)
            // Same reason every agent spawn scrubs it: it breaks nvm in a child shell.
            .env_remove("npm_config_prefix");
        if let Some(path) = spec.path.as_deref().filter(|p| !p.is_empty()) {
            cmd.env("PATH", path);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| bad(format!("could not start: {e}")))?;
        let pid = child.id();
        let output = Arc::new(Mutex::new(Tail::default()));
        for pipe in [
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let output = output.clone();
            std::thread::spawn(move || pump(pipe, &output));
        }
        inner.jobs.push(Job {
            id: id.clone(),
            name,
            command,
            cwd: spec.cwd,
            owner,
            started_ms: now_ms(),
            ended_ms: None,
            exit: None,
            pid,
            killed: false,
            output,
        });
        prune(&mut inner);
        let view = inner.jobs.last().map(Job::view).expect("just pushed");
        drop(inner);

        let jobs = self.clone();
        let waited = id.clone();
        std::thread::Builder::new()
            .name(format!("job-{id}"))
            .spawn(move || {
                let code = child.wait().map(exit_code).unwrap_or(-1);
                // Let the readers drain what the process wrote in its last moments.
                std::thread::sleep(Duration::from_millis(50));
                {
                    let mut inner = jobs.lock();
                    if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == waited) {
                        job.exit = Some(code);
                        job.ended_ms = Some(now_ms());
                    }
                }
                jobs.notify();
            })
            .ok();
        self.notify();
        Ok(view)
    }

    pub fn list(&self) -> Vec<JobView> {
        self.lock().jobs.iter().map(Job::view).collect()
    }

    pub fn get(&self, id: &str) -> Result<JobView, JobError> {
        self.lock()
            .jobs
            .iter()
            .find(|j| j.id == id)
            .map(Job::view)
            .ok_or(JobError::NotFound)
    }

    /// Blocks until the job has ended or `timeout` passes; answers its state either way.
    pub fn wait(&self, id: &str, timeout: Duration) -> Result<JobView, JobError> {
        let guard = self.lock();
        if !guard.jobs.iter().any(|j| j.id == id) {
            return Err(JobError::NotFound);
        }
        let (guard, _) = self
            .changed
            .wait_timeout_while(guard, timeout, |inner| {
                inner
                    .jobs
                    .iter()
                    .find(|j| j.id == id)
                    .is_some_and(|j| j.exit.is_none())
            })
            .unwrap_or_else(|e| e.into_inner());
        guard
            .jobs
            .iter()
            .find(|j| j.id == id)
            .map(Job::view)
            .ok_or(JobError::NotFound)
    }

    /// The last `lines` lines the job wrote (stdout and stderr together).
    pub fn read(&self, id: &str, lines: usize) -> Result<String, JobError> {
        let output = self
            .lock()
            .jobs
            .iter()
            .find(|j| j.id == id)
            .map(|j| j.output.clone())
            .ok_or(JobError::NotFound)?;
        let tail = output.lock().unwrap_or_else(|e| e.into_inner());
        let text = tail.last_lines(lines.max(1));
        // Say so when the start of the output is gone and the reader asked for more than
        // is left: silence there reads as "this is everything it printed".
        let asked_past_the_cut =
            tail.dropped > 0 && text.len() >= tail.bytes.len().saturating_sub(1);
        Ok(if asked_past_the_cut {
            format!(
                "[conduit: earlier output dropped; showing the last {} KB]\n{text}",
                OUTPUT_CAP / 1024
            )
        } else {
            text
        })
    }

    /// Ends a running job and everything it started. A finished job is left alone.
    pub fn kill(&self, id: &str) -> Result<(), JobError> {
        let pid = {
            let mut inner = self.lock();
            let job = inner
                .jobs
                .iter_mut()
                .find(|j| j.id == id)
                .ok_or(JobError::NotFound)?;
            if job.exit.is_some() {
                return Ok(());
            }
            job.killed = true;
            job.pid
        };
        kill_tree(pid);
        Ok(())
    }

    /// Ends every running job a session's agent started. Called when the session is
    /// destroyed: its jobs were that agent's work and nothing would ever read them.
    pub fn kill_owned_by(&self, session_id: &str) {
        for pid in self.running_pids(|j| j.owner.as_deref() == Some(session_id)) {
            kill_tree(pid);
        }
    }

    /// Ends every running job. Called on quit: a job is a child of this app.
    pub fn kill_all(&self) {
        for pid in self.running_pids(|_| true) {
            kill_tree(pid);
        }
    }

    fn running_pids(&self, keep: impl Fn(&Job) -> bool) -> Vec<u32> {
        let mut inner = self.lock();
        inner
            .jobs
            .iter_mut()
            .filter(|j| j.exit.is_none() && keep(j))
            .map(|j| {
                j.killed = true;
                j.pid
            })
            .collect()
    }

    /// Sessions whose agent has a job still running. Such a session is busy: stopping it
    /// for being idle would end work its agent is waiting on.
    pub fn busy_owners(&self) -> HashSet<String> {
        self.lock()
            .jobs
            .iter()
            .filter(|j| j.exit.is_none())
            .filter_map(|j| j.owner.clone())
            .collect()
    }
}

/// Drops the oldest FINISHED jobs beyond `MAX_KEPT`. A running job is never dropped.
fn prune(inner: &mut Inner) {
    while inner.jobs.len() > MAX_KEPT {
        match inner.jobs.iter().position(|j| j.exit.is_some()) {
            Some(i) => {
                inner.jobs.remove(i);
            }
            None => break,
        }
    }
}

fn pump(mut pipe: Box<dyn Read + Send>, output: &Mutex<Tail>) {
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => output
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(&buf[..n]),
        }
    }
}

#[cfg(unix)]
fn shell_command(command: &str) -> Command {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(command);
    // Its own process group, so `kill_tree` ends the whole pipeline, not just the shell.
    cmd.process_group(0);
    // SAFETY: runs between fork and exec; `close_inherited_fds` only makes async-signal-
    // safe system calls and touches no memory the parent's other threads could hold.
    unsafe {
        cmd.pre_exec(|| {
            close_inherited_fds();
            Ok(())
        });
    }
    cmd
}

/// Closes every file descriptor above stderr in the child, before it execs.
///
/// A job lives for minutes. On macOS a pipe or an accepted socket is created first and
/// marked close-on-exec second (there is no `pipe2`/`accept4`), so a fork landing between
/// the two hands the child a descriptor that belongs to something else entirely: another
/// `Command::output()` in this app, or a hook's connection. Whoever is reading that pipe
/// then waits for EOF until the JOB exits. Measured: one run in twelve of the shim tests,
/// where a `conduit run --bg` call "took" as long as an unrelated job's `sleep 3`. In the
/// app the reader would be a `git` call, stalled for the length of a build.
///
/// Short-lived children have always had this race and nobody noticed, because the stray
/// descriptor closed again in milliseconds.
#[cfg(unix)]
fn close_inherited_fds() {
    // SAFETY: getrlimit writes one struct we own; close on a number that is not an open
    // descriptor fails with EBADF and changes nothing.
    unsafe {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        let max = if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            // An "unlimited" soft limit is not a number of descriptors to walk.
            limit.rlim_cur.min(65_536) as libc::c_int
        } else {
            1024
        };
        for fd in 3..max {
            libc::close(fd);
        }
    }
}

#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("cmd.exe");
    // raw_arg: cmd parses its own command line, and std's quoting is the MSVCRT kind it
    // does not understand (the same trap as the spawn script in pty.rs).
    cmd.raw_arg("/D /S /C").raw_arg(format!("\"{command}\""));
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(unix)]
fn exit_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    // A process ended by a signal has no code; the shell convention is 128 + the signal.
    status
        .code()
        .or_else(|| status.signal().map(|s| 128 + s))
        .unwrap_or(-1)
}

#[cfg(windows)]
fn exit_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(-1)
}

/// Ends a process and its descendants. Best effort: a process already gone is fine.
#[cfg(unix)]
fn kill_tree(pid: u32) {
    // The job is its own process group (see `shell_command`), so the group id is the pid.
    // `kill` the program rather than a libc call: no new dependency for one signal.
    let _ = Command::new("/bin/kill")
        .args(["-TERM", "--", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    });
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// One `/job` request body.
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Op {
    Run(RunSpec),
    Wait {
        id: String,
        #[serde(default)]
        timeout: Option<u64>,
    },
    Read {
        id: String,
        #[serde(default)]
        lines: Option<usize>,
    },
    List,
    Kill {
        id: String,
    },
}

/// Runs one request and answers the text the shim prints or parses.
///
/// - `run`: the new job's id
/// - `wait`: `exited <code>` or `running`
/// - `read`: the output
/// - `list`: one job per line, tab-separated: id, state, exit code (or `-`), name, command
/// - `kill`: `ok`
pub fn dispatch(jobs: &Arc<Jobs>, body: &str) -> Result<String, JobError> {
    let op: Op = serde_json::from_str(body).map_err(|e| bad(format!("bad request: {e}")))?;
    match op {
        Op::Run(spec) => jobs.run(spec).map(|j| j.id),
        Op::Wait { id, timeout } => {
            let secs = timeout.unwrap_or(DEFAULT_WAIT_SECS).clamp(1, MAX_WAIT_SECS);
            let job = jobs.wait(&id, Duration::from_secs(secs))?;
            Ok(match job.exit_code {
                Some(code) => format!("exited {code}"),
                None => "running".into(),
            })
        }
        Op::Read { id, lines } => jobs.read(&id, lines.unwrap_or(DEFAULT_READ_LINES)),
        Op::List => Ok(jobs
            .list()
            .iter()
            .map(|j| {
                let state = if j.running { "running" } else { "exited" };
                let code = j.exit_code.map_or("-".to_string(), |c| c.to_string());
                // One line per job: a newline or tab in the command would break the table.
                let flat = |s: &str| s.replace(['\n', '\r', '\t'], " ");
                format!(
                    "{}\t{state}\t{code}\t{}\t{}\n",
                    j.id,
                    flat(&j.name),
                    flat(&j.command)
                )
            })
            .collect()),
        Op::Kill { id } => jobs.kill(&id).map(|()| "ok".into()),
    }
}

/// Handle one `/job`. Authenticated exactly as `/open` is: Origin refused first, then the
/// per-boot token. Call it on its own thread -- `wait` blocks.
pub fn handle_job(mut request: Request, expected: &str, jobs: &Arc<Jobs>) {
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|h| {
            (
                h.field.as_str().as_str().to_string(),
                h.value.as_str().to_string(),
            )
        })
        .collect();
    if let Err(reject) = crate::cli_open::authenticate(&headers, expected) {
        let _ = request.respond(Response::empty(reject.status()));
        return;
    }
    let mut raw = Vec::new();
    let _ = request.as_reader().take(MAX_BODY).read_to_end(&mut raw);
    let body = String::from_utf8(raw).unwrap_or_default();
    let response = match dispatch(jobs, &body) {
        Ok(text) => Response::from_string(text),
        Err(e) => Response::from_string(e.message()).with_status_code(e.status()),
    };
    let _ = request.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cwd() -> String {
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    fn spec(command: &str) -> RunSpec {
        RunSpec {
            command: command.into(),
            cwd: cwd(),
            ..Default::default()
        }
    }

    const LONG: Duration = Duration::from_secs(20);

    #[test]
    fn the_tail_keeps_the_end_and_counts_what_it_dropped() {
        let mut t = Tail::default();
        t.push(&vec![b'a'; OUTPUT_CAP]);
        t.push(b"\nlast line\n");
        assert_eq!(t.bytes.len(), OUTPUT_CAP);
        assert_eq!(t.dropped, 11);
        assert_eq!(t.last_lines(1), "last line\n");
    }

    #[test]
    fn last_lines_counts_lines_with_or_without_a_final_newline() {
        let mut t = Tail::default();
        t.push(b"one\ntwo\nthree\n");
        assert_eq!(t.last_lines(2), "two\nthree\n");
        assert_eq!(t.last_lines(99), "one\ntwo\nthree\n");
        let mut t = Tail::default();
        t.push(b"one\ntwo");
        assert_eq!(t.last_lines(1), "two\n");
        assert_eq!(Tail::default().last_lines(5), "");
    }

    #[test]
    fn a_job_is_named_after_its_program_unless_told_otherwise() {
        assert_eq!(display_name(None, "cargo test --lib"), "cargo");
        assert_eq!(display_name(None, "/usr/local/bin/pnpm build"), "pnpm");
        assert_eq!(display_name(Some("  "), "make"), "make");
        assert_eq!(display_name(Some("release build"), "make"), "release build");
        assert_eq!(display_name(Some("a\u{1b}[31mb"), "x"), "a[31mb");
        assert_eq!(
            display_name(Some(&"n".repeat(200)), "x").len(),
            MAX_NAME_CHARS
        );
    }

    #[test]
    fn bad_requests_are_refused_before_anything_starts() {
        let jobs = Arc::new(Jobs::default());
        assert!(matches!(jobs.run(spec("   ")), Err(JobError::Bad(_))));
        assert!(matches!(
            jobs.run(spec(&"x".repeat(MAX_COMMAND_BYTES + 1))),
            Err(JobError::Bad(_))
        ));
        let mut relative = spec("true");
        relative.cwd = "somewhere".into();
        assert!(matches!(jobs.run(relative), Err(JobError::Bad(_))));
        let mut missing = spec("true");
        missing.cwd = format!("{}/no-such-dir-{}", cwd(), uuid::Uuid::new_v4().simple());
        assert!(matches!(jobs.run(missing), Err(JobError::Bad(_))));
        assert!(jobs.list().is_empty());
        assert_eq!(
            jobs.wait("j9", Duration::from_millis(10)),
            Err(JobError::NotFound)
        );
        assert_eq!(jobs.read("j9", 5), Err(JobError::NotFound));
        assert_eq!(jobs.kill("j9"), Err(JobError::NotFound));
    }

    #[cfg(unix)]
    mod running {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[test]
        fn a_job_runs_and_its_output_and_exit_code_come_back() {
            let jobs = Arc::new(Jobs::default());
            let job = jobs.run(spec("echo out; echo err 1>&2; exit 3")).unwrap();
            assert_eq!(job.id, "j1");
            assert!(job.running);
            let done = jobs.wait(&job.id, LONG).unwrap();
            assert_eq!(done.exit_code, Some(3));
            assert!(!done.running && !done.killed);
            assert!(done.ended_ms.is_some());
            let text = jobs.read(&job.id, 50).unwrap();
            assert!(text.contains("out") && text.contains("err"), "{text:?}");
        }

        #[test]
        fn run_returns_at_once_and_wait_times_out_while_it_runs() {
            let jobs = Arc::new(Jobs::default());
            let started = std::time::Instant::now();
            let job = jobs.run(spec("sleep 30")).unwrap();
            assert!(started.elapsed() < Duration::from_secs(2));
            let still = jobs.wait(&job.id, Duration::from_millis(200)).unwrap();
            assert!(still.running && still.exit_code.is_none());
            jobs.kill(&job.id).unwrap();
            let done = jobs.wait(&job.id, LONG).unwrap();
            assert!(!done.running && done.killed);
            // SIGTERM, reported the way a shell would.
            assert_eq!(done.exit_code, Some(128 + 15));
        }

        #[test]
        fn kill_ends_the_whole_pipeline_not_just_the_shell() {
            let jobs = Arc::new(Jobs::default());
            let marker = format!("conduit-job-test-{}", uuid::Uuid::new_v4().simple());
            // A grandchild that would outlive a kill of the shell alone.
            let job = jobs
                .run(spec(&format!("(sleep 300; echo {marker}) | cat")))
                .unwrap();
            std::thread::sleep(Duration::from_millis(300));
            jobs.kill(&job.id).unwrap();
            jobs.wait(&job.id, LONG).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            let ps = Command::new("ps")
                .args(["-axo", "command"])
                .output()
                .unwrap();
            let listing = String::from_utf8_lossy(&ps.stdout);
            assert!(
                !listing.lines().any(|l| l.contains(&marker)),
                "a process from the killed job is still running"
            );
        }

        #[test]
        fn the_callers_path_and_directory_are_what_the_command_sees() {
            let jobs = Arc::new(Jobs::default());
            let dir = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("conduit-job-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).unwrap();
            let job = jobs
                .run(RunSpec {
                    command: "pwd; echo \"$PATH\"; echo \"$CONDUIT_JOB_ID\"".into(),
                    cwd: dir.to_string_lossy().into_owned(),
                    path: Some("/caller/bin:/usr/bin:/bin".into()),
                    name: Some("env".into()),
                    session: Some("s-1".into()),
                })
                .unwrap();
            assert_eq!(job.name, "env");
            assert_eq!(job.owner.as_deref(), Some("s-1"));
            jobs.wait(&job.id, LONG).unwrap();
            let text = jobs.read(&job.id, 10).unwrap();
            let lines: Vec<&str> = text.lines().collect();
            assert_eq!(lines[0], dir.to_string_lossy());
            assert_eq!(lines[1], "/caller/bin:/usr/bin:/bin");
            assert_eq!(lines[2], job.id);
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// The descriptor leak `close_inherited_fds` exists for, made deterministic: a
        /// pipe deliberately left WITHOUT close-on-exec stands in for one caught mid-race.
        #[test]
        fn a_job_does_not_hold_descriptors_it_inherited() {
            let mut fds = [0 as libc::c_int; 2];
            assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
            let (read_end, write_end) = (fds[0], fds[1]);
            let jobs = Arc::new(Jobs::default());
            let job = jobs.run(spec("sleep 30")).unwrap();
            // Our own copy of the write end goes; if the job kept one, the read below
            // would block until its `sleep 30` ended.
            unsafe { libc::close(write_end) };
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut byte = [0u8; 1];
                let n = unsafe { libc::read(read_end, byte.as_mut_ptr().cast(), 1) };
                let _ = tx.send(n);
            });
            let got = rx.recv_timeout(Duration::from_secs(5));
            jobs.kill(&job.id).unwrap();
            assert_eq!(
                got,
                Ok(0),
                "the job inherited the pipe and is holding it open"
            );
            unsafe { libc::close(read_end) };
        }

        #[test]
        fn a_session_with_a_running_job_is_busy_until_it_ends() {
            let jobs = Arc::new(Jobs::default());
            let mut s = spec("sleep 30");
            s.session = Some("s-1".into());
            let job = jobs.run(s).unwrap();
            let mut quick = spec("true");
            quick.session = Some("s-2".into());
            let done = jobs.run(quick).unwrap();
            jobs.wait(&done.id, LONG).unwrap();
            assert_eq!(jobs.busy_owners(), HashSet::from(["s-1".to_string()]));
            // Destroying the session ends its job.
            jobs.kill_owned_by("s-1");
            jobs.wait(&job.id, LONG).unwrap();
            assert!(jobs.busy_owners().is_empty());
        }

        #[test]
        fn the_running_cap_holds_and_frees_up_when_one_ends() {
            let jobs = Arc::new(Jobs::default());
            let ids: Vec<String> = (0..MAX_RUNNING)
                .map(|_| jobs.run(spec("sleep 30")).unwrap().id)
                .collect();
            assert_eq!(jobs.run(spec("true")), Err(JobError::Busy));
            jobs.kill(&ids[0]).unwrap();
            jobs.wait(&ids[0], LONG).unwrap();
            assert!(jobs.run(spec("true")).is_ok());
            jobs.kill_all();
            for id in &ids {
                jobs.wait(id, LONG).unwrap();
            }
        }

        #[test]
        fn finished_jobs_are_pruned_oldest_first_and_ids_never_repeat() {
            let jobs = Arc::new(Jobs::default());
            for _ in 0..(MAX_KEPT + 3) {
                let job = jobs.run(spec("true")).unwrap();
                jobs.wait(&job.id, LONG).unwrap();
            }
            let list = jobs.list();
            assert_eq!(list.len(), MAX_KEPT);
            assert_eq!(list[0].id, "j4");
            assert_eq!(list.last().unwrap().id, format!("j{}", MAX_KEPT + 3));
        }

        #[test]
        fn the_notifier_fires_when_a_job_starts_and_when_it_ends() {
            let jobs = Arc::new(Jobs::default());
            let count = Arc::new(AtomicUsize::new(0));
            let seen = count.clone();
            jobs.set_notifier(move || {
                seen.fetch_add(1, Ordering::SeqCst);
            });
            let job = jobs.run(spec("true")).unwrap();
            jobs.wait(&job.id, LONG).unwrap();
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(count.load(Ordering::SeqCst), 2);
        }

        #[test]
        fn the_route_speaks_plain_text() {
            let jobs = Arc::new(Jobs::default());
            let run = serde_json::json!({"op": "run", "command": "echo hi; exit 2", "cwd": cwd(), "name": "a\tb"});
            let id = dispatch(&jobs, &run.to_string()).unwrap();
            assert_eq!(id, "j1");
            let wait = dispatch(&jobs, r#"{"op":"wait","id":"j1","timeout":20}"#).unwrap();
            assert_eq!(wait, "exited 2");
            assert_eq!(
                dispatch(&jobs, r#"{"op":"read","id":"j1"}"#).unwrap(),
                "hi\n"
            );
            let list = dispatch(&jobs, r#"{"op":"list"}"#).unwrap();
            // The tab in the name is a control character and was dropped when it was named.
            assert_eq!(list, "j1\texited\t2\tab\techo hi; exit 2\n");
            assert_eq!(dispatch(&jobs, r#"{"op":"kill","id":"j1"}"#).unwrap(), "ok");
            assert_eq!(
                dispatch(&jobs, r#"{"op":"wait","id":"nope"}"#),
                Err(JobError::NotFound)
            );
            assert!(matches!(dispatch(&jobs, "not json"), Err(JobError::Bad(_))));
            assert!(matches!(
                dispatch(&jobs, r#"{"op":"explode"}"#),
                Err(JobError::Bad(_))
            ));
        }
    }
}
