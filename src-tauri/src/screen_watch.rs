//! Screen watch: turns what `screen_rules` reads off an agent's screen into session status.
//!
//! It fills ONE gap and nothing else: a session whose agent is sitting on a dialog while
//! the hooks say nothing of the kind (Antigravity fires no hooks; a folder-trust prompt
//! runs before any exist). When a dialog appears it reports the session `blocked`; when
//! the dialog goes it hands the session back -- `working` if the screen shows work,
//! otherwise `idle` once the screen has been quiet for two looks in a row.
//!
//! Everything goes through `conduit report`'s own door (`report.rs`): the watcher POSTs a
//! `report` event to the hook server, so a screen-detected block is rewritten into the
//! same `notification` a hooked agent sends and no consumer has a "screen" case. Hooks
//! stay the authority -- `Tracker` never raises over a status the hooks already set, and
//! lets go the moment the hooks move the session on.
//!
//! The screen is read with `tmux capture-pane`, which is the rendered screen. The raw PTY
//! stream is not used: it is a history of repaints, and an "esc to cancel" from a turn
//! that ended a minute ago would still be in it. So this needs tmux, and a session
//! running without it simply gets no screen status.

use crate::screen_rules::{manifest_for, ScreenState};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// How often each watched session's screen is read. One `tmux` process per session per
/// look, and only sessions whose agent has rules are looked at.
const POLL: Duration = Duration::from_secs(2);

/// What one look at a screen showed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
    /// A dialog, and what it is waiting for when the rule says.
    Blocked(Option<&'static str>),
    Working,
    /// No rule matched. Not a claim that the agent is idle.
    Nothing,
}

/// What to report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tell {
    Blocked(Option<&'static str>),
    Working,
    Idle,
}

/// One session's memory between looks.
#[derive(Default, Debug)]
pub struct Tracker {
    /// This watcher reported the block the session is in.
    raised: bool,
    /// The dialog was gone at the last look, with nothing else on screen.
    clearing: bool,
}

impl Tracker {
    /// One look. `status` is the session's status as the hooks left it.
    pub fn step(&mut self, seen: Seen, status: &str) -> Option<Tell> {
        if let Seen::Blocked(kind) = seen {
            self.clearing = false;
            // Reported once, on the way in. Not repeated while the dialog stays up: an
            // agent that keeps reporting itself busy would otherwise flip the badge back
            // and forth every look.
            if self.raised || status == "needsInput" {
                return None;
            }
            self.raised = true;
            return Some(Tell::Blocked(kind));
        }
        if !self.raised {
            self.clearing = false;
            return None;
        }
        // The dialog is gone. If the hooks already moved the session on, they are right
        // and there is nothing to hand back.
        if status != "needsInput" {
            *self = Tracker::default();
            return None;
        }
        match seen {
            Seen::Working => {
                *self = Tracker::default();
                Some(Tell::Working)
            }
            // One empty look is the gap between a dialog closing and the next frame; two
            // in a row is an agent back at its prompt.
            _ if self.clearing => {
                *self = Tracker::default();
                Some(Tell::Idle)
            }
            _ => {
                self.clearing = true;
                None
            }
        }
    }
}

/// What a screen shows for this agent, or `Nothing` when it has no rules.
pub fn look(agent: crate::agent::AgentId, screen: &str) -> Seen {
    match manifest_for(agent).and_then(|m| m.detect(screen)) {
        Some(d) if d.state == ScreenState::Blocked => Seen::Blocked(d.kind()),
        Some(d) if d.state == ScreenState::Working => Seen::Working,
        _ => Seen::Nothing,
    }
}

/// The rendered screen of a tmux session: what is visible now, not its history.
pub fn capture(tmux: &Path, socket: &str, session_name: &str) -> Option<String> {
    let out = Command::new(tmux)
        .args(["-L", socket, "capture-pane", "-p", "-t", session_name])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The `report` body for a `Tell`. `seq` is the clock, so a report that arrives late
/// cannot undo a newer one, and `source` gives the watcher its own counter so it never
/// collides with a script reporting on the same session (`report::seq_key`).
fn report_body(tell: Tell, seq: u64) -> serde_json::Value {
    let state = match tell {
        Tell::Blocked(_) => "blocked",
        Tell::Working => "working",
        Tell::Idle => "idle",
    };
    let mut body = serde_json::json!({ "state": state, "seq": seq, "source": "screen" });
    if let Tell::Blocked(Some(kind)) = tell {
        body["kind"] = kind.into();
    }
    body
}

/// POSTs one report to the hook server on this machine. Plain HTTP over a socket: the
/// peer is our own listener, and the lean-dependency rule (no HTTP client for a couple of
/// requests) holds here as it does everywhere else.
fn post_report(port: u16, session: &str, body: &serde_json::Value) -> std::io::Result<()> {
    let body = body.to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "POST /hook?session={session}&event=report HTTP/1.1\r\nHost: 127.0.0.1\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    // Wait for the answer so the request is known to have been read before the socket goes.
    let mut answer = [0u8; 64];
    let _ = stream.read(&mut answer);
    Ok(())
}

/// Starts the watcher thread.
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("screen-watch".into())
        .spawn(move || {
            let mut trackers: HashMap<String, Tracker> = HashMap::new();
            loop {
                std::thread::sleep(POLL);
                tick(&app, &mut trackers);
            }
        })
        .ok();
}

fn tick(app: &AppHandle, trackers: &mut HashMap<String, Tracker>) {
    let store = app.state::<Arc<crate::store::Store>>();
    let pty = app.state::<Arc<crate::pty::PtyManager>>();
    let fleet = app.state::<Arc<crate::fleet::FleetState>>();
    let port = app
        .state::<Arc<crate::hooks::HookState>>()
        .port
        .load(Ordering::SeqCst);
    let Some(tmux) = pty.tmux_path() else {
        return;
    };
    if port == 0 {
        return;
    }
    let socket = crate::tmux::socket();
    let watched: Vec<(String, crate::agent::AgentId)> = store
        .list()
        .into_iter()
        .flat_map(|p| p.sessions)
        .filter(|s| manifest_for(s.agent).is_some() && pty.has(&s.id))
        .map(|s| (s.id, s.agent))
        .collect();
    // A session that is gone, stopped, or no longer watched keeps no memory.
    trackers.retain(|id, _| watched.iter().any(|(w, _)| w == id));
    for (id, agent) in watched {
        let Some(screen) = capture(tmux, &socket, &crate::tmux::session_name(&id)) else {
            continue;
        };
        let status = fleet.status_of(&id).unwrap_or_default();
        let tracker = trackers.entry(id.clone()).or_default();
        if let Some(tell) = tracker.step(look(agent, &screen), &status) {
            if let Err(e) = post_report(port, &id, &report_body(tell, now_ms())) {
                crate::diag::warn_once(
                    "screen-watch-post",
                    "screen-watch",
                    format!("could not report a screen status: {e}"),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentId;

    const PERMISSION: Seen = Seen::Blocked(Some("permission"));

    #[test]
    fn a_dialog_is_reported_once_on_the_way_in() {
        let mut t = Tracker::default();
        assert_eq!(
            t.step(PERMISSION, "running"),
            Some(Tell::Blocked(Some("permission")))
        );
        // Still up, and the report took: nothing more to say.
        assert_eq!(t.step(PERMISSION, "needsInput"), None);
        // Still up, but the agent's own status line overwrote the badge: not re-raised,
        // or the badge would flip every two seconds.
        assert_eq!(t.step(PERMISSION, "running"), None);
    }

    #[test]
    fn a_block_the_hooks_already_reported_is_left_to_them() {
        let mut t = Tracker::default();
        assert_eq!(t.step(PERMISSION, "needsInput"), None);
        // ...and when that dialog goes, there is nothing of ours to hand back.
        assert_eq!(t.step(Seen::Working, "needsInput"), None);
        assert_eq!(t.step(Seen::Nothing, "needsInput"), None);
        assert_eq!(t.step(Seen::Nothing, "needsInput"), None);
    }

    #[test]
    fn work_on_screen_after_the_dialog_hands_the_session_back_as_working() {
        let mut t = Tracker::default();
        t.step(PERMISSION, "idle");
        assert_eq!(t.step(Seen::Working, "needsInput"), Some(Tell::Working));
        // And it is a clean slate: the next dialog is reported again.
        assert_eq!(
            t.step(Seen::Blocked(None), "running"),
            Some(Tell::Blocked(None))
        );
    }

    #[test]
    fn an_empty_screen_must_be_seen_twice_before_the_session_reads_idle() {
        let mut t = Tracker::default();
        t.step(PERMISSION, "idle");
        // One empty look is the frame between the dialog closing and the next paint.
        assert_eq!(t.step(Seen::Nothing, "needsInput"), None);
        assert_eq!(t.step(Seen::Nothing, "needsInput"), Some(Tell::Idle));
        assert_eq!(t.step(Seen::Nothing, "done"), None);
    }

    #[test]
    fn work_appearing_after_one_empty_look_is_working_not_idle() {
        let mut t = Tracker::default();
        t.step(PERMISSION, "idle");
        assert_eq!(t.step(Seen::Nothing, "needsInput"), None);
        assert_eq!(t.step(Seen::Working, "needsInput"), Some(Tell::Working));
    }

    #[test]
    fn the_dialog_coming_back_cancels_the_wind_down() {
        let mut t = Tracker::default();
        t.step(PERMISSION, "idle");
        assert_eq!(t.step(Seen::Nothing, "needsInput"), None);
        assert_eq!(t.step(PERMISSION, "needsInput"), None);
        // The count starts over: one empty look is again not enough.
        assert_eq!(t.step(Seen::Nothing, "needsInput"), None);
        assert_eq!(t.step(Seen::Nothing, "needsInput"), Some(Tell::Idle));
    }

    #[test]
    fn hooks_moving_the_session_on_ends_our_part_silently() {
        for status in ["running", "done", "idle"] {
            let mut t = Tracker::default();
            t.step(PERMISSION, "idle");
            assert_eq!(t.step(Seen::Nothing, status), None, "{status}");
            // Nothing lingers: a later empty look reports nothing either.
            assert_eq!(t.step(Seen::Nothing, "needsInput"), None, "{status}");
        }
    }

    #[test]
    fn a_screen_with_no_dialog_never_reports_anything_by_itself() {
        let mut t = Tracker::default();
        for seen in [Seen::Working, Seen::Nothing, Seen::Working] {
            for status in ["idle", "running", "done", "needsInput", ""] {
                assert_eq!(t.step(seen, status), None);
            }
        }
    }

    #[test]
    fn look_reads_only_agents_that_have_rules() {
        let dialog = "  ↑/↓ Navigate · tab Amend · f full diff\n──── esc to cancel";
        assert_eq!(look(AgentId::Antigravity, dialog), PERMISSION);
        assert_eq!(
            look(AgentId::Antigravity, "⠹ Reading\n──── esc to cancel"),
            Seen::Working
        );
        assert_eq!(
            look(AgentId::Antigravity, "  ? for shortcuts"),
            Seen::Nothing
        );
        // The same text on a Claude session is not ours to interpret.
        assert_eq!(look(AgentId::Claude, dialog), Seen::Nothing);
    }

    #[test]
    fn a_report_carries_its_kind_and_a_seq() {
        let b = report_body(Tell::Blocked(Some("question")), 42);
        assert_eq!(
            b,
            serde_json::json!({"state": "blocked", "kind": "question", "seq": 42, "source": "screen"})
        );
        assert!(report_body(Tell::Blocked(None), 1).get("kind").is_none());
        assert_eq!(report_body(Tell::Working, 2)["state"], "working");
        assert_eq!(report_body(Tell::Idle, 3)["state"], "idle");
        // Every body is one `report.rs` understands, so nothing downstream needs a new case.
        for tell in [
            Tell::Blocked(Some("permission")),
            Tell::Blocked(None),
            Tell::Working,
            Tell::Idle,
        ] {
            assert!(
                crate::report::translate(&report_body(tell, 1)).is_some(),
                "{tell:?}"
            );
        }
    }

    #[test]
    fn the_report_is_posted_to_the_hook_route_as_that_session() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut req = server.recv().unwrap();
            let mut body = String::new();
            req.as_reader().read_to_string(&mut body).unwrap();
            let url = req.url().to_string();
            req.respond(tiny_http::Response::from_string("ok")).unwrap();
            (url, body)
        });
        post_report(
            port,
            "sess-9",
            &report_body(Tell::Blocked(Some("permission")), 7),
        )
        .unwrap();
        let (url, body) = handle.join().unwrap();
        assert_eq!(url, "/hook?session=sess-9&event=report");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"state": "blocked", "kind": "permission", "seq": 7, "source": "screen"})
        );
    }

    /// The whole reading path against a real terminal: a real tmux session drawing an
    /// Antigravity permission dialog, captured the way the watcher captures it.
    #[test]
    fn a_dialog_drawn_in_a_real_tmux_pane_is_read_as_blocked() {
        let Some(tmux) = crate::tmux::find_tmux() else {
            eprintln!("skipped: tmux is not installed");
            return;
        };
        let socket = format!("conduit-screen-test-{}", std::process::id());
        let name = "dialog";
        let script = "printf 'Run command: cargo test\\n\\n  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\\n──────────────── esc to cancel\\n'; sleep 30";
        let started = Command::new(&tmux)
            .args([
                "-L",
                &socket,
                "-f",
                "/dev/null",
                "new-session",
                "-d",
                "-s",
                name,
                "-x",
                "100",
                "-y",
                "30",
            ])
            .args(["sh", "-c", script])
            .status()
            .expect("tmux runs");
        assert!(started.success());
        // The pane needs a moment to draw.
        let mut screen = String::new();
        for _ in 0..50 {
            screen = capture(&tmux, &socket, name).unwrap_or_default();
            if screen.contains("Navigate") {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let seen = look(AgentId::Antigravity, &screen);
        let _ = Command::new(&tmux)
            .args(["-L", &socket, "kill-server"])
            .status();
        assert_eq!(seen, PERMISSION, "captured screen: {screen:?}");
        // A pane that is not there is `None`, not an empty screen that reads as "nothing".
        assert_eq!(capture(&tmux, &socket, "no-such-session"), None);
    }
}
