//! End-to-end for the CLI launcher's own half: the REAL generated shim, executed as a
//! process, against the REAL handler over a REAL socket. Only the sink is a channel
//! instead of a Tauri emit — everything the shim touches is production code.
//!
//! Hermetic: the child gets HOME/APPDATA/XDG_DATA_HOME pointed at a temp tree and its
//! own CONDUIT_DATA_DIR_NAME, so nothing is read from or written to the developer's
//! actual Conduit data directory.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;

use conduit_tauri_lib::cli_open::{self, OpenPayload};
use conduit_tauri_lib::cli_shim;

struct Fixture {
    home: PathBuf,
    data_dir: PathBuf,
    bin: PathBuf,
    token: String,
}

fn fixture() -> Fixture {
    let home = std::env::temp_dir().join(format!("conduit-e2e-{}", uuid::Uuid::new_v4()));
    let data_dir = if cfg!(windows) {
        home.join("Roaming").join("ConduitTauri-e2e")
    } else if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("ConduitTauri-e2e")
    } else {
        home.join(".local").join("share").join("ConduitTauri-e2e")
    };
    std::fs::create_dir_all(&data_dir).unwrap();
    let bin = home.join("bin");
    cli_shim::install_in(&bin).unwrap();
    let token = cli_open::write_token_file_in(&data_dir);
    Fixture {
        home,
        data_dir,
        bin,
        token,
    }
}

impl Fixture {
    /// Publish a port the way `hooks::write_endpoint_file` does — one sourced KEY=value.
    fn publish_port(&self, port: u16) {
        std::fs::write(
            self.data_dir.join("hook-endpoint.sh"),
            format!("CONDUIT_HOOK_PORT={port}\n"),
        )
        .unwrap();
    }

    fn shim(&self) -> PathBuf {
        self.bin.join(cli_shim::shim_file_name())
    }

    fn command(&self) -> Command {
        let mut c = Command::new(self.shim());
        c.env("HOME", &self.home)
            .env("APPDATA", self.home.join("Roaming"))
            .env("XDG_DATA_HOME", self.home.join(".local").join("share"))
            .env("CONDUIT_DATA_DIR_NAME", "ConduitTauri-e2e");
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command().args(args).output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.home).ok();
    }
}

/// Serve `/open` forever on an ephemeral port, reporting each accepted request.
fn serve(token: String) -> (u16, Receiver<OpenPayload>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let (tx, rx): (Sender<OpenPayload>, Receiver<OpenPayload>) = channel();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let tx = tx.clone();
            cli_open::handle_open(req, &token, move |o| {
                let _ = tx.send(o);
            });
        }
    });
    (port, rx)
}

fn recv(rx: &Receiver<OpenPayload>) -> OpenPayload {
    rx.recv_timeout(Duration::from_secs(10))
        .expect("no request reached the handler")
}

fn silent(rx: &Receiver<OpenPayload>) {
    assert!(
        rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "the handler acted on a request it should have refused"
    );
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn opens_the_current_directory() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let project = f.home.join("myproject");
    std::fs::create_dir_all(&project).unwrap();
    let out = f.command().current_dir(&project).arg(".").output().unwrap();
    assert!(out.status.success(), "stderr: {}", stderr(&out));

    let got = recv(&rx);
    assert!(
        Path::new(&got.path).ends_with("myproject"),
        "got {}",
        got.path
    );
    assert_eq!(got.agent, None);
}

#[test]
fn a_bare_invocation_defaults_to_the_current_directory() {
    // Only where Conduit Code is not installed: with it, no argument is ITS command (see
    // `shared_name` below). The PATH here is the system's own, so a `conduit-code` the
    // developer installed is not found.
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let project = f.home.join("bare");
    std::fs::create_dir_all(&project).unwrap();
    let mut cmd = f.command();
    if cfg!(unix) {
        cmd.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    }
    let out = cmd
        .env_remove("CONDUIT_BIN_HANDOFF")
        .current_dir(&project)
        .output()
        .unwrap();
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(Path::new(&recv(&rx).path).ends_with("bare"));
}

#[test]
fn passes_the_agent_through() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("withagent");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap(), "--agent", "claude"]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(recv(&rx).agent.as_deref(), Some("claude"));

    let out = f.run(&[project.to_str().unwrap(), "-a", "agy"]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(recv(&rx).agent.as_deref(), Some("agy"));
}

#[test]
fn a_wrong_token_is_refused_and_the_shim_reports_failure() {
    let f = fixture();
    let (port, rx) = serve("a-different-token".to_string());
    f.publish_port(port);
    let project = f.home.join("p");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap()]);
    assert_eq!(
        out.status.code(),
        Some(1),
        "a 403 must not look like success: {}",
        stderr(&out)
    );
    assert!(
        stderr(&out).contains("refused the CLI token"),
        "stderr: {}",
        stderr(&out)
    );
    // A refusal came from a RUNNING Conduit: never read it as "not running".
    assert!(
        !stderr(&out).contains("no Conduit answering"),
        "stderr: {}",
        stderr(&out)
    );
    silent(&rx);
}

#[test]
fn a_browser_style_request_is_refused_even_with_the_right_token() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let out = Command::new("curl")
        .args([
            "-s",
            "-o",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
            "-w",
            "%{http_code}",
            "-X",
            "POST",
            "-H",
            &format!("X-Conduit-Token: {}", f.token),
            "-H",
            "Origin: https://evil.example",
            "--data",
            r#"{"path":"/tmp/p"}"#,
            &format!("http://127.0.0.1:{port}/open"),
        ])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "403");
    silent(&rx);
}

#[test]
fn a_missing_directory_fails_before_any_request() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let out = f.run(&[f.home.join("does-not-exist").to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("not a directory"),
        "stderr: {}",
        stderr(&out)
    );
    silent(&rx);
}

/// The cold-start guard: with an explicit data dir and nothing listening, the shim must
/// NOT launch the installed app — that is the state.json clobber CLAUDE.md warns about.
#[test]
fn an_explicit_data_dir_with_no_server_fails_instead_of_launching() {
    let f = fixture();
    // No publish_port, so nothing is listening.
    let project = f.home.join("p");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("ConduitTauri-e2e"),
        "stderr: {}",
        stderr(&out)
    );
}

/// A path containing a quote and a backslash must survive JSON encoding intact.
#[cfg(unix)]
#[test]
fn awkward_path_characters_round_trip() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let project = f.home.join(r#"we"ird\dir"#);
    std::fs::create_dir_all(&project).unwrap();
    let out = f.run(&[project.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(recv(&rx).path.ends_with(r#"we"ird\dir"#));
}

#[cfg(unix)]
fn git_init(dir: &Path) {
    let out = Command::new("git")
        .args(["init", "-q"])
        .arg(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "git init: {}", stderr(&out));
}

/// The name carries every character the shim must neither evaluate nor let break its
/// JSON: a double quote, a `$` expansion, a backslash.
#[cfg(unix)]
#[test]
fn shim_forwards_name_worktree_and_prompt_file() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("repo");
    std::fs::create_dir_all(&project).unwrap();
    git_init(&project);
    let brief = f.home.join("brief.md");
    let contents = "Fix \"it\"\n\ttabbed $HOME `x` \\ done\n";
    std::fs::write(&brief, contents).unwrap();

    let name = r#"He said "hi" $HOME \ ok"#;
    let out = f.run(&[
        project.to_str().unwrap(),
        "--agent",
        "claude",
        "--worktree",
        "fix-a",
        "--name",
        name,
        "--prompt-file",
        brief.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let got = recv(&rx);
    assert_eq!(got.agent.as_deref(), Some("claude"));
    assert_eq!(got.name.as_deref(), Some(name));
    assert_eq!(got.worktree.as_deref(), Some("fix-a"));
    assert_eq!(got.prompt.as_deref(), Some(contents));
}

/// A relative prompt file is resolved against the caller's directory, and a newline
/// and a tab in the name survive the JSON encoding.
#[cfg(unix)]
#[test]
fn shim_resolves_a_relative_prompt_file_and_escapes_control_characters() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("rel");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("brief.md"), "relative brief").unwrap();

    let out = f
        .command()
        .current_dir(&project)
        .args([
            ".",
            "--agent",
            "claude",
            "--name",
            "two\nlines\tand $(echo x)",
            "--prompt-file",
            "brief.md",
        ])
        .output()
        .unwrap();
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let got = recv(&rx);
    assert_eq!(got.name.as_deref(), Some("two\nlines\tand $(echo x)"));
    assert_eq!(got.prompt.as_deref(), Some("relative brief"));
}

#[test]
fn a_missing_prompt_file_fails_before_any_request() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("p");
    std::fs::create_dir_all(&project).unwrap();

    let missing = f.home.join("nope.md");
    let out = f.run(&[
        project.to_str().unwrap(),
        "--agent",
        "claude",
        "--prompt-file",
        missing.to_str().unwrap(),
    ]);
    assert_eq!(out.status.code(), Some(1), "stderr: {}", stderr(&out));
    assert!(
        stderr(&out).contains("not a file"),
        "stderr: {}",
        stderr(&out)
    );
    silent(&rx);
}

#[test]
fn shim_drops_worktree_outside_git() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("plain");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[
        project.to_str().unwrap(),
        "--agent",
        "claude",
        "--worktree",
        "fix-a",
    ]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(
        stderr(&out).contains("is not a git work tree"),
        "stderr: {}",
        stderr(&out)
    );
    let got = recv(&rx);
    assert_eq!(got.agent.as_deref(), Some("claude"));
    assert_eq!(got.worktree, None);
}

#[test]
fn options_without_agent_exit_2() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("p");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap(), "--name", "x"]);
    assert_eq!(out.status.code(), Some(2), "stderr: {}", stderr(&out));
    // v1 also exited 2 here, as an unknown option. The v2 guard prints the v2 usage
    // line, which names --worktree, and no unknown-option complaint.
    assert!(stderr(&out).contains("usage"), "stderr: {}", stderr(&out));
    assert!(
        stderr(&out).contains("--worktree"),
        "stderr: {}",
        stderr(&out)
    );
    assert!(
        !stderr(&out).contains("unknown option"),
        "stderr: {}",
        stderr(&out)
    );
    silent(&rx);
}

/// The shim checks the slug itself, so the common mistake is a usage error before any
/// request, not a 400 (or worse, a cold start).
#[test]
fn a_bad_worktree_slug_exits_2_before_any_request() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("p");
    std::fs::create_dir_all(&project).unwrap();

    for bad in [
        "Fix-A",
        "fix_a",
        "-fix",
        "fix-",
        "fix--a",
        "../x",
        &"a".repeat(61),
    ] {
        let started = std::time::Instant::now();
        let out = f.run(&[
            project.to_str().unwrap(),
            "--agent",
            "claude",
            "--worktree",
            bad,
        ]);
        assert_eq!(out.status.code(), Some(2), "{bad}: {}", stderr(&out));
        assert!(
            stderr(&out).contains("invalid --worktree slug"),
            "{bad}: {}",
            stderr(&out)
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{bad}: not quick"
        );
    }
    silent(&rx);

    // The longest legal slug still goes through.
    let ok = "a".repeat(60);
    let out = f.run(&[
        project.to_str().unwrap(),
        "--agent",
        "claude",
        "--worktree",
        &ok,
    ]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(recv(&rx).path.ends_with("p"));
}

/// A 400 from a running Conduit is reported as a refusal at once, with exit 2: never
/// retried as a cold start that ends in "did not come up in time" fifteen seconds later.
#[test]
fn a_400_from_the_app_exits_2_without_a_cold_start() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("p");
    std::fs::create_dir_all(&project).unwrap();
    // The shim only checks that the prompt file exists; the size cap is Conduit's.
    let big = f.home.join("big.md");
    std::fs::write(&big, vec![b'a'; 65_537]).unwrap();

    let started = std::time::Instant::now();
    let out = f.run(&[
        project.to_str().unwrap(),
        "--agent",
        "claude",
        "--prompt-file",
        big.to_str().unwrap(),
    ]);
    assert_eq!(out.status.code(), Some(2), "stderr: {}", stderr(&out));
    assert!(
        stderr(&out).contains("Conduit rejected the request"),
        "stderr: {}",
        stderr(&out)
    );
    assert!(
        !stderr(&out).contains("no Conduit answering") && !stderr(&out).contains("in time"),
        "a refusal must not fall into the cold start: {}",
        stderr(&out)
    );
    assert!(started.elapsed() < Duration::from_secs(5), "not quick");
    silent(&rx);
}

/// Windows: a `)` or `&` in the path used to close the shim's `( ... )` block early, so
/// `conduit "D:\app (v2)"` failed with "\app was unexpected at this time." even when the
/// directory existed.
#[cfg(windows)]
#[test]
fn a_path_with_parentheses_and_an_ampersand_opens() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("app (v2) & co");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(recv(&rx).path.ends_with("app (v2) & co"));

    let missing = f.home.join("gone (v2) & co");
    let out = f.run(&[missing.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("not a directory"),
        "stderr: {}",
        stderr(&out)
    );
    silent(&rx);
}

/// Windows: under a legacy console codepage (437 here, the US default) cmd.exe hands the
/// shim its arguments, and writes its body, in that codepage, so a non-ASCII name or path
/// was not UTF-8 and was refused as a 400. The shim now reports the codepage and Conduit
/// decodes with it.
#[cfg(windows)]
#[test]
fn a_non_ascii_name_and_path_survive_an_oem_console_codepage() {
    use std::os::windows::process::CommandExt;
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("Café projekt");
    std::fs::create_dir_all(&project).unwrap();

    let c = f.command();
    let shim = c.get_program().to_owned();
    let mut cmd = Command::new("cmd.exe");
    // The shim runs under a cmd.exe that switches the codepage first, with the fixture's
    // hermetic environment carried across. CREATE_NO_WINDOW gives it its OWN hidden
    // console, so `chcp 437` cannot leak into the harness's console (and the developer's
    // terminal) the way it would on a shared one; `/D` skips any AutoRun command.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.envs(c.get_envs().filter_map(|(k, v)| v.map(|v| (k, v))));
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.args(["/D", "/C"]).raw_arg(format!(
        "\"chcp 437 >nul & \"{}\" \"{}\" --agent claude --name \"Crème brûlée\"\"",
        shim.to_string_lossy(),
        project.display()
    ));
    let out = cmd.output().unwrap();
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let got = recv(&rx);
    assert!(got.path.ends_with("Café projekt"), "got {}", got.path);
    assert_eq!(got.name.as_deref(), Some("Crème brûlée"));
}

// ---- one name, two products: the first argument decides who answers ----
//
// Conduit Code (npm `@conduitcode/cli`) installs a `conduit` too. These run the real shim
// with a stand-in `conduit-code` on PATH that records what it was handed.

#[cfg(unix)]
mod shared_name {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A PATH with the system tools the shim needs and nothing of the developer's own
    /// (a real `conduit-code` is installed on some machines that run these).
    const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

    /// Puts a fake `conduit-code` in `<home>/code-bin` that writes its arguments (one per
    /// line) and whether the hand-off mark was set, then exits 7.
    fn fake_code(f: &Fixture) -> (String, PathBuf) {
        let dir = f.home.join("code-bin");
        std::fs::create_dir_all(&dir).unwrap();
        let log = f.home.join("code.log");
        let bin = dir.join("conduit-code");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\n{{ echo \"handoff=${{CONDUIT_BIN_HANDOFF:-}}\"; for a in \"$@\"; do echo \"arg=$a\"; done; }} > '{}'\nexit 7\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (format!("{}:{SYSTEM_PATH}", dir.display()), log)
    }

    fn run_with(f: &Fixture, path: &str, cwd: &Path, args: &[&str]) -> Output {
        f.command()
            .env("PATH", path)
            .env_remove("CONDUIT_BIN_HANDOFF")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap()
    }

    #[test]
    fn conduit_code_commands_are_handed_over_with_their_arguments_and_exit_code() {
        let f = fixture();
        let (port, rx) = serve(f.token.clone());
        f.publish_port(port);
        let (path, log) = fake_code(&f);

        for (args, expect) in [
            (vec![], "handoff=1\n"),
            (vec!["login"], "handoff=1\narg=login\n"),
            (
                vec!["--model", "zai/glm 5", "--resume", "abc"],
                "handoff=1\narg=--model\narg=zai/glm 5\narg=--resume\narg=abc\n",
            ),
            (vec!["-h"], "handoff=1\narg=-h\n"),
            // Not a verb, not a path, not a directory here: Conduit Code reports it.
            (vec!["frobnicate"], "handoff=1\narg=frobnicate\n"),
        ] {
            let _ = std::fs::remove_file(&log);
            let out = run_with(&f, &path, &f.home, &args);
            assert_eq!(out.status.code(), Some(7), "{args:?}: {}", stderr(&out));
            assert_eq!(std::fs::read_to_string(&log).unwrap(), expect, "{args:?}");
        }
        silent(&rx);
    }

    #[test]
    fn the_apps_own_commands_never_reach_conduit_code() {
        let f = fixture();
        let (port, rx) = serve(f.token.clone());
        f.publish_port(port);
        let (path, log) = fake_code(&f);
        let project = f.home.join("proj");
        std::fs::create_dir_all(project.join("run")).unwrap();

        // A path in every agreed spelling, a bare directory name, and flags-first.
        for args in [
            vec!["."],
            vec!["./run"],
            vec!["run/.."],
            vec![project.to_str().unwrap()],
            vec!["--agent", "claude", "."],
        ] {
            let out = run_with(&f, &path, &project, &args);
            assert!(out.status.success(), "{args:?}: {}", stderr(&out));
            let _ = recv(&rx);
        }
        // The manual, and a verb that is also a folder name here (the verb wins).
        let out = run_with(&f, &path, &project, &["--skill"]);
        assert!(String::from_utf8_lossy(&out.stdout).contains("conduit run --bg"));
        // (`report` with a bad state is refused before anything is sent.)
        let out = run_with(&f, &path, &project, &["report", "--state", "bogus"]);
        assert_eq!(out.status.code(), Some(2), "{}", stderr(&out));
        assert!(!log.exists(), "an app command was handed to Conduit Code");
    }

    #[test]
    fn without_conduit_code_nothing_is_handed_over() {
        let f = fixture();
        let (port, rx) = serve(f.token.clone());
        f.publish_port(port);
        let project = f.home.join("solo");
        std::fs::create_dir_all(&project).unwrap();

        // No argument opens this folder, as the command always did.
        let out = run_with(&f, SYSTEM_PATH, &project, &[]);
        assert!(out.status.success(), "{}", stderr(&out));
        assert!(recv(&rx).path.ends_with("solo"));

        let out = run_with(&f, SYSTEM_PATH, &project, &["login"]);
        assert_eq!(out.status.code(), Some(127));
        assert!(
            stderr(&out).contains("npm i -g @conduitcode/cli"),
            "{}",
            stderr(&out)
        );

        let out = run_with(&f, SYSTEM_PATH, &project, &["--help"]);
        assert_eq!(out.status.code(), Some(2));
        assert!(
            stderr(&out).contains("usage: conduit <path>"),
            "{}",
            stderr(&out)
        );
        silent(&rx);
    }

    #[test]
    fn a_call_that_was_handed_to_us_is_answered_here_and_never_handed_back() {
        let f = fixture();
        let (port, rx) = serve(f.token.clone());
        f.publish_port(port);
        let (path, log) = fake_code(&f);

        let out = f
            .command()
            .env("PATH", &path)
            .env("CONDUIT_BIN_HANDOFF", "1")
            .current_dir(&f.home)
            .args(["login"])
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(stderr(&out).contains("not a directory"), "{}", stderr(&out));
        assert!(!log.exists(), "the call went round again");
        silent(&rx);
    }
}
