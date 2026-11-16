//! `conduit report`: the REAL generated shim, run as a process, posting to a real socket.
//! The server here only records what arrived; what Conduit does with a report is
//! `report.rs`'s unit tests, and the window's reaction is `e2e/agent-report.e2e.ts`.

#![cfg(unix)]

use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

use conduit_tauri_lib::cli_shim;

struct Fixture {
    home: PathBuf,
    bin: PathBuf,
    port: u16,
    seen: Receiver<(String, String)>,
}

fn fixture() -> Fixture {
    let home = std::env::temp_dir().join(format!("conduit-report-e2e-{}", uuid::Uuid::new_v4()));
    let data_dir = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/ConduitTauri-e2e")
    } else {
        home.join(".local/share/ConduitTauri-e2e")
    };
    std::fs::create_dir_all(&data_dir).unwrap();
    let bin = home.join("bin");
    cli_shim::install_in(&bin).unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    std::fs::write(
        data_dir.join("hook-endpoint.sh"),
        format!("CONDUIT_HOOK_PORT={port}\n"),
    )
    .unwrap();
    let (tx, seen) = channel();
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let _ = tx.send((req.url().to_string(), body));
            let _ = req.respond(tiny_http::Response::from_string("ok"));
        }
    });
    Fixture {
        home,
        bin,
        port,
        seen,
    }
}

impl Fixture {
    fn command(&self) -> Command {
        let mut c = Command::new(self.bin.join(cli_shim::shim_file_name()));
        c.env("HOME", &self.home)
            .env("XDG_DATA_HOME", self.home.join(".local/share"))
            .env("CONDUIT_DATA_DIR_NAME", "ConduitTauri-e2e")
            .env_remove("CONDUIT_SESSION_ID")
            .env_remove("CONDUIT_HOOK_PORT");
        c
    }

    fn report(&self, session: Option<&str>, args: &[&str]) -> Output {
        let mut c = self.command();
        if let Some(s) = session {
            c.env("CONDUIT_SESSION_ID", s);
        }
        c.arg("report").args(args).output().unwrap()
    }

    fn arrived(&self) -> (String, serde_json::Value) {
        let (url, body) = self
            .seen
            .recv_timeout(Duration::from_secs(10))
            .expect("no report reached the server");
        (url, serde_json::from_str(&body).expect("the body is JSON"))
    }

    fn nothing_arrived(&self) {
        assert!(
            self.seen.recv_timeout(Duration::from_millis(400)).is_err(),
            "a report was posted that should not have been"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.home).ok();
    }
}

#[test]
fn a_report_reaches_the_hook_endpoint_as_the_sessions_own() {
    let f = fixture();
    let o = f.report(Some("sess-1"), &["--state", "working"]);
    assert_eq!(o.status.code(), Some(0));
    let (url, body) = f.arrived();
    assert_eq!(url, "/hook?session=sess-1&event=report");
    assert_eq!(body, serde_json::json!({"state": "working"}));
}

#[test]
fn kind_message_and_seq_ride_along_and_the_message_is_escaped() {
    let f = fixture();
    let o = f.report(
        Some("sess-1"),
        &[
            "--state",
            "blocked",
            "--kind",
            "permission",
            "--message",
            "allow \"rm -rf\"?\nreally",
            "--seq",
            "1731800000",
        ],
    );
    assert_eq!(o.status.code(), Some(0));
    let (_, body) = f.arrived();
    assert_eq!(
        body,
        serde_json::json!({
            "state": "blocked",
            "kind": "permission",
            "message": "allow \"rm -rf\"?\nreally",
            "seq": 1731800000u64,
        })
    );
}

#[test]
fn outside_a_conduit_session_it_does_nothing_and_succeeds() {
    let f = fixture();
    let o = f.report(None, &["--state", "working"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(o.stderr.is_empty());
    f.nothing_arrived();
}

#[test]
fn the_sessions_own_port_wins_over_the_published_one() {
    // A dev build started inside the installed app: the session's env names ITS port.
    let f = fixture();
    let other = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let other_port = other.server_addr().to_ip().unwrap().port();
    let o = f
        .command()
        .env("CONDUIT_SESSION_ID", "sess-1")
        .env("CONDUIT_HOOK_PORT", other_port.to_string())
        .args(["report", "--state", "idle"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));
    let req = other
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .expect("the report went to the session's own port");
    assert_eq!(req.url(), "/hook?session=sess-1&event=report");
    let _ = req.respond(tiny_http::Response::from_string("ok"));
    f.nothing_arrived();
    assert_ne!(other_port, f.port);
}

#[test]
fn a_bad_state_or_seq_is_a_usage_error_and_posts_nothing() {
    let f = fixture();
    assert_eq!(
        f.report(Some("s"), &["--state", "thinking"]).status.code(),
        Some(2)
    );
    assert_eq!(f.report(Some("s"), &[]).status.code(), Some(2));
    assert_eq!(
        f.report(Some("s"), &["--state", "working", "--seq", "later"])
            .status
            .code(),
        Some(2)
    );
    f.nothing_arrived();
}

#[test]
fn a_report_never_fails_the_caller_when_conduit_is_gone() {
    let f = fixture();
    // The published port answers nothing any more.
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let o = f
        .command()
        .env("CONDUIT_SESSION_ID", "sess-1")
        .env("CONDUIT_HOOK_PORT", dead.to_string())
        .args(["report", "--state", "working"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));
}

#[test]
fn the_windows_shim_refuses_report_by_name() {
    assert!(cli_shim::shim_cmd().contains("if /i \"%~1\"==\"report\" goto no_jobs"));
}
