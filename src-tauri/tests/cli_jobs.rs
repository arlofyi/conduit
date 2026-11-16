//! End-to-end for `conduit run` and friends: the REAL generated shim, executed as a
//! process, against the REAL `/job` handler over a REAL socket, running REAL commands.
//! The only thing missing is the app around the handler.
//!
//! Hermetic in the same way as `cli_open.rs`: the child's HOME and data-dir name point at
//! a temp tree, so nothing touches the developer's own Conduit.
//!
//! POSIX only. The Windows shim refuses these subcommands by name, and one test pins that.

#![cfg(unix)]

use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::Arc;
use std::time::{Duration, Instant};

use conduit_tauri_lib::cli_open;
use conduit_tauri_lib::cli_shim;
use conduit_tauri_lib::jobs::{self, Jobs};

/// One test at a time. Every test here spawns shim processes from THIS process while a
/// server thread in it forks jobs, and on macOS a pipe is created first and marked
/// close-on-exec second. Run in parallel, one test's shim (which can live for seconds)
/// inherits another test's stdout pipe or spawn-status pipe mid-race and holds it open,
/// and the other test's `output()` or `spawn()` then "takes" as long as that shim lives.
/// Measured: 1 run in 12, then 7 in 15 once jobs forked rather than posix_spawned. The
/// app has no such long-lived siblings; this is the harness, so the harness serializes.
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    home: PathBuf,
    data_dir: PathBuf,
    bin: PathBuf,
    work: PathBuf,
    jobs: Arc<Jobs>,
}

fn fixture() -> Fixture {
    // A test that failed while holding the lock must not fail every test after it.
    let serial = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let home = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("conduit-jobs-e2e-{}", uuid::Uuid::new_v4()));
    let data_dir = if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("ConduitTauri-e2e")
    } else {
        home.join(".local").join("share").join("ConduitTauri-e2e")
    };
    std::fs::create_dir_all(&data_dir).unwrap();
    let work = home.join("work dir");
    std::fs::create_dir_all(&work).unwrap();
    let bin = home.join("bin");
    cli_shim::install_in(&bin).unwrap();
    let token = cli_open::write_token_file_in(&data_dir);

    // The route as `hooks.rs` serves it: one thread per request, because `wait` blocks.
    let jobs = Arc::new(Jobs::default());
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let served = jobs.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let token = token.clone();
            let jobs = served.clone();
            std::thread::spawn(move || jobs::handle_job(req, &token, &jobs));
        }
    });
    std::fs::write(
        data_dir.join("hook-endpoint.sh"),
        format!("CONDUIT_HOOK_PORT={port}\n"),
    )
    .unwrap();
    Fixture {
        _serial: serial,
        home,
        data_dir,
        bin,
        work,
        jobs,
    }
}

impl Fixture {
    fn command(&self) -> Command {
        let mut c = Command::new(self.bin.join(cli_shim::shim_file_name()));
        c.env("HOME", &self.home)
            .env("XDG_DATA_HOME", self.home.join(".local").join("share"))
            .env("CONDUIT_DATA_DIR_NAME", "ConduitTauri-e2e")
            .env_remove("CONDUIT_SESSION_ID")
            .current_dir(&self.work);
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command().args(args).output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.jobs.kill_all();
        std::fs::remove_dir_all(&self.home).ok();
    }
}

fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[test]
fn run_prints_the_output_and_exits_with_the_commands_own_code() {
    let f = fixture();
    let o = f.run(&["run", "--", "sh", "-c", "echo hello from the job; exit 7"]);
    assert_eq!(o.status.code(), Some(7), "stderr: {}", err(&o));
    assert_eq!(out(&o), "hello from the job\n");
}

#[test]
fn a_single_argument_is_a_shell_command_as_written() {
    let f = fixture();
    let o = f.run(&["run", "echo one && echo two | tr a-z A-Z"]);
    assert_eq!(o.status.code(), Some(0), "stderr: {}", err(&o));
    assert_eq!(out(&o), "one\nTWO\n");
}

#[test]
fn several_arguments_each_stay_one_word() {
    let f = fixture();
    // A space, a quote, a dollar sign and a glob: none may be re-read by the job's shell.
    let o = f.run(&["run", "--", "printf", "[%s]\n", "a b", "it's", "$HOME", "*"]);
    assert_eq!(o.status.code(), Some(0), "stderr: {}", err(&o));
    assert_eq!(out(&o), "[a b]\n[it's]\n[$HOME]\n[*]\n");
}

#[test]
fn the_job_runs_in_the_callers_directory_with_the_callers_path() {
    let f = fixture();
    let o = f
        .command()
        .env("PATH", "/caller/only:/usr/bin:/bin")
        .args(["run", "pwd; echo \"$PATH\""])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0), "stderr: {}", err(&o));
    let text = out(&o);
    let mut lines = text.lines();
    assert_eq!(lines.next().unwrap(), f.work.to_string_lossy());
    assert_eq!(lines.next().unwrap(), "/caller/only:/usr/bin:/bin");
}

#[test]
fn bg_returns_at_once_and_wait_read_and_jobs_follow_it() {
    let f = fixture();
    let started = Instant::now();
    let o = f.run(&[
        "run",
        "--bg",
        "--name",
        "slow build",
        "sleep 3; echo built; exit 4",
    ]);
    assert_eq!(o.status.code(), Some(0), "stderr: {}", err(&o));
    // Well under the command's own 3 s.
    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "--bg waited for the command"
    );
    let id = out(&o).trim().to_string();
    assert_eq!(id, "j1");

    let listed = out(&f.run(&["jobs"]));
    assert_eq!(
        listed,
        "j1\trunning\t-\tslow build\tsleep 3; echo built; exit 4\n"
    );

    let waited = f.run(&["wait", &id]);
    assert_eq!(waited.status.code(), Some(4), "stderr: {}", err(&waited));
    assert_eq!(out(&waited), "j1 exited 4\n");

    let read = f.run(&["read", &id]);
    assert_eq!(read.status.code(), Some(0));
    assert_eq!(out(&read), "built\n");

    assert!(out(&f.run(&["jobs"])).starts_with("j1\texited\t4\t"));
}

#[test]
fn a_run_that_outlives_its_timeout_says_how_to_follow_it_and_keeps_running() {
    let f = fixture();
    let o = f.run(&["run", "--timeout", "1", "echo started; sleep 30"]);
    assert_eq!(o.status.code(), Some(124));
    assert_eq!(out(&o), "started\n");
    assert!(err(&o).contains("still running as j1"), "{}", err(&o));
    assert!(f.jobs.get("j1").unwrap().running);

    let still = f.run(&["wait", "j1", "--timeout", "1"]);
    assert_eq!(still.status.code(), Some(124));
    assert_eq!(out(&still), "j1 still running\n");

    let killed = f.run(&["kill", "j1"]);
    assert_eq!(killed.status.code(), Some(0), "stderr: {}", err(&killed));
    let done = f.jobs.wait("j1", Duration::from_secs(20)).unwrap();
    assert!(done.killed && !done.running);
}

#[test]
fn read_takes_a_line_count() {
    let f = fixture();
    f.run(&["run", "printf '1\\n2\\n3\\n4\\n'"]);
    let o = f.run(&["read", "j1", "--lines", "2"]);
    assert_eq!(out(&o), "3\n4\n");
}

#[test]
fn the_calling_session_owns_its_job() {
    let f = fixture();
    let o = f
        .command()
        .env("CONDUIT_SESSION_ID", "session-abc")
        .args(["run", "--bg", "sleep 30"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0), "stderr: {}", err(&o));
    assert_eq!(
        f.jobs.get("j1").unwrap().owner.as_deref(),
        Some("session-abc")
    );
    assert!(f.jobs.busy_owners().contains("session-abc"));
}

#[test]
fn an_unknown_job_and_bad_options_are_plain_errors() {
    let f = fixture();
    let o = f.run(&["wait", "j99"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("no such job"), "{}", err(&o));
    assert_eq!(f.run(&["run"]).status.code(), Some(2));
    assert_eq!(
        f.run(&["run", "--timeout", "soon", "true"]).status.code(),
        Some(2)
    );
    assert_eq!(
        f.run(&["read", "j1", "--lines", "many"]).status.code(),
        Some(2)
    );
    assert_eq!(f.run(&["kill"]).status.code(), Some(2));
    assert!(
        f.jobs.list().is_empty(),
        "a refused request started something"
    );
}

#[test]
fn a_wrong_token_is_refused_and_starts_nothing() {
    let f = fixture();
    std::fs::write(f.data_dir.join("cli-token"), "not-the-token\n").unwrap();
    let o = f.run(&["run", "--bg", "touch should-not-exist"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("refused the CLI token"), "{}", err(&o));
    std::thread::sleep(Duration::from_millis(300));
    assert!(f.jobs.list().is_empty());
    assert!(!f.work.join("should-not-exist").exists());
}

#[test]
fn a_browser_origin_is_refused_even_with_the_right_token() {
    let f = fixture();
    let port = std::fs::read_to_string(f.data_dir.join("hook-endpoint.sh"))
        .unwrap()
        .trim()
        .trim_start_matches("CONDUIT_HOOK_PORT=")
        .to_string();
    let token = std::fs::read_to_string(f.data_dir.join("cli-token")).unwrap();
    let body = format!(
        r#"{{"op":"run","command":"touch should-not-exist","cwd":"{}"}}"#,
        f.work.to_string_lossy()
    );
    let o = Command::new("curl")
        .args([
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "-m",
            "5",
            "-X",
            "POST",
        ])
        .args(["-H", &format!("X-Conduit-Token: {}", token.trim())])
        .args(["-H", "Origin: http://evil.example"])
        .args(["--data", &body])
        .arg(format!("http://127.0.0.1:{port}/job"))
        .output()
        .unwrap();
    assert_eq!(out(&o), "403");
    std::thread::sleep(Duration::from_millis(300));
    assert!(f.jobs.list().is_empty());
}

#[test]
fn with_no_conduit_running_a_job_fails_instead_of_launching_the_app() {
    let f = fixture();
    std::fs::remove_file(f.data_dir.join("hook-endpoint.sh")).unwrap();
    let o = f.run(&["run", "true"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("not running"), "{}", err(&o));
}

#[test]
fn a_folder_named_like_a_subcommand_is_still_openable_by_path() {
    // `conduit run` is the subcommand; `conduit ./run` is a directory.
    let f = fixture();
    std::fs::create_dir_all(f.work.join("run")).unwrap();
    let o = f.run(&["./run"]);
    // This fixture serves only `/job`, which answers the open request's body with a 400;
    // what matters is that the OPEN path produced the message, not the job parser.
    assert!(
        err(&o).contains("Conduit rejected the request"),
        "{}",
        err(&o)
    );
}

#[test]
fn the_windows_shim_refuses_the_job_subcommands_by_name() {
    let cmd = cli_shim::shim_cmd();
    for sub in ["run", "wait", "read", "jobs", "kill"] {
        assert!(
            cmd.contains(&format!("if /i \"%~1\"==\"{sub}\" goto no_jobs")),
            "conduit.cmd would try to open a folder called {sub}"
        );
    }
    assert!(cmd.contains(":no_jobs"));
}
