//! Mobile bridge — a WebSocket server that mirrors a session's PTY to a phone and
//! forwards its keystrokes back.
//!
//! Where it listens is the whole security story, so it is narrow on purpose:
//! - `127.0.0.1:<port>` always. Loopback peers stay unauthenticated (the matrix-adapter
//!   sidecar and the simulator rely on it).
//! - `<Tailscale IPv4>:<port>` only while mobile access is on AND Tailscale is `Running`.
//!   [`plan_listeners`] decides it every 30 s (and on the switch), so a restart or a new
//!   address re-binds within one tick and a stale address is never left bound.
//! - Never `0.0.0.0` / `::`. Peers outside loopback and the tailnet ranges are dropped
//!   before the handshake, and any handshake carrying `Origin` is refused with 403 (a
//!   web page on the Mac must never reach the bridge).
//!
//! Every peer is greeted with `hello`. A non-loopback peer must then `auth` with its
//! device token within 5 s (or `pair`/`discover`); pre-auth frames are capped at 4 KiB,
//! failures are rate-limited per IP and answered with one generic `unauthorized`.
//! Revoking a device closes its open sockets on the next 20 ms tick.
//!
//! WebSocket (not tiny_http like hooks.rs) because terminal I/O is bidirectional and
//! latency-sensitive. Thread-per-connection, matching the hooks server's style.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream};
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{accept_hdr_with_config, Message, WebSocket};

use crate::hookbus::HookBus;
use crate::mobile_devices::MobileDevices;
use crate::pairing::{self, Decision, PairRequest, Pairing, Resolution, Via, WaitEnd};
use crate::pty::PtyManager;
use crate::store::Store;
use crate::tailscale::{self, TailscaleState};

/// Messages the client (browser/phone) sends. `input.data` is a RAW keystroke
/// string (same contract as the `pty_write` command), NOT base64 — only PTY *output*
/// is base64 because it is arbitrary bytes.
///
/// Wire spelling: the original messages carry `session_id` (snake_case) and stay that
/// way; every message added for Tailscale pairing is camelCase with an explicit rename.
/// Tests pin both.
#[derive(Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientMsg {
    List,
    Attach {
        session_id: String,
    },
    Input {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Read-only git query for a session's repo (phone diff review).
    /// action = "changes" (Vec<Change>) | "diff" (unified text for `path`).
    Git {
        session_id: String,
        action: String,
        #[serde(default)]
        path: Option<String>,
    },
    /// Terminate a session's agent process (hard stop from the phone).
    Kill {
        session_id: String,
    },
    /// Spawn a NEW session in a project with an initial prompt. The frontend
    /// actually opens the tab + spawns the PTY (Rust can't mint a terminal
    /// Channel), mirroring the fleet-spawn path.
    Spawn {
        project_id: String,
        prompt: String,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        worktree: bool,
    },
    /// First frame from a paired phone: its device token (verified hash-to-hash).
    Auth {
        token: String,
    },
    /// Pair with this Mac, either with the QR's one-time `secret` or by asking
    /// (`request: true`). Allowed pre-auth; handled by the pairing seam.
    #[serde(rename_all = "camelCase")]
    Pair {
        #[serde(default)]
        secret: Option<String>,
        #[serde(default)]
        request: Option<bool>,
        device_name: String,
        nonce: String,
    },
    /// List other Macs on the tailnet running Conduit.
    Discover,
    /// Stop the agent's current turn: sends Esc, Claude's interrupt key.
    #[serde(rename_all = "camelCase")]
    Interrupt {
        session_id: String,
    },
}

/// Manual `Debug`: `Auth.token`, `Pair.secret` and `Pair.nonce` are plaintext secrets and
/// must never reach a log through a stray `{:?}`.
impl std::fmt::Debug for ClientMsg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        const R: &str = "<redacted>";
        match self {
            Self::List => f.write_str("List"),
            Self::Attach { session_id } => f
                .debug_struct("Attach")
                .field("session_id", session_id)
                .finish(),
            Self::Input { session_id, data } => f
                .debug_struct("Input")
                .field("session_id", session_id)
                .field("data", data)
                .finish(),
            Self::Resize {
                session_id,
                cols,
                rows,
            } => f
                .debug_struct("Resize")
                .field("session_id", session_id)
                .field("cols", cols)
                .field("rows", rows)
                .finish(),
            Self::Git {
                session_id,
                action,
                path,
            } => f
                .debug_struct("Git")
                .field("session_id", session_id)
                .field("action", action)
                .field("path", path)
                .finish(),
            Self::Kill { session_id } => f
                .debug_struct("Kill")
                .field("session_id", session_id)
                .finish(),
            Self::Spawn {
                project_id,
                prompt,
                agent,
                worktree,
            } => f
                .debug_struct("Spawn")
                .field("project_id", project_id)
                .field("prompt", prompt)
                .field("agent", agent)
                .field("worktree", worktree)
                .finish(),
            Self::Auth { .. } => f.debug_struct("Auth").field("token", &R).finish(),
            Self::Pair {
                secret,
                request,
                device_name,
                ..
            } => f
                .debug_struct("Pair")
                .field("secret", &secret.as_ref().map(|_| R))
                .field("request", request)
                .field("device_name", device_name)
                .field("nonce", &R)
                .finish(),
            Self::Discover => f.write_str("Discover"),
            Self::Interrupt { session_id } => f
                .debug_struct("Interrupt")
                .field("session_id", session_id)
                .finish(),
        }
    }
}

/// Parse one client text frame. None on malformed JSON or an unknown `type`.
pub fn parse_client_msg(text: &str) -> Option<ClientMsg> {
    serde_json::from_str(text).ok()
}

/// How many buffered output frames to flush to the socket per poll iteration.
const DRAIN_PER_TICK: usize = 256;
/// Read timeout so the poll loop can interleave control reads with output draining.
const READ_POLL: Duration = Duration::from_millis(20);
/// The bridge's port range. Ends at 8474: 8475 is the first port of fleet MCP's range.
pub const BRIDGE_PORTS: RangeInclusive<u16> = 8455..=8474;
/// A non-loopback peer must authenticate (or start pairing) within this long.
const AUTH_DEADLINE: Duration = Duration::from_secs(5);
/// Bound on the WHOLE HTTP upgrade (total, not per read), so a silent or dribbling peer
/// cannot hold a thread.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Largest frame/message an unauthenticated peer may send.
const PREAUTH_MAX_BYTES: usize = 4 * 1024;
/// Failed `auth` attempts allowed per peer IP in [`AUTH_FAILURE_WINDOW`].
const AUTH_FAILURES_MAX: usize = 5;
const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// Pair prompts raised on the Mac per peer IP in [`PAIR_PROMPT_WINDOW`], whatever their
/// outcome -- a hang-up or a self-replacement still put a prompt in front of the human, so
/// counting only failures would let a peer wear down the confirm-on-the-Mac safeguard.
const PAIR_PROMPTS_MAX: usize = 5;
const PAIR_PROMPT_WINDOW: Duration = Duration::from_secs(600);

/// Take one prompt slot for `ip` (records it). `false` = budget spent; raise no prompt.
fn take_prompt_slot(prompts: &Mutex<HashMap<String, VecDeque<Instant>>>, ip: IpAddr) -> bool {
    crate::fleet::rate_limited(
        prompts,
        &ip.to_string(),
        PAIR_PROMPTS_MAX,
        PAIR_PROMPT_WINDOW,
    )
}
/// How often a listener's accept loop checks its stop flag.
const ACCEPT_POLL: Duration = Duration::from_millis(100);
/// How often the tailnet listener is re-planned against Tailscale's state.
const RECONCILE_EVERY: Duration = Duration::from_secs(30);
/// How often the attached session's context meter is re-sent.
const CONTEXT_EVERY: Duration = Duration::from_secs(15);
/// Wire protocol version announced in `hello`.
const PROTOCOL_VERSION: u32 = 1;

/// Build a forwarded hook-status frame.
fn status_payload(event: &str, body: &serde_json::Value) -> serde_json::Value {
    json!({ "type": "status", "event": event, "body": body })
}

/// Handle a `git` client message: resolve the session's repo dir from the Store,
/// run the read-only query, and build a `gitresult` frame. Never blocks the loop
/// (git calls are fast local reads).
fn git_reply(
    app: &AppHandle,
    session_id: &str,
    action: &str,
    path: Option<&str>,
) -> serde_json::Value {
    let Some(dir) = app.state::<Arc<Store>>().session_dir(session_id) else {
        return json!({ "type": "gitresult", "action": action, "error": "unknown session" });
    };
    match action {
        "changes" => {
            let changes = crate::git::changes(&dir);
            json!({ "type": "gitresult", "action": "changes", "changes": changes })
        }
        "diff" => {
            let Some(path) = path else {
                return json!({ "type": "gitresult", "action": "diff", "error": "path required" });
            };
            // A repo-relative path from `changes` -> absolute for git::diff_text.
            let abs = if std::path::Path::new(path).is_absolute() {
                path.to_string()
            } else {
                std::path::Path::new(&dir)
                    .join(path)
                    .to_string_lossy()
                    .into_owned()
            };
            match crate::git::diff_text(&dir, &abs) {
                Ok(text) => {
                    json!({ "type": "gitresult", "action": "diff", "path": path, "diff": text })
                }
                Err(e) => {
                    json!({ "type": "gitresult", "action": "diff", "path": path, "error": e })
                }
            }
        }
        other => json!({ "type": "gitresult", "action": other, "error": "unknown git action" }),
    }
}

/// Handle a `spawn` client message: create a session in the project and emit
/// `fleet-spawn` so the frontend opens the tab, spawns the PTY, and injects the
/// prompt (the same generic path fleet workers use — `mergeSpawnedSession` is not
/// fleet-specific). Returns a `spawned` frame with the new session id, or `error`.
fn spawn_reply(
    app: &AppHandle,
    project_id: &str,
    prompt: &str,
    agent: Option<&str>,
    worktree: bool,
) -> serde_json::Value {
    use tauri::Emitter;
    let agent_id: crate::agent::AgentId =
        match serde_json::from_value(json!(agent.unwrap_or("claude"))) {
            Ok(a) => a,
            Err(_) => {
                return json!({ "type": "error", "message": "unknown agent" });
            }
        };
    let store = app.state::<Arc<Store>>();
    let Some(project) = store.list().into_iter().find(|p| p.id == project_id) else {
        return json!({ "type": "error", "message": "unknown project" });
    };
    // A worktree needs a git repo; refuse rather than spawn a broken session.
    if worktree && crate::git::current_branch(&project.path).is_none() {
        return json!({ "type": "error", "message": "worktree requested but project is not a git repo" });
    }
    let Some(session) = store.add_session(
        project_id,
        "Mobile".to_string(),
        worktree,
        agent_id,
        crate::store::SessionRole::Worker,
    ) else {
        return json!({ "type": "error", "message": "could not create session" });
    };
    let _ = app.emit(
        "fleet-spawn",
        json!({ "projectId": project_id, "session": session, "task": prompt }),
    );
    json!({
        "type": "spawned",
        "sessionId": session.id,
        "name": session.name,
        "projectId": project_id,
    })
}

/// Ask the desktop to open (activate) a session's tab, which spawns its PTY — the
/// frontend owns the terminal Channel, so Rust can't spawn it directly. The
/// frontend's `bridge-open-session` listener resolves the project and selects it.
fn wake_session(app: &AppHandle, session_id: &str) {
    use tauri::Emitter;
    let _ = app.emit("bridge-open-session", json!({ "sessionId": session_id }));
}

/// Build the transcript backfill payload from raw jsonl lines.
fn history_payload(lines: &[String]) -> serde_json::Value {
    let items: Vec<serde_json::Value> = lines
        .iter()
        .flat_map(|l| crate::transcript::parse_line(l))
        .collect();
    json!({ "type": "history", "items": items })
}

/// Read a transcript file fully into trimmed, non-empty lines. Empty on any error.
fn read_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|s| {
            s.lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// The generic failure reply. Identical for a wrong token, a revoked device, a
/// rate-limited peer, a bad or spent pairing secret and a pre-auth `discover` -- no oracle.
fn unauthorized() -> serde_json::Value {
    json!({ "type": "error", "message": "unauthorized" })
}

/// First frame to every peer, before auth.
fn hello_payload(mac_name: &str, version: &str) -> serde_json::Value {
    json!({
        "type": "hello",
        "macName": mac_name,
        "conduitVersion": version,
        "protocolVersion": PROTOCOL_VERSION,
    })
}

/// Sent once, immediately after a successful `auth`, before any other frame.
fn auth_ok_payload(device_id: &str) -> serde_json::Value {
    json!({ "type": "authOk", "deviceId": device_id })
}

/// Does the upgrade request carry an `Origin` header? Browsers always send one on a
/// WebSocket upgrade; the phone app and the sidecar never do.
fn has_origin(req: &Request) -> bool {
    req.headers()
        .contains_key(tungstenite::http::header::ORIGIN)
}

/// What to do with the tailnet listener. `close` drops the one bound now; `bind` opens
/// one on that address. Both set = the address moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListenerPlan {
    pub bind: Option<Ipv4Addr>,
    pub close: bool,
}

/// Pure: given the switch, Tailscale's state and what is bound now, decide the change.
/// Anything short of `Running` with an IPv4 means "no tailnet listener" -- including a
/// `Stopped` node that still reports its old addresses, and an `Unknown` read.
pub fn plan_listeners(
    enabled: bool,
    ts: &TailscaleState,
    bound_tailnet: Option<Ipv4Addr>,
) -> ListenerPlan {
    let want = match ts {
        _ if !enabled => None,
        // Hysteresis: "could not tell" (e.g. one CLI timeout) is not "stopped". Keep
        // whatever is bound now; the next tick decides with a real answer.
        TailscaleState::Unknown { .. } => bound_tailnet,
        // Only ever an address in Tailscale's own range -- never 0.0.0.0, never a LAN IP.
        TailscaleState::Running { ipv4: Some(ip), .. }
            if tailscale::is_tailnet_addr(IpAddr::V4(*ip)) =>
        {
            Some(*ip)
        }
        _ => None,
    };
    if want == bound_tailnet {
        return ListenerPlan {
            bind: None,
            close: false,
        };
    }
    ListenerPlan {
        bind: want,
        close: bound_tailnet.is_some(),
    }
}

/// Pure: the persisted port when it is in range and free, else the first free one in
/// [`BRIDGE_PORTS`]. `is_free` is injected so tests do not touch sockets.
pub fn pick_port(persisted: Option<u16>, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    persisted
        .filter(|p| BRIDGE_PORTS.contains(p))
        .into_iter()
        .chain(BRIDGE_PORTS)
        .find(|p| is_free(*p))
}

/// The name a phone shows for this Mac: Tailscale's own name for it when running (what
/// the user sees in the tailnet), else the system's, else "Conduit".
fn mac_name_from(ts: &TailscaleState, system: Option<String>) -> String {
    if let TailscaleState::Running { self_name, .. } = ts {
        if !self_name.trim().is_empty() {
            return self_name.clone();
        }
    }
    system
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Conduit".to_string())
}

#[cfg(target_os = "macos")]
fn system_name() -> Option<String> {
    use crate::NoWindow;
    let out = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .no_window()
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
fn system_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn system_name() -> Option<String> {
    std::env::var("HOSTNAME").ok()
}

/// Accept a WebSocket. Any `Origin` is refused with 403 before the upgrade completes.
/// `preauth_cap` limits frames and messages to [`PREAUTH_MAX_BYTES`] so an
/// unauthenticated peer cannot make us buffer megabytes; it is lifted on auth.
///
/// `result_large_err`: the Err type is tungstenite's `ErrorResponse`, whose shape the
/// handshake callback signature fixes for us. Boxing it is not an option -- the callback
/// must return exactly that type -- and this runs once per connection, not in a loop.
#[allow(clippy::result_large_err)]
fn accept_ws(stream: TcpStream, preauth_cap: bool) -> Option<WebSocket<TcpStream>> {
    accept_ws_within(stream, preauth_cap, HANDSHAKE_TIMEOUT)
}

#[allow(clippy::result_large_err)]
fn accept_ws_within(
    stream: TcpStream,
    preauth_cap: bool,
    deadline: Duration,
) -> Option<WebSocket<TcpStream>> {
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        if has_origin(req) {
            let mut err = ErrorResponse::new(Some("forbidden".to_string()));
            *err.status_mut() = StatusCode::FORBIDDEN;
            Err(err)
        } else {
            Ok(resp)
        }
    };
    let config = preauth_cap.then(|| WebSocketConfig {
        max_message_size: Some(PREAUTH_MAX_BYTES),
        max_frame_size: Some(PREAUTH_MAX_BYTES),
        ..Default::default()
    });
    // One deadline for the WHOLE upgrade, not per read: a watchdog shuts the socket down
    // when it passes, so a peer dribbling a byte at a time cannot hold the thread.
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    if let Ok(guard) = stream.try_clone() {
        thread::spawn(move || {
            if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = done_rx.recv_timeout(deadline)
            {
                let _ = guard.shutdown(std::net::Shutdown::Both);
            }
        });
    }
    let ws = accept_hdr_with_config(stream, check, config).ok();
    drop(done_tx);
    ws
}

/// Lift the pre-auth cap back to tungstenite's defaults (what every peer had before).
fn lift_preauth_cap(ws: &mut WebSocket<TcpStream>) {
    let d = WebSocketConfig::default();
    ws.set_config(|c| {
        c.max_message_size = d.max_message_size;
        c.max_frame_size = d.max_frame_size;
    });
}

/// Block this connection (it has nothing else to do pre-auth) until the Mac answers, the
/// request expires, mobile access goes off, or the phone hangs up. The pre-auth deadline
/// does not apply here: the loop that enforces it is parked in this call.
fn wait_for_pair_answer(
    ws: &mut WebSocket<TcpStream>,
    rx: &std::sync::mpsc::Receiver<Resolution>,
    enabled: impl Fn() -> bool,
) -> WaitEnd {
    use std::sync::mpsc::RecvTimeoutError;
    let end = Instant::now() + pairing::REQUEST_WAIT;
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(r) => return WaitEnd::Resolved(r),
            Err(RecvTimeoutError::Disconnected) => return WaitEnd::Expired,
            Err(RecvTimeoutError::Timeout) => {}
        }
        // Belt and braces with `Pairing::clear`: the switch going off ends the wait.
        if !enabled() {
            return WaitEnd::Resolved(Resolution::Off);
        }
        if Instant::now() >= end {
            return WaitEnd::Expired;
        }
        // Notice a hang-up so the request (and the peer's one slot) is freed at once.
        match ws.read() {
            Ok(Message::Close(_)) => return WaitEnd::Gone,
            Ok(_) => {} // nothing else is meaningful while waiting
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return WaitEnd::Gone,
        }
    }
}

/// `pairResult` on success: the device token (shown once) and the new device's id.
fn pair_result_ok(token: &str, device_id: &str) -> serde_json::Value {
    json!({ "type": "pairResult", "ok": true, "token": token, "deviceId": device_id })
}

/// `pairResult` on failure: declined | expired | replaced | off | error.
fn pair_result_err(reason: &str) -> serde_json::Value {
    json!({ "type": "pairResult", "ok": false, "reason": reason })
}

/// Sent once a request is parked: on the request path the id is the code's input.
fn pair_pending(request_id: &str) -> serde_json::Value {
    json!({ "type": "pairPending", "requestId": request_id })
}

/// Handle one `pair` frame end to end: gate, consume the QR secret or accept a request,
/// prompt the Mac (`pair-request`), wait, and on allow mint the device. Sends every reply
/// itself. Returns the new device id when the phone is now paired; `None` for every
/// failure (the caller closes a pre-auth socket). Never logs the secret, nonce or token.
#[allow(clippy::too_many_arguments)]
fn pair_flow(
    ctrl: &BridgeController,
    app: &AppHandle,
    ws: &mut WebSocket<TcpStream>,
    peer: IpAddr,
    secret: Option<String>,
    request: bool,
    device_name: &str,
    nonce: &str,
) -> Option<String> {
    use tauri::Emitter;
    let pairing = app.state::<Arc<Pairing>>().inner().clone();
    let refuse = |ws: &mut WebSocket<TcpStream>| {
        ctrl.record_auth_failure(peer);
        let _ = ws.send(Message::Text(unauthorized().to_string()));
        None
    };
    // Pairing exists only while mobile access is on. Then: under the per-IP limit and a
    // nonce the code can bind to. A request already waiting from this IP is replaced.
    if !ctrl.devices.enabled() || !ctrl.auth_allowed(peer) || !pairing::nonce_ok(nonce) {
        return refuse(ws);
    }
    let (via, secret) = match (secret, request) {
        (Some(s), _) => {
            if !pairing.consume_secret(&s) {
                return refuse(ws);
            }
            (Via::Secret, Some(s))
        }
        (None, true) => (Via::Request, None),
        (None, false) => return refuse(ws),
    };
    let device_name = pairing::clean_device_name(device_name);
    // Who owns the phone, per Tailscale. Only here, never in a tick; loopback has no owner.
    let login = if peer.is_loopback() {
        None
    } else {
        tailscale::whois(peer).map(|w| w.login_name)
    };
    // Every prompt costs a slot, however it ends; spent = no prompt at all.
    if !take_prompt_slot(&ctrl.pair_prompts, peer) {
        return refuse(ws);
    }
    let (id, rx) = pairing.register(PairRequest {
        peer,
        device_name: device_name.clone(),
        nonce: nonce.to_string(),
        via,
        login: login.clone(),
        secret,
    });
    if let Some(view) = pairing.get(&id) {
        let _ = app.emit("pair-request", &view);
    }
    let end = if ws
        .send(Message::Text(pair_pending(&id).to_string()))
        .is_err()
    {
        WaitEnd::Gone
    } else {
        wait_for_pair_answer(ws, &rx, || ctrl.devices.enabled())
    };
    // Forget FIRST, then drain once (the asks.rs rule): a `pair_respond` either landed
    // before the forget and is seen here, or finds nothing and reports false to its card.
    pairing.forget(&id);
    let end = match end {
        WaitEnd::Expired => rx.try_recv().map_or(WaitEnd::Expired, WaitEnd::Resolved),
        other => other,
    };
    // The switch is read right before acting, so an Allow after "off" persists nothing.
    let (how, device) = match pairing::decide(end, ctrl.devices.enabled()) {
        Decision::Pair => match ctrl.devices.add_device(&device_name, login) {
            // Re-check after the write: a switch flipped during it must not hand out a token.
            Ok((device, _)) if !ctrl.devices.enabled() => {
                let _ = ctrl.devices.revoke(&device.id);
                let _ = ws.send(Message::Text(pair_result_err("off").to_string()));
                ("off", None)
            }
            Ok((device, token)) => {
                let ok = pair_result_ok(&token, &device.id);
                if ws.send(Message::Text(ok.to_string())).is_ok() {
                    ("allowed", Some(device.id))
                } else {
                    // The token never reached the phone: leave no device nobody holds.
                    let _ = ctrl.devices.revoke(&device.id);
                    ("cancelled", None)
                }
            }
            Err(e) => {
                eprintln!("conduit: could not save paired phone: {e}");
                let _ = ws.send(Message::Text(pair_result_err("error").to_string()));
                ("failed", None)
            }
        },
        Decision::Refuse(reason) => {
            let _ = ws.send(Message::Text(pair_result_err(reason).to_string()));
            // Only a human "no" or silence counts toward the per-IP limit; a replaced or
            // switched-off request is not the phone's failure.
            if matches!(reason, "declined" | "expired") {
                ctrl.record_auth_failure(peer);
            }
            (reason, None)
        }
        Decision::Cancelled => ("cancelled", None),
    };
    let _ = app.emit("pair-resolved", json!({ "id": id, "how": how }));
    device
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Owns the bridge's listeners and its live authenticated connections. Managed as
/// `Arc<BridgeController>`.
pub struct BridgeController {
    devices: Arc<MobileDevices>,
    app: OnceLock<AppHandle>,
    /// The bound port (0 until the loopback listener is up). Same port on both addresses.
    port: AtomicU16,
    mac_name: Mutex<String>,
    /// The tailnet listener: its address and its accept loop's stop flag. Held across a
    /// whole reconcile, which serializes reconciles.
    tailnet: Mutex<Option<(Ipv4Addr, Arc<AtomicBool>)>>,
    /// Authenticated connections by device id; setting a flag closes that socket.
    live: Mutex<HashMap<String, Vec<Arc<AtomicBool>>>>,
    /// Failed auth attempts per peer IP (`fleet::rate_limited`'s map shape).
    auth_failures: Mutex<HashMap<String, VecDeque<Instant>>>,
    /// Pair prompts raised per peer IP (a budget separate from failures).
    pair_prompts: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl BridgeController {
    pub fn new(devices: Arc<MobileDevices>) -> Self {
        Self {
            devices,
            app: OnceLock::new(),
            port: AtomicU16::new(0),
            mac_name: Mutex::new("Conduit".to_string()),
            tailnet: Mutex::new(None),
            live: Mutex::new(HashMap::new()),
            auth_failures: Mutex::new(HashMap::new()),
            pair_prompts: Mutex::new(HashMap::new()),
        }
    }

    /// Bind loopback on the persisted (or first free) port, then re-plan the tailnet
    /// listener every [`RECONCILE_EVERY`]. Everything runs off the calling thread.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        if self.app.set(app.clone()).is_err() {
            return; // already started
        }
        let me = self.clone();
        thread::spawn(move || {
            // CLI calls happen here, once, never in a connection loop.
            *lock(&me.mac_name) = mac_name_from(&tailscale::status(), system_name());

            let persisted = me.devices.port();
            let bound: RefCell<Option<TcpListener>> = RefCell::new(None);
            let port = pick_port(persisted, |p| {
                match TcpListener::bind((Ipv4Addr::LOCALHOST, p)) {
                    Ok(l) => {
                        *bound.borrow_mut() = Some(l);
                        true
                    }
                    Err(_) => false,
                }
            });
            let (Some(port), Some(listener)) = (port, bound.into_inner()) else {
                eprintln!(
                    "conduit: no free bridge port in {}..={}",
                    BRIDGE_PORTS.start(),
                    BRIDGE_PORTS.end()
                );
                return;
            };
            if persisted != Some(port) {
                if let Err(e) = me.devices.set_port(port) {
                    eprintln!("conduit: could not persist bridge port {port}: {e}");
                }
            }
            me.port.store(port, Ordering::SeqCst);
            eprintln!("conduit: mobile bridge on ws://127.0.0.1:{port}");
            {
                let (me, app) = (me.clone(), app.clone());
                let never = Arc::new(AtomicBool::new(false));
                thread::spawn(move || accept_loop(listener, never, app, me));
            }
            loop {
                me.reconcile();
                thread::sleep(RECONCILE_EVERY);
            }
        });
    }

    /// Re-plan the tailnet listener and apply the plan. Called by the 30 s tick and by
    /// `mobile_set_enabled`. Blocks for up to the Tailscale CLI's 3 s deadline, so it
    /// must never run on the UI thread.
    pub fn reconcile(&self) {
        let Some(app) = self.app.get() else {
            return; // not started: there is nothing to bind beside
        };
        let port = self.current_port();
        if port == 0 {
            return;
        }
        let mut slot = lock(&self.tailnet);
        // Read the switch only once we hold the lock: a value read before it could be
        // stale by the time a concurrent reconcile (the "off" one) has released it, and
        // would re-bind after access was turned off.
        let enabled = self.devices.enabled();
        // Off and nothing bound: skip the CLI call entirely.
        if !enabled && slot.is_none() {
            return;
        }
        let ts = if enabled {
            tailscale::status()
        } else {
            TailscaleState::Stopped
        };
        if let TailscaleState::Running { .. } = ts {
            *lock(&self.mac_name) = mac_name_from(&ts, None);
        }
        let plan = plan_listeners(enabled, &ts, slot.as_ref().map(|(ip, _)| *ip));
        if plan.close {
            if let Some((_, stop)) = slot.take() {
                stop.store(true, Ordering::SeqCst);
            }
            // Remote access is going away (or moving): end every phone's socket.
            self.disconnect_all_devices();
            // Going away (not merely moving): pairing ends with it -- the QR secret and
            // every waiting request, so a late Allow persists nothing.
            if plan.bind.is_none() {
                app.state::<Arc<Pairing>>().clear_and_announce(app);
            }
        }
        if let Some(ip) = plan.bind {
            match bind_with_retry(ip, port) {
                Ok(listener) => {
                    let stop = Arc::new(AtomicBool::new(false));
                    let ctrl = app.state::<Arc<BridgeController>>().inner().clone();
                    let (flag, app) = (stop.clone(), app.clone());
                    thread::spawn(move || accept_loop(listener, flag, app, ctrl));
                    eprintln!("conduit: mobile bridge on ws://{ip}:{port} (Tailscale)");
                    *slot = Some((ip, stop));
                }
                // Left unbound; the next tick retries.
                Err(e) => eprintln!("conduit: could not bind bridge to {ip}:{port}: {e}"),
            }
        }
    }

    /// Close every open socket of a device (revoke). Immediate: each connection checks
    /// its flag on every 20 ms tick.
    pub fn disconnect_device(&self, device_id: &str) {
        if let Some(flags) = lock(&self.live).remove(device_id) {
            for f in flags {
                f.store(true, Ordering::SeqCst);
            }
        }
    }

    pub(crate) fn disconnect_all_devices(&self) {
        for (_, flags) in lock(&self.live).drain() {
            for f in flags {
                f.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn current_port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    /// The Tailscale address the bridge is listening on right now, if any. Waits behind
    /// a reconcile in progress (which holds this lock across its CLI call).
    pub fn tailnet_addr(&self) -> Option<Ipv4Addr> {
        lock(&self.tailnet).as_ref().map(|(ip, _)| *ip)
    }

    fn mac_name(&self) -> String {
        lock(&self.mac_name).clone()
    }

    fn register_live(&self, device_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        lock(&self.live)
            .entry(device_id.to_string())
            .or_default()
            .push(flag.clone());
        flag
    }

    fn unregister_live(&self, device_id: &str, flag: &Arc<AtomicBool>) {
        let mut live = lock(&self.live);
        if let Some(v) = live.get_mut(device_id) {
            v.retain(|f| !Arc::ptr_eq(f, flag));
            if v.is_empty() {
                live.remove(device_id);
            }
        }
    }

    /// Has this IP fewer than [`AUTH_FAILURES_MAX`] failures in the window? Read-only:
    /// only a failure is recorded (by `fleet::rate_limited`), so a phone that merely
    /// reconnects often is never locked out.
    fn auth_allowed(&self, ip: IpAddr) -> bool {
        let map = lock(&self.auth_failures);
        let now = Instant::now();
        map.get(&ip.to_string()).is_none_or(|q| {
            q.iter()
                .filter(|t| now.duration_since(**t) <= AUTH_FAILURE_WINDOW)
                .count()
                < AUTH_FAILURES_MAX
        })
    }

    fn record_auth_failure(&self, ip: IpAddr) {
        let _ = crate::fleet::rate_limited(
            &self.auth_failures,
            &ip.to_string(),
            AUTH_FAILURES_MAX,
            AUTH_FAILURE_WINDOW,
        );
    }

    /// Re-check after registering a live connection: the device is still paired and
    /// mobile access is still on. Anything that changed between `verify` and
    /// `register_live` would otherwise have found no flag to set.
    fn still_admitted(&self, device_id: &str) -> bool {
        self.devices.enabled() && self.devices.contains(device_id)
    }

    /// Verify a device token from `peer`. None for every failure, alike.
    fn authenticate(&self, peer: IpAddr, token: &str) -> Option<String> {
        if !self.auth_allowed(peer) || !self.devices.enabled() {
            return None;
        }
        let id = self.devices.verify(token);
        if id.is_none() {
            self.record_auth_failure(peer);
        }
        id
    }
}

/// Bind the tailnet address, retrying briefly: a listener closed a moment ago may not
/// have been dropped by its accept loop yet (it polls every [`ACCEPT_POLL`]).
fn bind_with_retry(ip: Ipv4Addr, port: u16) -> std::io::Result<TcpListener> {
    let mut last = std::io::Error::other("bind not attempted");
    for _ in 0..3 {
        match TcpListener::bind((ip, port)) {
            Ok(l) => return Ok(l),
            Err(e) => last = e,
        }
        thread::sleep(ACCEPT_POLL + Duration::from_millis(50));
    }
    Err(last)
}

/// Accept connections until `stop` is set. Nonblocking so a closed tailnet listener's
/// thread exits (and drops the socket) within [`ACCEPT_POLL`].
fn accept_loop(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    app: AppHandle,
    ctrl: Arc<BridgeController>,
) {
    if listener.set_nonblocking(true).is_err() {
        eprintln!("conduit: bridge listener could not go nonblocking");
        return;
    }
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                // Filter on the socket's own view of the peer, before any handshake bytes.
                let Ok(peer) = stream.peer_addr().map(|a| a.ip()) else {
                    continue;
                };
                if !tailscale::is_allowed_peer(peer) {
                    continue; // dropping the stream closes it
                }
                let (app, ctrl) = (app.clone(), ctrl.clone());
                thread::spawn(move || handle_conn(stream, peer, app, ctrl));
            }
            Err(_) => thread::sleep(ACCEPT_POLL),
        }
    }
}

fn handle_conn(stream: TcpStream, peer: IpAddr, app: AppHandle, ctrl: Arc<BridgeController>) {
    let loopback = peer.is_loopback();
    // An accepted socket can inherit the listener's nonblocking mode (BSD/macOS do);
    // the handshake wants blocking reads, bounded by a timeout.
    if stream.set_nonblocking(false).is_err()
        || stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
    {
        return;
    }
    let Some(mut ws) = accept_ws(stream, !loopback) else {
        return;
    };
    if ws.get_ref().set_read_timeout(Some(READ_POLL)).is_err() {
        return;
    }
    // `hello` goes to every peer first, before anything else and before auth.
    let hello = hello_payload(&ctrl.mac_name(), env!("CARGO_PKG_VERSION"));
    if ws.send(Message::Text(hello.to_string())).is_err() {
        return;
    }

    // Loopback is trusted (sidecar, simulator); everyone else proves a device token.
    let mut authed = loopback;
    // Set once a remote peer has authenticated; deregisters itself on every exit path.
    let mut device: Option<LiveConn> = None;
    let deadline = Instant::now() + AUTH_DEADLINE;

    let pty = app.state::<Arc<PtyManager>>().inner().clone();
    let bus = app.state::<Arc<HookBus>>().inner().clone();
    // Hook events are subscribed only once the peer is trusted (loopback: now), so an
    // unauthenticated socket holds no bus slot.
    let mut bus_sub = authed.then(|| bus.subscribe());

    // (session_id, subscription id, frame receiver) once attached.
    let mut attached: Option<(String, u64, std::sync::mpsc::Receiver<String>)> = None;
    // (transcript path, lines already sent) — set on attach, advanced while tailing.
    let mut transcript: Option<(PathBuf, usize)> = None;
    // Transcript of the attached session when it is a Claude one (the only agent with a
    // context meter), and when the next `context` frame is due.
    let mut context_path: Option<PathBuf> = None;
    let mut next_context = Instant::now();
    // A `discover` probe's reply, produced on its own thread. One probe at a time.
    let (macs_tx, macs_rx) = std::sync::mpsc::channel::<String>();
    let mut discovering = false;
    // The phone's Tailscale user id, from one `whois` the first time it is needed.
    let peer_owner: Arc<OnceLock<Option<u64>>> = Arc::new(OnceLock::new());

    loop {
        // 0. Gates: an unauthenticated peer gets AUTH_DEADLINE; a revoked device is
        //    closed on the next tick rather than at its next reconnect.
        if !authed && Instant::now() >= deadline {
            break;
        }
        if device.as_ref().is_some_and(LiveConn::revoked) {
            let _ = ws.close(None);
            let _ = ws.flush();
            break;
        }

        // 1. Read a control message if one is ready (times out quickly otherwise).
        match ws.read() {
            Ok(Message::Text(text)) if !authed => {
                // Belt and braces with the handshake's WebSocketConfig cap.
                if text.len() > PREAUTH_MAX_BYTES {
                    break;
                }
                // (device id, came from `auth` -- which is acked with `authOk`).
                let newly_authed = match parse_client_msg(&text) {
                    Some(ClientMsg::Auth { token }) => match ctrl.authenticate(peer, &token) {
                        Some(id) => Some((id, true)),
                        None => {
                            let _ = ws.send(Message::Text(unauthorized().to_string()));
                            let _ = ws.close(None);
                            let _ = ws.flush();
                            break;
                        }
                    },
                    Some(ClientMsg::Pair {
                        secret,
                        request,
                        device_name,
                        nonce,
                    }) => {
                        let paired = pair_flow(
                            &ctrl,
                            &app,
                            &mut ws,
                            peer,
                            secret,
                            request.unwrap_or(false),
                            &device_name,
                            &nonce,
                        );
                        match paired {
                            Some(id) => Some((id, false)),
                            None => {
                                let _ = ws.close(None);
                                let _ = ws.flush();
                                break;
                            }
                        }
                    }
                    // Listing Macs is for paired phones only.
                    Some(ClientMsg::Discover) => {
                        let _ = ws.send(Message::Text(unauthorized().to_string()));
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        break;
                    }
                    // Anything else before auth ends the connection.
                    _ => break,
                };
                if let Some((id, via_auth)) = newly_authed {
                    let conn = LiveConn::register(&ctrl, id);
                    // Close the verify->register window: a revoke (or the switch going
                    // off) that landed in between found no live entry to flag.
                    if !ctrl.still_admitted(&conn.device_id) {
                        let _ = ws.send(Message::Text(unauthorized().to_string()));
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        break;
                    }
                    if via_auth {
                        let ok = auth_ok_payload(&conn.device_id);
                        if ws.send(Message::Text(ok.to_string())).is_err() {
                            break;
                        }
                    }
                    device = Some(conn);
                    authed = true;
                    lift_preauth_cap(&mut ws);
                    bus_sub = Some(bus.subscribe());
                }
            }
            // Binary (or anything but text/ping/pong/close) pre-auth: not a phone.
            Ok(Message::Binary(_)) if !authed => break,
            Ok(Message::Text(text)) => match parse_client_msg(&text) {
                Some(ClientMsg::List) => {
                    // Typed, whitelisted tree (see `bridge_view`); never the raw `Project`s.
                    let running: HashSet<String> = pty.session_ids().into_iter().collect();
                    // Store is managed as Arc<Store> (lib.rs .manage(Arc::new(Store::new()))) —
                    // state::<Store>() panics the connection thread on the first `list`.
                    let store = app.state::<Arc<Store>>();
                    let fleet = app.state::<Arc<crate::fleet::FleetState>>().snapshot();
                    let asks = app.state::<Arc<crate::asks::Asks>>().pending();
                    let view = crate::bridge_view::projects_view(
                        &store.list(),
                        &store.list_profiles(),
                        store.active_profile().as_deref(),
                        &fleet,
                        &running,
                        &asks,
                    );
                    let _ = ws.send(Message::Text(view.to_string()));
                }
                Some(ClientMsg::Attach { session_id }) => {
                    // Auto-wake: an idle session has no live PTY (Conduit spawns it
                    // lazily when its tab is shown). Ask the desktop to open it, then
                    // poll briefly for the PTY to come up before giving up — so
                    // `/conduit use` works on ANY session, not just running ones.
                    let mut sub = pty.subscribe(&session_id);
                    if sub.is_none() {
                        wake_session(&app, &session_id);
                        for _ in 0..25 {
                            std::thread::sleep(Duration::from_millis(200));
                            sub = pty.subscribe(&session_id);
                            if sub.is_some() {
                                break;
                            }
                        }
                    }
                    if let Some((sub_id, rx)) = sub {
                        // Desktop-authoritative sizing: tell the new viewer the PTY's
                        // current size so it renders at the desktop's dimensions rather
                        // than resizing the shared TTY out from under the desktop.
                        if let Some((cols, rows)) = pty.session_size(&session_id) {
                            let _ = ws.send(Message::Text(
                                json!({ "type": "size", "cols": cols, "rows": rows }).to_string(),
                            ));
                        }
                        // Transcript backfill (chat history) + start tailing for appends.
                        // Keyed by the session's CURRENT conversation, which a `/clear`
                        // moves off the pinned id (see `Store::claude_conversation_id`).
                        let store = app.state::<Arc<Store>>();
                        let conversation = store.claude_conversation_id(&session_id);
                        transcript = None;
                        context_path = None;
                        if let Some(dir) = crate::pty::session_projects_dir(&store, &session_id) {
                            if let Some(path) = crate::pty::transcript_path(&conversation, &dir) {
                                let lines = read_lines(&path);
                                let _ = ws.send(Message::Text(history_payload(&lines).to_string()));
                                transcript = Some((path.clone(), lines.len()));
                                if is_claude(&store, &session_id) {
                                    context_path = Some(path);
                                }
                            }
                        }
                        // Re-attach: release the subscription this socket already held.
                        if let Some((old_sid, old_sub)) = crate::bridge_view::replace_attached(
                            &mut attached,
                            (session_id.clone(), sub_id, rx),
                        ) {
                            pty.unsubscribe(&old_sid, old_sub);
                        }
                        next_context = Instant::now();
                    } else {
                        let _ = ws.send(Message::Text(
                            json!({ "type": "error", "message": "no such session" }).to_string(),
                        ));
                    }
                }
                Some(ClientMsg::Input { session_id, data }) => {
                    let _ = pty.write(&session_id, &data);
                }
                Some(ClientMsg::Resize {
                    session_id,
                    cols,
                    rows,
                }) => {
                    let _ = pty.resize(&session_id, cols, rows);
                }
                Some(ClientMsg::Git {
                    session_id,
                    action,
                    path,
                }) => {
                    let reply = git_reply(&app, &session_id, &action, path.as_deref());
                    let _ = ws.send(Message::Text(reply.to_string()));
                }
                Some(ClientMsg::Kill { session_id }) => {
                    pty.kill(&session_id);
                    let _ = ws.send(Message::Text(
                        json!({ "type": "killed", "sessionId": session_id }).to_string(),
                    ));
                }
                Some(ClientMsg::Spawn {
                    project_id,
                    prompt,
                    agent,
                    worktree,
                }) => {
                    let reply = spawn_reply(&app, &project_id, &prompt, agent.as_deref(), worktree);
                    let _ = ws.send(Message::Text(reply.to_string()));
                }
                Some(ClientMsg::Interrupt { session_id }) => {
                    // Esc is Claude's interrupt key (spec §6 "Stop").
                    let _ = pty.write(&session_id, "\x1b");
                }
                // Pairing again from a trusted socket: only loopback (the simulator) may,
                // since a parked wait would also park a remote device's revoke check.
                Some(ClientMsg::Pair {
                    secret,
                    request,
                    device_name,
                    nonce,
                }) => {
                    if loopback {
                        let _ = pair_flow(
                            &ctrl,
                            &app,
                            &mut ws,
                            peer,
                            secret,
                            request.unwrap_or(false),
                            &device_name,
                            &nonce,
                        );
                    } else {
                        let _ = ws.send(Message::Text(unauthorized().to_string()));
                    }
                }
                // Probe the tailnet off this thread; the reply arrives via `macs_rx`. Only
                // a phone owned by this Mac's Tailscale user may see the owner's Macs; its
                // owner is looked up once per connection (loopback is the owner).
                Some(ClientMsg::Discover) => {
                    if !discovering {
                        discovering = true;
                        let (tx, owner) = (macs_tx.clone(), peer_owner.clone());
                        thread::spawn(move || {
                            let reply = pairing::discover_macs(|self_user| {
                                if loopback {
                                    Some(self_user)
                                } else {
                                    *owner.get_or_init(|| tailscale::whois(peer).map(|w| w.user_id))
                                }
                            });
                            let _ = tx.send(reply.to_string());
                        });
                    }
                }
                // Already authenticated (or loopback): a repeat `auth` changes nothing.
                Some(ClientMsg::Auth { .. }) | None => {}
            },
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break,
        }

        // 2. Flush any buffered PTY output for the attached session.
        if let Some((_, _, rx)) = attached.as_ref() {
            for _ in 0..DRAIN_PER_TICK {
                match rx.try_recv() {
                    Ok(frame) => {
                        if ws
                            .send(Message::Text(
                                json!({ "type": "output", "data": frame }).to_string(),
                            ))
                            .is_err()
                        {
                            unsubscribe_bus(&bus, &mut bus_sub);
                            detach(&pty, &attached);
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
        }

        // 2b. A finished `discover` probe.
        if let Ok(macs) = macs_rx.try_recv() {
            discovering = false;
            if ws.send(Message::Text(macs)).is_err() {
                break;
            }
        }

        // 3. Forward hook status events (filtered to the attached session).
        let Some((bus_id, bus_rx)) = bus_sub.as_ref() else {
            continue; // not trusted yet: no bus subscription, nothing attached
        };
        if let Some((sid, _, _)) = attached.as_ref() {
            for _ in 0..DRAIN_PER_TICK {
                match bus_rx.try_recv() {
                    Ok(ev) if &ev.session == sid => {
                        if ws
                            .send(Message::Text(
                                status_payload(&ev.event, &ev.body).to_string(),
                            ))
                            .is_err()
                        {
                            bus.unsubscribe(*bus_id);
                            detach(&pty, &attached);
                            return;
                        }
                    }
                    Ok(_) => {} // event for another session; ignore
                    Err(_) => break,
                }
            }
        } else {
            // Not attached: drain-and-discard so the bus buffer can't back up.
            while bus_rx.try_recv().is_ok() {}
        }

        // 5. Context meter for the attached session: on attach, then every CONTEXT_EVERY.
        if let (Some((sid, _, _)), Some(path)) = (attached.as_ref(), context_path.as_ref()) {
            if Instant::now() >= next_context {
                next_context = Instant::now() + CONTEXT_EVERY;
                if let Some(u) = crate::context_window::for_transcript(path) {
                    let frame = crate::bridge_view::context_frame(sid, &u);
                    let _ = ws.send(Message::Text(frame.to_string()));
                }
            }
        }

        // 4. Tail the transcript for appended lines -> chat items.
        if let Some((path, cursor)) = transcript.as_mut() {
            let lines = read_lines(path);
            if lines.len() > *cursor {
                for line in &lines[*cursor..] {
                    for item in crate::transcript::parse_line(line) {
                        let _ = ws.send(Message::Text(
                            json!({ "type": "chat", "item": item }).to_string(),
                        ));
                    }
                }
                *cursor = lines.len();
            }
        }
    }

    unsubscribe_bus(&bus, &mut bus_sub);
    detach(&pty, &attached);
}

fn unsubscribe_bus(
    bus: &Arc<HookBus>,
    sub: &mut Option<(u64, std::sync::mpsc::Receiver<crate::hookbus::HookEvent>)>,
) {
    if let Some((id, _)) = sub.take() {
        bus.unsubscribe(id);
    }
}

/// An authenticated remote connection's entry in the controller's live map. Dropping it
/// (any way `handle_conn` ends) removes the entry, so a later revoke is a no-op.
struct LiveConn {
    ctrl: Arc<BridgeController>,
    device_id: String,
    flag: Arc<AtomicBool>,
}

impl LiveConn {
    fn register(ctrl: &Arc<BridgeController>, device_id: String) -> Self {
        let flag = ctrl.register_live(&device_id);
        Self {
            ctrl: ctrl.clone(),
            device_id,
            flag,
        }
    }

    fn revoked(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

impl Drop for LiveConn {
    fn drop(&mut self) {
        self.ctrl.unregister_live(&self.device_id, &self.flag);
    }
}

/// Whether a session runs the Claude adapter (the only one with a transcript context meter).
fn is_claude(store: &Store, session_id: &str) -> bool {
    store
        .list()
        .iter()
        .flat_map(|p| p.sessions.iter())
        .find(|s| s.id == session_id)
        .is_some_and(|s| s.agent == crate::agent::AgentId::Claude)
}

fn detach(
    pty: &Arc<PtyManager>,
    attached: &Option<(String, u64, std::sync::mpsc::Receiver<String>)>,
) {
    if let Some((session_id, sub_id, _)) = attached {
        pty.unsubscribe(session_id, *sub_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted_keys(v: &serde_json::Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    #[test]
    fn pair_prompts_capped_per_peer() {
        let prompts = Mutex::new(HashMap::new());
        let a: IpAddr = "100.64.0.2".parse().unwrap();
        let b: IpAddr = "100.64.0.3".parse().unwrap();
        for i in 0..PAIR_PROMPTS_MAX {
            assert!(take_prompt_slot(&prompts, a), "prompt {} allowed", i + 1);
        }
        assert!(
            !take_prompt_slot(&prompts, a),
            "6th prompt in the window refused"
        );
        assert!(take_prompt_slot(&prompts, b), "another IP is unaffected");
        assert_eq!(PAIR_PROMPTS_MAX, 5);
        assert_eq!(PAIR_PROMPT_WINDOW, Duration::from_secs(600));
    }

    #[test]
    fn pair_result_ok_shape() {
        let v = pair_result_ok("tok", "dev-1");
        assert_eq!(sorted_keys(&v), ["deviceId", "ok", "token", "type"]);
        assert_eq!(v["type"], "pairResult");
        assert_eq!(v["ok"], true);
        assert_eq!(v["token"], "tok");
        assert_eq!(v["deviceId"], "dev-1");
    }

    #[test]
    fn pair_result_err_shape() {
        let v = pair_result_err("declined");
        assert_eq!(sorted_keys(&v), ["ok", "reason", "type"]);
        assert_eq!(v["type"], "pairResult");
        assert_eq!(v["ok"], false);
        assert_eq!(v["reason"], "declined");
    }

    #[test]
    fn pair_pending_shape() {
        let v = pair_pending("req-1");
        assert_eq!(sorted_keys(&v), ["requestId", "type"]);
        assert_eq!(v["type"], "pairPending");
        assert_eq!(v["requestId"], "req-1");
    }

    #[test]
    fn status_message_shape() {
        let msg = status_payload("pretool", &serde_json::json!({ "tool_name": "Bash" }));
        assert_eq!(msg["type"], "status");
        assert_eq!(msg["event"], "pretool");
        assert_eq!(msg["body"]["tool_name"], "Bash");
    }

    #[test]
    fn history_payload_flattens_items() {
        let lines = vec![
            serde_json::json!({"type":"user","message":{"role":"user","content":"hi"}}).to_string(),
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"yo"}]}})
                .to_string(),
        ];
        let msg = history_payload(&lines);
        assert_eq!(msg["type"], "history");
        assert_eq!(msg["items"].as_array().unwrap().len(), 2);
        assert_eq!(msg["items"][0]["role"], "user");
    }

    #[test]
    fn parses_list() {
        assert_eq!(
            parse_client_msg(r#"{"type":"list"}"#),
            Some(ClientMsg::List)
        );
    }

    #[test]
    fn parses_attach() {
        assert_eq!(
            parse_client_msg(r#"{"type":"attach","session_id":"s1"}"#),
            Some(ClientMsg::Attach {
                session_id: "s1".into()
            })
        );
    }

    #[test]
    fn parses_input_raw_string() {
        assert_eq!(
            parse_client_msg(r#"{"type":"input","session_id":"s1","data":"ls\r"}"#),
            Some(ClientMsg::Input {
                session_id: "s1".into(),
                data: "ls\r".into()
            })
        );
    }

    #[test]
    fn parses_resize() {
        assert_eq!(
            parse_client_msg(r#"{"type":"resize","session_id":"s1","cols":80,"rows":24}"#),
            Some(ClientMsg::Resize {
                session_id: "s1".into(),
                cols: 80,
                rows: 24
            })
        );
    }

    #[test]
    fn rejects_garbage_and_unknown_type() {
        assert!(parse_client_msg("not json").is_none());
        assert!(parse_client_msg(r#"{"type":"explode"}"#).is_none());
    }

    #[test]
    fn parses_kill_and_spawn() {
        assert_eq!(
            parse_client_msg(r#"{"type":"kill","session_id":"s1"}"#),
            Some(ClientMsg::Kill {
                session_id: "s1".into()
            })
        );
        assert_eq!(
            parse_client_msg(
                r#"{"type":"spawn","project_id":"p1","prompt":"fix the bug","worktree":true}"#
            ),
            Some(ClientMsg::Spawn {
                project_id: "p1".into(),
                prompt: "fix the bug".into(),
                agent: None,
                worktree: true,
            })
        );
    }

    #[test]
    fn parses_git_changes_and_diff() {
        assert_eq!(
            parse_client_msg(r#"{"type":"git","session_id":"s1","action":"changes"}"#),
            Some(ClientMsg::Git {
                session_id: "s1".into(),
                action: "changes".into(),
                path: None,
            })
        );
        assert_eq!(
            parse_client_msg(
                r#"{"type":"git","session_id":"s1","action":"diff","path":"src/a.ts"}"#
            ),
            Some(ClientMsg::Git {
                session_id: "s1".into(),
                action: "diff".into(),
                path: Some("src/a.ts".into()),
            })
        );
    }

    // ---- Plan 2 / Task 3: listeners, hello, auth, revoke ----

    fn running(ip: Option<Ipv4Addr>) -> TailscaleState {
        TailscaleState::Running {
            tailnet: "t".into(),
            self_name: "mac".into(),
            dns_name: "mac.t.ts.net".into(),
            ipv4: ip,
            ipv6: None,
            user_id: 1,
        }
    }

    const A: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 1);
    const B: Ipv4Addr = Ipv4Addr::new(100, 100, 7, 9);

    #[test]
    fn rebind_plan_follows_ip_change() {
        // Tailscale restarted with a new address: close the stale listener AND bind the new.
        assert_eq!(
            plan_listeners(true, &running(Some(B)), Some(A)),
            ListenerPlan {
                bind: Some(B),
                close: true
            }
        );
        // Nothing bound yet: bind, nothing to close.
        assert_eq!(
            plan_listeners(true, &running(Some(A)), None),
            ListenerPlan {
                bind: Some(A),
                close: false
            }
        );
    }

    #[test]
    fn plan_closes_when_disabled() {
        assert_eq!(
            plan_listeners(false, &running(Some(A)), Some(A)),
            ListenerPlan {
                bind: None,
                close: true
            }
        );
        assert_eq!(
            plan_listeners(false, &running(Some(A)), None),
            ListenerPlan {
                bind: None,
                close: false
            }
        );
    }

    #[test]
    fn plan_closes_when_tailscale_stops() {
        for ts in [
            TailscaleState::Stopped,
            TailscaleState::NeedsLogin,
            TailscaleState::NotInstalled,
            running(None),
        ] {
            assert_eq!(
                plan_listeners(true, &ts, Some(A)),
                ListenerPlan {
                    bind: None,
                    close: true
                },
                "{ts:?}"
            );
        }
    }

    #[test]
    fn unknown_keeps_current_binding() {
        let unknown = TailscaleState::Unknown {
            reason: "tailscale timed out".into(),
        };
        let noop = ListenerPlan {
            bind: None,
            close: false,
        };
        // One unreadable status neither drops a bound listener nor opens a new one.
        assert_eq!(plan_listeners(true, &unknown, Some(A)), noop);
        assert_eq!(plan_listeners(true, &unknown, None), noop);
        // ...but the switch going off still closes it.
        assert_eq!(
            plan_listeners(false, &unknown, Some(A)),
            ListenerPlan {
                bind: None,
                close: true
            }
        );
    }

    #[test]
    fn plan_refuses_non_tailnet_ip() {
        for ip in [Ipv4Addr::UNSPECIFIED, Ipv4Addr::new(192, 168, 1, 5)] {
            assert_eq!(
                plan_listeners(true, &running(Some(ip)), None),
                ListenerPlan {
                    bind: None,
                    close: false
                },
                "{ip}"
            );
            assert_eq!(
                plan_listeners(true, &running(Some(ip)), Some(A)),
                ListenerPlan {
                    bind: None,
                    close: true
                },
                "{ip}"
            );
        }
    }

    #[test]
    fn auth_ok_shape() {
        assert_eq!(
            auth_ok_payload("dev-1"),
            serde_json::json!({ "type": "authOk", "deviceId": "dev-1" })
        );
    }

    #[test]
    fn registration_rechecks_device_and_switch() {
        let path =
            std::env::temp_dir().join(format!("conduit-bridge-{}.json", uuid::Uuid::new_v4()));
        let devices = Arc::new(MobileDevices::load(path));
        let c = BridgeController::new(devices.clone());
        let (d, _token) = devices.add_device("phone", None).unwrap();
        assert!(!c.still_admitted(&d.id), "mobile access is off");
        devices.set_enabled(true).unwrap();
        assert!(c.still_admitted(&d.id));
        devices.revoke(&d.id).unwrap();
        assert!(
            !c.still_admitted(&d.id),
            "revoked between verify and register"
        );
    }

    #[test]
    fn plan_noop_when_unchanged() {
        assert_eq!(
            plan_listeners(true, &running(Some(A)), Some(A)),
            ListenerPlan {
                bind: None,
                close: false
            }
        );
        assert_eq!(
            plan_listeners(true, &TailscaleState::Stopped, None),
            ListenerPlan {
                bind: None,
                close: false
            }
        );
    }

    #[test]
    fn pick_port_prefers_persisted() {
        assert_eq!(pick_port(Some(8460), |_| true), Some(8460));
        // Persisted but taken: first free in range.
        assert_eq!(pick_port(Some(8460), |p| p != 8460), Some(8455));
        // Nothing persisted.
        assert_eq!(pick_port(None, |_| true), Some(8455));
        // A persisted port outside the range is not trusted.
        assert_eq!(pick_port(Some(8475), |_| true), Some(8455));
    }

    #[test]
    fn pick_port_skips_taken_and_8475_is_out_of_range() {
        assert_eq!(pick_port(None, |p| p >= 8458), Some(8458));
        // 8475 belongs to fleet MCP: never offered even when everything below is taken.
        assert_eq!(pick_port(None, |p| p >= 8474), Some(8474));
        assert_eq!(pick_port(None, |p| p >= 8475), None);
        assert_eq!(BRIDGE_PORTS, 8455..=8474);
    }

    #[test]
    fn origin_header_is_refused() {
        let with = Request::builder()
            .uri("/")
            .header("Origin", "http://evil.example")
            .body(())
            .unwrap();
        let without = Request::builder().uri("/").body(()).unwrap();
        assert!(has_origin(&with));
        assert!(!has_origin(&without));

        // Real socket: a browser-shaped handshake to loopback gets 403, not a WebSocket.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            accept_ws(s, false).is_some()
        });
        let mut req =
            tungstenite::client::IntoClientRequest::into_client_request(format!("ws://{addr}/"))
                .unwrap();
        req.headers_mut()
            .insert("Origin", "http://evil.example".parse().unwrap());
        let stream = TcpStream::connect(addr).unwrap();
        match tungstenite::client(req, stream) {
            Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(resp))) => {
                assert_eq!(resp.status(), StatusCode::FORBIDDEN)
            }
            other => panic!("expected 403, got {:?}", other.map(|_| ())),
        }
        assert!(
            !server.join().unwrap(),
            "server must not complete the upgrade"
        );
    }

    #[test]
    fn client_msg_debug_redacts_secrets() {
        let a = format!(
            "{:?}",
            ClientMsg::Auth {
                token: "abc123".into()
            }
        );
        assert!(!a.contains("abc123"), "{a}");
        let p = format!(
            "{:?}",
            ClientMsg::Pair {
                secret: Some("sekret9".into()),
                request: None,
                device_name: "Pixel".into(),
                nonce: "nonce77".into(),
            }
        );
        assert!(!p.contains("sekret9") && !p.contains("nonce77"), "{p}");
        assert!(p.contains("Pixel"));
    }

    #[test]
    fn handshake_has_one_overall_deadline() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            // Per-read timeout is generous; only the overall deadline can end this.
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let t = std::time::Instant::now();
            let ok = accept_ws_within(s, true, Duration::from_millis(400)).is_some();
            (ok, t.elapsed())
        });
        let mut c = TcpStream::connect(addr).unwrap();
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_millis(2500) {
            if c.write_all(b"G").is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let (ok, took) = server.join().unwrap();
        assert!(!ok);
        assert!(took < Duration::from_millis(2000), "took {took:?}");
    }

    #[test]
    fn preauth_frame_over_4k_is_refused() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut ws = accept_ws(s, true).expect("handshake");
            let small = ws.read().map(|m| m.into_text().unwrap_or_default());
            let big = ws.read();
            (small.ok(), big.is_err())
        });
        let stream = TcpStream::connect(addr).unwrap();
        let (mut client, _) = tungstenite::client(format!("ws://{addr}/"), stream).unwrap();
        client.send(Message::Text("x".repeat(100))).unwrap();
        let _ = client.send(Message::Text("y".repeat(PREAUTH_MAX_BYTES + 1)));
        let (small, big_refused) = server.join().unwrap();
        assert_eq!(small.as_deref().map(str::len), Some(100));
        assert!(big_refused);
    }

    #[test]
    fn mac_name_prefers_tailscale_then_system_then_conduit() {
        assert_eq!(mac_name_from(&running(Some(A)), Some("Sys".into())), "mac");
        assert_eq!(
            mac_name_from(&TailscaleState::Stopped, Some(" Sys\n".into())),
            "Sys"
        );
        assert_eq!(mac_name_from(&TailscaleState::Stopped, None), "Conduit");
    }

    #[test]
    fn hello_shape() {
        let h = hello_payload("Uzair's MacBook", "0.50.0");
        assert_eq!(
            h,
            serde_json::json!({
                "type": "hello",
                "macName": "Uzair's MacBook",
                "conduitVersion": "0.50.0",
                "protocolVersion": 1,
            })
        );
    }

    #[test]
    fn parses_auth_pair_discover_interrupt() {
        assert_eq!(
            parse_client_msg(r#"{"type":"auth","token":"abc"}"#),
            Some(ClientMsg::Auth {
                token: "abc".into()
            })
        );
        assert_eq!(
            parse_client_msg(r#"{"type":"pair","secret":"s3","deviceName":"iPhone","nonce":"n1"}"#),
            Some(ClientMsg::Pair {
                secret: Some("s3".into()),
                request: None,
                device_name: "iPhone".into(),
                nonce: "n1".into(),
            })
        );
        assert_eq!(
            parse_client_msg(r#"{"type":"pair","request":true,"deviceName":"iPad","nonce":"n2"}"#),
            Some(ClientMsg::Pair {
                secret: None,
                request: Some(true),
                device_name: "iPad".into(),
                nonce: "n2".into(),
            })
        );
        // snake_case is NOT the wire spelling for the new messages.
        assert!(
            parse_client_msg(r#"{"type":"pair","secret":"s","device_name":"x","nonce":"n"}"#)
                .is_none()
        );
        assert_eq!(
            parse_client_msg(r#"{"type":"discover"}"#),
            Some(ClientMsg::Discover)
        );
        assert_eq!(
            parse_client_msg(r#"{"type":"interrupt","sessionId":"s1"}"#),
            Some(ClientMsg::Interrupt {
                session_id: "s1".into()
            })
        );
        assert!(parse_client_msg(r#"{"type":"interrupt","session_id":"s1"}"#).is_none());
    }

    fn controller() -> BridgeController {
        let path =
            std::env::temp_dir().join(format!("conduit-bridge-{}.json", uuid::Uuid::new_v4()));
        BridgeController::new(Arc::new(MobileDevices::load(path)))
    }

    #[test]
    fn revoke_flags_live_connection() {
        let c = controller();
        let d1 = c.register_live("d1");
        let d1b = c.register_live("d1");
        let d2 = c.register_live("d2");
        c.disconnect_device("d1");
        assert!(d1.load(Ordering::SeqCst));
        assert!(
            d1b.load(Ordering::SeqCst),
            "every socket of the device closes"
        );
        assert!(!d2.load(Ordering::SeqCst), "other devices stay connected");
        // A connection that ends on its own deregisters; revoking later is a no-op.
        c.unregister_live("d2", &d2);
        c.disconnect_device("d2");
        assert!(!d2.load(Ordering::SeqCst));
    }

    #[test]
    fn closing_remote_access_disconnects_every_device() {
        let c = controller();
        let a = c.register_live("d1");
        let b = c.register_live("d2");
        c.disconnect_all_devices();
        assert!(a.load(Ordering::SeqCst) && b.load(Ordering::SeqCst));
    }

    #[test]
    fn failed_auth_is_rate_limited_per_ip() {
        let c = controller();
        let ip: IpAddr = "100.64.0.9".parse().unwrap();
        let other: IpAddr = "100.64.0.10".parse().unwrap();
        for _ in 0..AUTH_FAILURES_MAX {
            assert!(c.auth_allowed(ip));
            c.record_auth_failure(ip);
        }
        assert!(!c.auth_allowed(ip));
        assert!(c.auth_allowed(other));
    }
}
