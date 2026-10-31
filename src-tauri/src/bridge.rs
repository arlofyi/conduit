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
//!   before the handshake, and a handshake whose `Origin` is not this listener itself is
//!   refused with 403 (a web page on the Mac must never reach the bridge; the iOS app's
//!   socket always sends its own dialled origin, see [`origin_allowed`]).
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
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::ops::RangeInclusive;
use std::path::PathBuf;
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

use crate::asks::{AskGate, AskView, Asks};
use crate::bridge_view::read_lines;
use crate::broker::{Broker, PermissionView};
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
    /// Answer a pending `AskUserQuestion` (an `ask` item from `pending`/`pendingAdded`):
    /// exact question texts as keys. First answer wins; acked with `answerResult`.
    #[serde(rename_all = "camelCase")]
    Answer {
        ask_id: String,
        answers: serde_json::Map<String, serde_json::Value>,
    },
    /// Decide a pending tool permission (a `permission` item from `pending`/`pendingAdded`).
    /// First decision wins; acked with `approveResult`.
    Approve {
        id: String,
        allow: bool,
    },
    /// A file for a session (photo, camera shot, document): `data` is the base64 body.
    /// Written into the session's `.conduit-uploads/` and acked with `uploadResult`
    /// carrying the same `requestId` (see `uploads.rs`).
    #[serde(rename_all = "camelCase")]
    Upload {
        session_id: String,
        request_id: String,
        name: String,
        data: String,
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
            // What the user typed stays out of logs; how many answers is enough to debug.
            Self::Answer { ask_id, answers } => f
                .debug_struct("Answer")
                .field("ask_id", ask_id)
                .field("answers", &answers.len())
                .finish(),
            Self::Approve { id, allow } => f
                .debug_struct("Approve")
                .field("id", id)
                .field("allow", allow)
                .finish(),
            // The body is megabytes of base64; its length is what a log needs.
            Self::Upload {
                session_id,
                request_id,
                name,
                data,
            } => f
                .debug_struct("Upload")
                .field("session_id", session_id)
                .field("request_id", request_id)
                .field("name", name)
                .field("data", &data.len())
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

/// How often a connection diffs the pending questions against what it has pushed.
const PUSH_EVERY: Duration = Duration::from_millis(250);
/// How often a connection re-checks that the session it streams has not been made private.
const PRIVATE_RECHECK_EVERY: Duration = Duration::from_secs(1);
/// How often an authenticated remote connection is pinged. A phone answers with a pong
/// from its socket layer, so a live but quiet phone still reads as heard from.
const PING_EVERY: Duration = Duration::from_secs(15);
/// A remote connection that has read nothing (no frame, no pong) for this long is dropped.
/// iOS suspends a backgrounded app and a dropped network leaves the socket half-open; with
/// nothing to write, the Mac would otherwise never notice, and the phone would keep holding
/// every question it was sent (`has_remote_phone`) while the terminal showed nothing.
const STALE_AFTER: Duration = Duration::from_secs(35);
/// A write that has not completed in this long fails, which ends the connection. A frozen
/// or wedged phone stops reading while its kernel keeps the socket open (zero window), so
/// an unbounded write blocks the loop forever: it never reaches the [`STALE_AFTER`] check,
/// and the phone keeps holding questions until the hook's own ceiling. Shorter than
/// `STALE_AFTER` so a stalled write is noticed no later than a silent read would be.
const WRITE_STALL: Duration = Duration::from_secs(10);

/// Bound every write on a bridge socket (see [`WRITE_STALL`]).
fn bound_writes(stream: &TcpStream, stall: Duration) -> std::io::Result<()> {
    stream.set_write_timeout(Some(stall))
}

/// Has a connection last heard from at `last_read` gone silent for good?
fn conn_is_stale(last_read: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_read) >= STALE_AFTER
}

/// Is the next keepalive ping due?
fn ping_due(last_ping: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_ping) >= PING_EVERY
}

/// Does a failed `send` end the connection? An I/O error does -- above all the
/// `TimedOut`/`WouldBlock` that [`WRITE_STALL`] produces: on Windows a timed-out send leaves
/// the socket in an indeterminate state, and tungstenite would retry the half-written frame
/// on the next send, corrupting the stream. A closed socket does too. Only a refusal of THIS
/// frame (too large, buffer full) leaves the socket usable.
fn send_failure_is_fatal(e: &tungstenite::Error) -> bool {
    matches!(
        e,
        tungstenite::Error::Io(_)
            | tungstenite::Error::ConnectionClosed
            | tungstenite::Error::AlreadyClosed
    )
}

/// Send one text frame. `false` = the connection is finished (see [`send_failure_is_fatal`]);
/// the caller breaks its loop rather than writing to it again.
fn send_text(ws: &mut WebSocket<TcpStream>, text: String) -> bool {
    match ws.send(Message::Text(text)) {
        Ok(()) => true,
        Err(e) => !send_failure_is_fatal(&e),
    }
}

/// Is raw PTY `output` streamed to this socket? Only to loopback (the matrix sidecar and the
/// Simulator's terminal view). The phone app renders the transcript, never raw output, and
/// a TUI spinner repaints at ~19 KB/s -- ~70 MB per working hour of cellular data for
/// nothing, and the bulk that filled a frozen phone's window.
fn streams_raw_output(remote_device: bool) -> bool {
    !remote_device
}

/// How long a phone-spawned Claude session may go without its `sessionstart` hook before the
/// phone is told it is waiting on the Mac. Claude asks "do you trust this folder?" before it
/// runs any hook, and the phone cannot answer that prompt.
const TRUST_STALL: Duration = Duration::from_secs(20);

/// The phone-spawned Claude sessions this socket is waiting to hear `sessionstart` from.
#[derive(Default)]
struct SpawnWatch {
    waiting: Vec<(String, Instant)>,
}

impl SpawnWatch {
    fn watch(&mut self, session_id: String, at: Instant) {
        self.waiting.push((session_id, at));
    }

    /// The session's `sessionstart` arrived: it is running, nothing to say.
    fn started(&mut self, session_id: &str) {
        self.waiting.retain(|(s, _)| s != session_id);
    }

    /// Sessions silent for [`TRUST_STALL`]. Each is returned once, then forgotten.
    fn stalled(&mut self, now: Instant) -> Vec<String> {
        let (due, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.waiting)
            .into_iter()
            .partition(|(_, at)| now.saturating_duration_since(*at) >= TRUST_STALL);
        self.waiting = keep;
        due.into_iter().map(|(s, _)| s).collect()
    }
}

/// What the phone is told about a spawned session stuck before its first hook.
fn trust_stall_frame(session_id: &str) -> serde_json::Value {
    json!({
        "type": "error",
        "sessionId": session_id,
        "message": TRUST_STALL_MESSAGE,
    })
}

const TRUST_STALL_MESSAGE: &str =
    "Claude is waiting on your Mac \u{2014} open this folder there once to trust it";

/// May a phone's `answer` resolve this ask? Only a still-pending ask (None = someone else
/// already answered), never a private session's, and only a valid set of answers.
fn phone_may_answer(
    view: Option<&AskView>,
    private: bool,
    answers: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    view.is_some_and(|v| !private && crate::asks::validate_answers(&v.questions, answers).is_ok())
}

/// May a phone decide this permission? Only a still-pending one (None = already decided
/// elsewhere), and never a private session's.
fn phone_may_approve(view: Option<&PermissionView>, private: bool) -> bool {
    view.is_some() && !private
}

/// What a phone is sent when it tries to decide a private session's permission: the
/// session-tagged refusal every private request gets, then the `approveResult` that settles
/// its button.
fn approve_refusal(view: &PermissionView) -> Vec<serde_json::Value> {
    vec![
        crate::bridge_view::private_session_error(&view.session),
        crate::bridge_view::approve_result_frame(&view.id, false),
    ]
}

/// The attached session, if it has become private since it was attached (a phone must stop
/// streaming it). Checked on a ~1 s tick.
fn attached_now_private(attached: Option<&str>, is_private: impl Fn(&str) -> bool) -> Option<&str> {
    attached.filter(|sid| is_private(sid))
}

/// The attached session has been made private while streaming: unsubscribe its PTY stream,
/// drop the transcript tail and context meter, and return the (session-tagged) refusal to
/// send. None, with nothing touched, while it is still open.
fn stop_streaming_if_private<R>(
    attached: &mut Option<(String, u64, R)>,
    transcript: &mut Option<(PathBuf, usize)>,
    context_path: &mut Option<PathBuf>,
    tail_conversation: &mut Option<String>,
    attached_claude: &mut bool,
    is_private: impl Fn(&str) -> bool,
    unsubscribe: impl FnOnce(&str, u64),
) -> Option<serde_json::Value> {
    let sid = attached_now_private(attached.as_ref().map(|(s, _, _)| s.as_str()), is_private)?
        .to_string();
    if let Some((old_sid, old_sub)) =
        crate::bridge_view::clear_attachment(attached, transcript, context_path)
    {
        unsubscribe(&old_sid, old_sub);
    }
    *tail_conversation = None;
    *attached_claude = false;
    Some(crate::bridge_view::private_session_error(&sid))
}

/// How often the tail re-checks which transcript the attached session is writing (a
/// `/clear` moves it; a phone-spawned chat has none until its first turn).
const RESOLVE_EVERY: Duration = Duration::from_secs(1);
/// New sessions a phone may start in [`SPAWN_WINDOW`]. Each one is a real agent process on
/// the Mac, so a stuck button or a misbehaving client must not be able to start dozens.
const SPAWNS_MAX: usize = 10;
const SPAWN_WINDOW: Duration = Duration::from_secs(3600);
/// Longest session name derived from a phone's first message.
const SPAWN_NAME_MAX: usize = 40;

/// Build a forwarded hook-status frame for `session_id`.
fn status_payload(session_id: &str, event: &str, body: &serde_json::Value) -> serde_json::Value {
    json!({ "type": "status", "sessionId": session_id, "event": event, "body": body })
}

/// The session a client message acts on, if it is session-scoped. Private sessions are
/// refused on exactly these.
fn session_scope(msg: &ClientMsg) -> Option<&str> {
    match msg {
        ClientMsg::Attach { session_id }
        | ClientMsg::Input { session_id, .. }
        | ClientMsg::Resize { session_id, .. }
        | ClientMsg::Git { session_id, .. }
        | ClientMsg::Kill { session_id }
        | ClientMsg::Interrupt { session_id }
        | ClientMsg::Upload { session_id, .. } => Some(session_id),
        _ => None,
    }
}

/// Take one spawn slot for this phone (`key` = its device id, or the peer IP on loopback).
/// `false` = the budget is spent; start nothing.
/// Files a phone may send in [`UPLOAD_WINDOW`]. Each one is written into a session's checkout.
const UPLOADS_MAX: usize = 30;
const UPLOAD_WINDOW: Duration = Duration::from_secs(600);

/// The `uploadResult` frame for one `upload`: the path for the message, or why not.
fn upload_reply(
    session_dir: Option<String>,
    request_id: &str,
    name: &str,
    data: &str,
    allowed: bool,
) -> serde_json::Value {
    let result = match (session_dir, allowed) {
        (_, false) => {
            Err("Too many files sent in the last few minutes. Try again shortly.".to_string())
        }
        (None, _) => Err("That session no longer exists.".to_string()),
        (Some(dir), true) => {
            crate::uploads::save(std::path::Path::new(&dir), name, data).map_err(|e| e.to_string())
        }
    };
    match result {
        Ok(path) => {
            json!({ "type": "uploadResult", "requestId": request_id, "ok": true, "path": path })
        }
        Err(error) => {
            json!({ "type": "uploadResult", "requestId": request_id, "ok": false, "error": error })
        }
    }
}

fn take_spawn_slot(spawns: &Mutex<HashMap<String, VecDeque<Instant>>>, key: &str) -> bool {
    crate::fleet::rate_limited(spawns, key, SPAWNS_MAX, SPAWN_WINDOW)
}

/// The agent a `spawn` names, read STRICTLY: `AgentId`'s lenient `Deserialize` turns an
/// unknown id into Claude, which would start Claude under a name the phone never offered.
fn spawn_agent(agent: Option<&str>) -> Option<crate::agent::AgentId> {
    use crate::store::PersistedEnum;
    crate::agent::AgentId::from_wire(agent.unwrap_or("claude"))
}

/// A phone-started session's name: the first non-blank line of its first message, at most
/// [`SPAWN_NAME_MAX`] characters (an ellipsis marks a cut), else "Mobile".
fn spawn_session_name(prompt: &str) -> String {
    let Some(line) = prompt.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return "Mobile".to_string();
    };
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= SPAWN_NAME_MAX {
        return line;
    }
    let cut: String = line.chars().take(SPAWN_NAME_MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The reply when a phone has spent its spawn budget.
fn spawn_budget_error() -> serde_json::Value {
    json!({ "type": "error", "message": "too many new chats — try again later" })
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
    let Some(agent_id) = spawn_agent(agent) else {
        return json!({ "type": "error", "message": "unknown agent" });
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
        spawn_session_name(prompt),
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

/// Build the transcript backfill payload for `session_id` from raw jsonl lines.
fn history_payload(session_id: &str, lines: &[String]) -> serde_json::Value {
    let items: Vec<serde_json::Value> = lines
        .iter()
        .flat_map(|l| crate::transcript::parse_line(l))
        .collect();
    json!({ "type": "history", "sessionId": session_id, "items": items })
}

/// The generic failure reply. Identical for a wrong token, a revoked device, a bad or
/// spent pairing secret and a pre-auth `discover` -- no oracle.
fn unauthorized() -> serde_json::Value {
    json!({ "type": "error", "message": "unauthorized" })
}

/// Reply to an `auth` this Mac will not even check right now (peer rate-limited, or
/// mobile access off). Decided BEFORE the token is looked at, so it says nothing about
/// the token -- and it tells the phone not to forget a Mac that never judged its token.
fn unavailable() -> serde_json::Value {
    json!({ "type": "error", "message": "unavailable" })
}

/// What an `auth` frame gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthOutcome {
    Accepted,
    /// gates refused before the token was examined
    Unavailable,
    /// the token was examined and is not a paired device's
    Unauthorized,
}

/// The gates come first: `verified` only counts once the peer is under its rate limit
/// and mobile access is on. Callers must not run `verify` unless both pass.
fn auth_outcome(rate_ok: bool, enabled: bool, verified: bool) -> AuthOutcome {
    if !rate_ok || !enabled {
        AuthOutcome::Unavailable
    } else if verified {
        AuthOutcome::Accepted
    } else {
        AuthOutcome::Unauthorized
    }
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

/// May this upgrade's `Origin` reach the bridge? No `Origin` (the sidecar, any plain
/// client) is fine. The phone app DOES send one -- iOS's WebSocket (SocketRocket) always
/// sets it to the URL it dialled, `http://<host>:<port>`, and JS cannot remove it -- so an
/// Origin naming THIS listener is accepted too: the literal IP the socket arrived on
/// (`127.0.0.1` on loopback), or this Mac's own MagicDNS name on the tailnet address, each
/// with the bridge's own port. A browser only sends such an Origin for a page served from
/// that exact host and port, which is the bridge itself, and it serves no pages.
///
/// Never compared against the request's `Host`: under DNS rebinding an attacker's page
/// sends `Origin: http://evil.example:<port>` with a matching Host, so "Origin equals
/// Host" would admit exactly the web page this check exists to stop.
fn origin_allowed(origin: Option<&[u8]>, local: SocketAddr, own_dns: &str) -> bool {
    let Some(raw) = origin else {
        return true;
    };
    let Ok(o) = std::str::from_utf8(raw) else {
        return false;
    };
    let Some(rest) = o.strip_prefix("http://") else {
        return false;
    };
    let Some((host, port)) = rest.rsplit_once(':') else {
        return false; // the bridge never runs on 80, so its own origin always has a port
    };
    if port.parse::<u16>() != Ok(local.port()) {
        return false;
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = host.parse::<IpAddr>() {
        return ip == local.ip();
    }
    // `localhost` is NOT this listener: it is any process's origin on the Mac, and the phone
    // never dials it (the Simulator uses the literal 127.0.0.1).
    if local.ip().is_loopback() {
        return false;
    }
    let own = own_dns.trim_end_matches('.').to_ascii_lowercase();
    !own.is_empty() && host == own && tailscale::is_tailnet_addr(local.ip())
}

fn request_origin_allowed(req: &Request, local: SocketAddr, own_dns: &str) -> bool {
    let mut values = req
        .headers()
        .get_all(tungstenite::http::header::ORIGIN)
        .iter();
    match (values.next(), values.next()) {
        (None, _) => true,
        (Some(v), None) => origin_allowed(Some(v.as_bytes()), local, own_dns),
        (Some(_), Some(_)) => false, // two Origins: nothing honest sends that
    }
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

/// Accept a WebSocket. A foreign `Origin` is refused with 403 before the upgrade completes
/// (see [`origin_allowed`]).
/// `preauth_cap` limits frames and messages to [`PREAUTH_MAX_BYTES`] so an
/// unauthenticated peer cannot make us buffer megabytes; it is lifted on auth.
///
/// `result_large_err`: the Err type is tungstenite's `ErrorResponse`, whose shape the
/// handshake callback signature fixes for us. Boxing it is not an option -- the callback
/// must return exactly that type -- and this runs once per connection, not in a loop.
#[allow(clippy::result_large_err)]
fn accept_ws(stream: TcpStream, preauth_cap: bool, own_dns: &str) -> Option<WebSocket<TcpStream>> {
    accept_ws_within(stream, preauth_cap, own_dns, HANDSHAKE_TIMEOUT)
}

#[allow(clippy::result_large_err)]
fn accept_ws_within(
    stream: TcpStream,
    preauth_cap: bool,
    own_dns: &str,
    deadline: Duration,
) -> Option<WebSocket<TcpStream>> {
    let local = stream.local_addr().ok()?;
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        if !request_origin_allowed(req, local, own_dns) {
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
    /// This Mac's MagicDNS name ("" until Tailscale has reported one). An `Origin` naming
    /// it is the phone dialling us by name, see [`origin_allowed`].
    dns_name: Mutex<String>,
    /// The tailnet listener: its address and its accept loop's stop flag. Held across a
    /// whole reconcile, which serializes reconciles.
    tailnet: Mutex<Option<(Ipv4Addr, Arc<AtomicBool>)>>,
    /// Authenticated connections by device id; closing a slot closes that socket.
    live: Mutex<HashMap<String, Vec<Arc<LiveSlot>>>>,
    /// Failed auth attempts per peer IP (`fleet::rate_limited`'s map shape).
    auth_failures: Mutex<HashMap<String, VecDeque<Instant>>>,
    /// Pair prompts raised per peer IP (a budget separate from failures).
    pair_prompts: Mutex<HashMap<String, VecDeque<Instant>>>,
    /// New sessions started per phone (device id; peer IP on loopback).
    spawns: Mutex<HashMap<String, VecDeque<Instant>>>,
    /// Files sent per phone (same key as `spawns`).
    uploads: Mutex<HashMap<String, VecDeque<Instant>>>,
    /// Last-message previews for the `projects` frame, keyed by transcript file state.
    last_messages: crate::bridge_view::LastMessageCache,
    /// The question registry and the desktop gate, so the last phone leaving can hand
    /// back the asks only it was holding. Wired once at startup (`wire_asks`).
    asks: OnceLock<(Arc<Asks>, Arc<AskGate>)>,
    /// The permission registry, for the same hand-off (`wire_permissions`).
    permissions: OnceLock<Arc<Broker>>,
}

impl BridgeController {
    pub fn new(devices: Arc<MobileDevices>) -> Self {
        Self {
            devices,
            app: OnceLock::new(),
            port: AtomicU16::new(0),
            mac_name: Mutex::new("Conduit".to_string()),
            dns_name: Mutex::new(String::new()),
            tailnet: Mutex::new(None),
            live: Mutex::new(HashMap::new()),
            auth_failures: Mutex::new(HashMap::new()),
            pair_prompts: Mutex::new(HashMap::new()),
            spawns: Mutex::new(HashMap::new()),
            uploads: Mutex::new(HashMap::new()),
            last_messages: Default::default(),
            asks: OnceLock::new(),
            permissions: OnceLock::new(),
        }
    }

    /// Hand the controller the question registry and desktop gate. Once; later calls no-op.
    pub fn wire_asks(&self, asks: Arc<Asks>, gate: Arc<AskGate>) {
        let _ = self.asks.set((asks, gate));
    }

    /// Hand the controller the permission registry. Once; later calls no-op. The desktop
    /// gate comes from `wire_asks` -- one gate holds both.
    pub fn wire_permissions(&self, broker: Arc<Broker>) {
        let _ = self.permissions.set(broker);
    }

    /// Is an authenticated REMOTE phone connected AND still heard from? Loopback peers
    /// (sidecar, simulator) never register, so they never hold a question. A socket gone
    /// silent past [`STALE_AFTER`] stops counting at once, before its loop gets round to
    /// dropping it (which then hands its questions back, see `last_phone_left`).
    pub fn has_remote_phone(&self) -> bool {
        self.has_remote_phone_at(Instant::now())
    }

    fn has_remote_phone_at(&self, now: Instant) -> bool {
        lock(&self.live)
            .values()
            .flatten()
            .any(|slot| !conn_is_stale(slot.last_heard(), now))
    }

    /// The last remote phone just left. Every ask or permission it alone was holding goes back to the
    /// terminal now -- unless the desktop is watching, in which case its card still can.
    /// Called with the `live` lock released.
    fn last_phone_left(&self) {
        if let Some((asks, gate)) = self.asks.get() {
            if !gate.is_open() {
                asks.hand_off_where(|_, held_for_phone| held_for_phone);
                if let Some(broker) = self.permissions.get() {
                    broker.hand_off_where(|_, held_for_phone| held_for_phone);
                }
            }
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
            let ts = tailscale::status();
            *lock(&me.mac_name) = mac_name_from(&ts, system_name());
            if let TailscaleState::Running { dns_name, .. } = &ts {
                *lock(&me.dns_name) = dns_name.clone();
            }

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
        if let TailscaleState::Running { dns_name, .. } = &ts {
            *lock(&self.mac_name) = mac_name_from(&ts, None);
            *lock(&self.dns_name) = dns_name.clone();
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
        let (removed, now_empty) = {
            let mut live = lock(&self.live);
            let removed = live.remove(device_id);
            (removed, live.is_empty())
        };
        if let Some(flags) = removed {
            for f in flags {
                f.close();
            }
            if now_empty {
                self.last_phone_left();
            }
        }
    }

    pub(crate) fn disconnect_all_devices(&self) {
        let drained: Vec<_> = lock(&self.live).drain().collect();
        let any = !drained.is_empty();
        for (_, flags) in drained {
            for f in flags {
                f.close();
            }
        }
        if any {
            self.last_phone_left();
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

    fn dns_name(&self) -> String {
        lock(&self.dns_name).clone()
    }

    fn register_live(&self, device_id: &str) -> Arc<LiveSlot> {
        let flag = Arc::new(LiveSlot::new(Instant::now()));
        lock(&self.live)
            .entry(device_id.to_string())
            .or_default()
            .push(flag.clone());
        flag
    }

    fn unregister_live(&self, device_id: &str, flag: &Arc<LiveSlot>) {
        let last_left = {
            let mut live = lock(&self.live);
            let Some(v) = live.get_mut(device_id) else {
                return;
            };
            v.retain(|f| !Arc::ptr_eq(f, flag));
            if v.is_empty() {
                live.remove(device_id);
            }
            live.is_empty()
        };
        if last_left {
            self.last_phone_left();
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
    fn authenticate(&self, peer: IpAddr, token: &str) -> Result<String, AuthOutcome> {
        let (rate_ok, enabled) = (self.auth_allowed(peer), self.devices.enabled());
        if auth_outcome(rate_ok, enabled, false) == AuthOutcome::Unavailable {
            return Err(AuthOutcome::Unavailable);
        }
        let id = self.devices.verify(token);
        match (auth_outcome(rate_ok, enabled, id.is_some()), id) {
            (AuthOutcome::Accepted, Some(id)) => Ok(id),
            (outcome, _) => {
                self.record_auth_failure(peer);
                Err(outcome)
            }
        }
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
        || bound_writes(&stream, WRITE_STALL).is_err()
    {
        return;
    }
    let Some(mut ws) = accept_ws(stream, !loopback, &ctrl.dns_name()) else {
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
    // The conversation id the tail was resolved for, whether the attached session is a
    // Claude one (only those are re-resolved), and when the next re-resolve is due.
    let mut tail_conversation: Option<String> = None;
    let mut attached_claude = false;
    let mut next_resolve = Instant::now();
    // A `discover` probe's reply, produced on its own thread. One probe at a time.
    let (macs_tx, macs_rx) = std::sync::mpsc::channel::<String>();
    let mut discovering = false;
    // The phone's Tailscale user id, from one `whois` the first time it is needed.
    let peer_owner: Arc<OnceLock<Option<u64>>> = Arc::new(OnceLock::new());
    // Ids of the pending questions this socket has pushed (None = `pending` not sent yet),
    // and when the next diff is due.
    let mut pushed: Option<HashSet<String>> = None;
    let mut next_push = Instant::now();
    let mut next_private_check = Instant::now() + PRIVATE_RECHECK_EVERY;
    // When this (remote, authenticated) socket last sent a keepalive ping.
    let mut last_ping = Instant::now();
    // Claude sessions this socket spawned that have not sent `sessionstart` yet.
    let mut spawn_watch = SpawnWatch::default();

    'conn: loop {
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

        // 1. Read a control message if one is ready (times out quickly otherwise). Anything
        //    read at all -- a pong included -- is the phone being heard from.
        let read = ws.read();
        if read.is_ok() {
            if let Some(conn) = device.as_ref() {
                conn.heard(Instant::now());
            }
        }
        match read {
            Ok(Message::Text(text)) if !authed => {
                // Belt and braces with the handshake's WebSocketConfig cap.
                if text.len() > PREAUTH_MAX_BYTES {
                    break;
                }
                // (device id, came from `auth` -- which is acked with `authOk`).
                let newly_authed = match parse_client_msg(&text) {
                    Some(ClientMsg::Auth { token }) => match ctrl.authenticate(peer, &token) {
                        Ok(id) => Some((id, true)),
                        Err(outcome) => {
                            let reply = if outcome == AuthOutcome::Unavailable {
                                unavailable()
                            } else {
                                unauthorized()
                            };
                            let _ = ws.send(Message::Text(reply.to_string()));
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
            Ok(Message::Text(text)) => {
                let mut msg = parse_client_msg(&text);
                // A private session is never read or driven from a phone, whoever asks --
                // refused BEFORE anything is woken, attached or written.
                let private_sid = msg
                    .as_ref()
                    .and_then(session_scope)
                    .filter(|sid| {
                        crate::bridge_view::session_is_private(
                            &app.state::<Arc<Store>>().list(),
                            sid,
                        )
                    })
                    .map(str::to_string);
                if let Some(private_sid) = private_sid {
                    if matches!(msg, Some(ClientMsg::Attach { .. })) {
                        // The phone has left the old chat: stop streaming it.
                        if let Some((old_sid, old_sub)) = crate::bridge_view::clear_attachment(
                            &mut attached,
                            &mut transcript,
                            &mut context_path,
                        ) {
                            pty.unsubscribe(&old_sid, old_sub);
                        }
                        tail_conversation = None;
                    }
                    let refusal = crate::bridge_view::private_session_error(&private_sid);
                    if !send_text(&mut ws, refusal.to_string()) {
                        break 'conn;
                    }
                    msg = None;
                }
                match msg {
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
                            // Resolved exactly as `attach` resolves a transcript; any miss is null.
                            &|s| {
                                let conversation = store.claude_conversation_id(&s.id);
                                ctrl.last_messages
                                    .path_for(&s.id, &conversation, || {
                                        crate::pty::session_projects_dir(&store, &s.id).and_then(
                                            |dir| crate::pty::transcript_path(&conversation, &dir),
                                        )
                                    })
                                    .map_or(serde_json::Value::Null, |p| {
                                        ctrl.last_messages.for_path(&p)
                                    })
                            },
                        );
                        ctrl.last_messages.sweep();
                        if !send_text(&mut ws, view.to_string()) {
                            break 'conn;
                        }
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
                                if !send_text(
                                    &mut ws,
                                    json!({ "type": "size", "cols": cols, "rows": rows })
                                        .to_string(),
                                ) {
                                    break 'conn;
                                }
                            }
                            // Transcript backfill (chat history) + start tailing for appends.
                            // Keyed by the session's CURRENT conversation, which a `/clear`
                            // moves off the pinned id (see `Store::claude_conversation_id`).
                            let store = app.state::<Arc<Store>>();
                            let conversation = store.claude_conversation_id(&session_id);
                            transcript = None;
                            context_path = None;
                            attached_claude = is_claude(&store, &session_id);
                            let found = crate::pty::session_projects_dir(&store, &session_id)
                                .and_then(|dir| crate::pty::transcript_path(&conversation, &dir));
                            // No transcript yet (a chat opened the moment it was spawned): the
                            // phone still gets an empty history, and the tail tick picks the
                            // transcript up as soon as it appears.
                            let lines = found.as_deref().map(read_lines).unwrap_or_default();
                            let history = history_payload(&session_id, &lines);
                            if !send_text(&mut ws, history.to_string()) {
                                break 'conn;
                            }
                            if let Some(path) = found {
                                transcript = Some((path.clone(), lines.len()));
                                if attached_claude {
                                    context_path = Some(path);
                                }
                            }
                            tail_conversation = Some(conversation);
                            next_resolve = Instant::now() + RESOLVE_EVERY;
                            // Re-attach: release the subscription this socket already held.
                            if let Some((old_sid, old_sub)) = crate::bridge_view::replace_attached(
                                &mut attached,
                                (session_id.clone(), sub_id, rx),
                            ) {
                                pty.unsubscribe(&old_sid, old_sub);
                            }
                            next_context = Instant::now();
                        } else {
                            // Never keep streaming the chat the phone just left into this one.
                            if let Some((old_sid, old_sub)) = crate::bridge_view::clear_attachment(
                                &mut attached,
                                &mut transcript,
                                &mut context_path,
                            ) {
                                pty.unsubscribe(&old_sid, old_sub);
                            }
                            tail_conversation = None;
                            attached_claude = false;
                            if !send_text(
                                &mut ws,
                                json!({ "type": "error", "message": "no such session" })
                                    .to_string(),
                            ) {
                                break 'conn;
                            }
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
                        if !send_text(&mut ws, reply.to_string()) {
                            break 'conn;
                        }
                    }
                    Some(ClientMsg::Kill { session_id }) => {
                        pty.kill(&session_id);
                        if !send_text(
                            &mut ws,
                            json!({ "type": "killed", "sessionId": session_id }).to_string(),
                        ) {
                            break 'conn;
                        }
                    }
                    Some(ClientMsg::Spawn {
                        project_id,
                        prompt,
                        agent,
                        worktree,
                    }) => {
                        // Budgeted per phone: its device id, or the peer IP for loopback.
                        let key = device
                            .as_ref()
                            .map_or_else(|| peer.to_string(), |d| d.device_id.clone());
                        let reply = if take_spawn_slot(&ctrl.spawns, &key) {
                            spawn_reply(&app, &project_id, &prompt, agent.as_deref(), worktree)
                        } else {
                            spawn_budget_error()
                        };
                        // Only Claude has a folder-trust prompt that stalls before any hook.
                        if reply["type"] == "spawned"
                            && spawn_agent(agent.as_deref()) == Some(crate::agent::AgentId::Claude)
                        {
                            if let Some(sid) = reply["sessionId"].as_str() {
                                spawn_watch.watch(sid.to_string(), Instant::now());
                            }
                        }
                        if !send_text(&mut ws, reply.to_string()) {
                            break 'conn;
                        }
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
                            if !send_text(&mut ws, unauthorized().to_string()) {
                                break 'conn;
                            }
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
                                        *owner.get_or_init(|| {
                                            tailscale::whois(peer).map(|w| w.user_id)
                                        })
                                    }
                                });
                                let _ = tx.send(reply.to_string());
                            });
                        }
                    }
                    // First answer wins: `resolve` is the check-and-set, so a phone that taps
                    // after the desktop (or another phone) answered gets `ok: false`.
                    Some(ClientMsg::Answer { ask_id, answers }) => {
                        let asks = app.state::<Arc<Asks>>();
                        let view = asks.get(&ask_id);
                        let private = view.as_ref().is_some_and(|v| {
                            crate::bridge_view::session_is_private(
                                &app.state::<Arc<Store>>().list(),
                                &v.session,
                            )
                        });
                        let ok = phone_may_answer(view.as_ref(), private, &answers)
                            && asks.resolve(
                                &ask_id,
                                crate::asks::AskOutcome::Answered {
                                    answers,
                                    by: crate::asks::By::Phone,
                                },
                            );
                        let reply = crate::bridge_view::answer_result_frame(&ask_id, ok);
                        if !send_text(&mut ws, reply.to_string()) {
                            break 'conn;
                        }
                    }
                    // Same rule for a permission: `resolve` is the check-and-set. A private
                    // session's is refused like every private request, tagged with its
                    // session, and the button still gets its `approveResult`.
                    Some(ClientMsg::Approve { id, allow }) => {
                        let broker = app.state::<Arc<Broker>>();
                        let view = broker.get(&id);
                        let private = view.as_ref().is_some_and(|v| {
                            crate::bridge_view::session_is_private(
                                &app.state::<Arc<Store>>().list(),
                                &v.session,
                            )
                        });
                        let frames = match view {
                            Some(v) if private => approve_refusal(&v),
                            view => {
                                let decision = if allow {
                                    crate::broker::Decision::Allow
                                } else {
                                    crate::broker::Decision::Deny
                                };
                                let ok = phone_may_approve(view.as_ref(), private)
                                    && broker.resolve(&id, decision, crate::asks::By::Phone);
                                vec![crate::bridge_view::approve_result_frame(&id, ok)]
                            }
                        };
                        for frame in frames {
                            if !send_text(&mut ws, frame.to_string()) {
                                break 'conn;
                            }
                        }
                    }
                    Some(ClientMsg::Upload {
                        session_id,
                        request_id,
                        name,
                        data,
                    }) => {
                        let key = device
                            .as_ref()
                            .map_or_else(|| peer.to_string(), |d| d.device_id.clone());
                        let allowed = crate::fleet::rate_limited(
                            &ctrl.uploads,
                            &key,
                            UPLOADS_MAX,
                            UPLOAD_WINDOW,
                        );
                        let dir = app.state::<Arc<Store>>().session_dir(&session_id);
                        let reply = upload_reply(dir, &request_id, &name, &data, allowed);
                        if !send_text(&mut ws, reply.to_string()) {
                            break 'conn;
                        }
                    }
                    // Already authenticated (or loopback): a repeat `auth` changes nothing.
                    Some(ClientMsg::Auth { .. }) | None => {}
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break,
        }

        // 1a. Keepalive, remote phones only: ping every PING_EVERY, and give up on a socket
        //     that has read nothing for STALE_AFTER. Dropping it unregisters it, which hands
        //     back any question only it was holding.
        if let Some(conn) = device.as_ref() {
            let now = Instant::now();
            if conn_is_stale(conn.last_heard(), now) {
                let _ = ws.close(None);
                let _ = ws.flush();
                break;
            }
            if ping_due(last_ping, now) {
                last_ping = now;
                if ws.send(Message::Ping(Vec::new())).is_err() {
                    break;
                }
            }
        }

        // 1b. The attached session was made private while streaming: stop, and say so.
        if attached.is_some() && Instant::now() >= next_private_check {
            next_private_check = Instant::now() + PRIVATE_RECHECK_EVERY;
            let projects = app.state::<Arc<Store>>().list();
            let refusal = stop_streaming_if_private(
                &mut attached,
                &mut transcript,
                &mut context_path,
                &mut tail_conversation,
                &mut attached_claude,
                |s| crate::bridge_view::session_is_private(&projects, s),
                |sid, sub| pty.unsubscribe(sid, sub),
            );
            if let Some(refusal) = refusal {
                if ws.send(Message::Text(refusal.to_string())).is_err() {
                    break;
                }
            }
        }

        // 1c. Pending questions and permissions: the whole list once trusted, then what changed, at most
        //     every PUSH_EVERY. Every socket diffs on its own, so every phone collapses a
        //     card whoever answered it.
        if authed && (pushed.is_none() || Instant::now() >= next_push) {
            next_push = Instant::now() + PUSH_EVERY;
            if !push_pending(&app, &mut ws, &mut pushed) {
                break;
            }
        }

        // 2. Flush any buffered PTY output for the attached session -- to loopback only; a
        //    remote phone's subscription is drained and dropped (see `streams_raw_output`).
        let raw_output = streams_raw_output(device.is_some());
        if let Some((_, _, rx)) = attached.as_ref() {
            for _ in 0..DRAIN_PER_TICK {
                match rx.try_recv() {
                    Ok(_) if !raw_output => {}
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
                let next = bus_rx.try_recv();
                if let Ok(ev) = next.as_ref() {
                    if ev.event == "sessionstart" {
                        spawn_watch.started(&ev.session);
                    }
                }
                match next {
                    Ok(ev) if &ev.session == sid => {
                        if ws
                            .send(Message::Text(
                                status_payload(sid, &ev.event, &ev.body).to_string(),
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
            while let Ok(ev) = bus_rx.try_recv() {
                if ev.event == "sessionstart" {
                    spawn_watch.started(&ev.session);
                }
            }
        }

        // 3b. A Claude session this phone spawned that has not started: it is on the Mac's
        //     "trust this folder?" prompt, which the phone cannot answer. Say so, once.
        for sid in spawn_watch.stalled(Instant::now()) {
            if !send_text(&mut ws, trust_stall_frame(&sid).to_string()) {
                break 'conn;
            }
        }

        // 5. Context meter for the attached session: on attach, then every CONTEXT_EVERY.
        if let (Some((sid, _, _)), Some(path)) = (attached.as_ref(), context_path.as_ref()) {
            if Instant::now() >= next_context {
                next_context = Instant::now() + CONTEXT_EVERY;
                if let Some(u) = crate::context_window::for_transcript(path) {
                    let frame = crate::bridge_view::context_frame(sid, &u);
                    if !send_text(&mut ws, frame.to_string()) {
                        break 'conn;
                    }
                }
            }
        }

        // 4a. Follow the attached Claude session onto the transcript it is writing NOW: a
        //     `/clear` moves it to a new conversation, and a chat opened the moment it was
        //     spawned had none at attach. At most once per RESOLVE_EVERY, and the directory
        //     scan only runs when the conversation id moved or there is no transcript yet.
        if attached_claude && Instant::now() >= next_resolve {
            next_resolve = Instant::now() + RESOLVE_EVERY;
            if let Some((sid, _, _)) = attached.as_ref() {
                let store = app.state::<Arc<Store>>();
                let conversation = store.claude_conversation_id(sid);
                if crate::bridge_view::needs_resolve(
                    tail_conversation.as_deref(),
                    transcript.is_some(),
                    &conversation,
                ) {
                    let resolved = crate::pty::session_projects_dir(&store, sid)
                        .and_then(|dir| crate::pty::transcript_path(&conversation, &dir));
                    let current = transcript.as_ref().map(|(p, _)| p.as_path());
                    if crate::bridge_view::should_switch_tail(current, resolved.as_deref()) {
                        // Whatever the OLD conversation wrote since the last tail pass
                        // goes out first, or it is lost with the switch.
                        if let Some((old, cursor)) = transcript.as_mut() {
                            for frame in crate::bridge_view::tail_frames(old, cursor, sid) {
                                if !send_text(&mut ws, frame.to_string()) {
                                    break 'conn;
                                }
                            }
                        }
                        if let Some(path) = resolved.clone() {
                            let lines = read_lines(&path);
                            let history = history_payload(sid, &lines);
                            if !send_text(&mut ws, history.to_string()) {
                                break 'conn;
                            }
                            transcript = Some((path.clone(), lines.len()));
                            context_path = Some(path);
                            next_context = Instant::now();
                        }
                    }
                    // Settled only once found: until then, look again next tick.
                    if resolved.is_some() {
                        tail_conversation = Some(conversation);
                    }
                }
            }
        }

        // 4b. Tail the transcript for appended lines -> chat items.
        if let (Some((path, cursor)), Some((sid, _, _))) = (transcript.as_mut(), attached.as_ref())
        {
            for frame in crate::bridge_view::tail_frames(path, cursor, sid) {
                if !send_text(&mut ws, frame.to_string()) {
                    break 'conn;
                }
            }
        }
    }

    unsubscribe_bus(&bus, &mut bus_sub);
    detach(&pty, &attached);
}

/// Send `pending` (first call) or the `pendingAdded` / `resolved` frames for what changed
/// since this socket last pushed. A resolution older than the ring reads as `cancelled`.
fn push_pending(
    app: &AppHandle,
    ws: &mut WebSocket<TcpStream>,
    pushed: &mut Option<HashSet<String>>,
) -> bool {
    let asks = app.state::<Arc<Asks>>();
    let broker = app.state::<Arc<Broker>>();
    let views = asks.pending();
    let perms = broker.pending();
    let unchanged = pushed.as_ref().is_some_and(|p| {
        p.len() == views.len() + perms.len()
            && views.iter().all(|v| p.contains(&v.id))
            && perms.iter().all(|v| p.contains(&v.id))
    });
    if unchanged {
        return true;
    }
    // The store is read only when there is something to classify.
    let projects = if views.is_empty() && perms.is_empty() {
        Vec::new()
    } else {
        app.state::<Arc<Store>>().list()
    };
    let is_private = |sid: &str| crate::bridge_view::session_is_private(&projects, sid);
    let mut items = crate::bridge_view::ask_push_items(&views, is_private);
    items.extend(crate::bridge_view::permission_push_items(
        &perms, is_private,
    ));
    // The ring is read only when something can have been resolved. Ask and permission ids
    // never collide (`ask-N` / `perm-N`), so one combined ring names either.
    let recent = if pushed.is_some() {
        let mut r = asks.recent_resolutions();
        r.extend(broker.recent_resolutions());
        r
    } else {
        Vec::new()
    };
    let (frames, ids) = crate::bridge_view::push_frames(pushed.as_ref(), &items, &recent);
    for frame in frames {
        if ws.send(Message::Text(frame.to_string())).is_err() {
            return false;
        }
    }
    *pushed = Some(ids);
    true
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
    flag: Arc<LiveSlot>,
}

/// One authenticated remote socket as the controller sees it: whether it has been told to
/// close, and when it last read anything from the phone.
struct LiveSlot {
    closed: AtomicBool,
    heard: Mutex<Instant>,
}

impl LiveSlot {
    fn new(now: Instant) -> Self {
        Self {
            closed: AtomicBool::new(false),
            heard: Mutex::new(now),
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// The phone was heard from (any frame, a pong included) at `at`.
    fn heard(&self, at: Instant) {
        let mut h = lock(&self.heard);
        if at > *h {
            *h = at;
        }
    }

    fn last_heard(&self) -> Instant {
        *lock(&self.heard)
    }
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
        self.flag.is_closed()
    }

    fn heard(&self, at: Instant) {
        self.flag.heard(at);
    }

    fn last_heard(&self) -> Instant {
        self.flag.last_heard()
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

    #[test]
    fn auth_gates_refuse_before_the_token_is_judged() {
        // Rate-limited or switched off: unavailable, whatever the token is.
        for verified in [true, false] {
            assert_eq!(
                auth_outcome(false, true, verified),
                AuthOutcome::Unavailable
            );
            assert_eq!(
                auth_outcome(true, false, verified),
                AuthOutcome::Unavailable
            );
            assert_eq!(
                auth_outcome(false, false, verified),
                AuthOutcome::Unavailable
            );
        }
        assert_eq!(auth_outcome(true, true, true), AuthOutcome::Accepted);
        assert_eq!(auth_outcome(true, true, false), AuthOutcome::Unauthorized);
        assert_eq!(unavailable()["message"], "unavailable");
        assert_eq!(unauthorized()["message"], "unauthorized");
    }

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
    fn private_gate_covers_every_session_scoped_message() {
        let scoped = [
            r#"{"type":"attach","session_id":"s"}"#,
            r#"{"type":"input","session_id":"s","data":"x"}"#,
            r#"{"type":"resize","session_id":"s","cols":1,"rows":1}"#,
            r#"{"type":"git","session_id":"s","action":"changes"}"#,
            r#"{"type":"kill","session_id":"s"}"#,
            r#"{"type":"interrupt","sessionId":"s"}"#,
        ];
        let upload =
            r#"{"type":"upload","sessionId":"s","requestId":"r","name":"a.png","data":"aGk="}"#;
        assert_eq!(session_scope(&parse_client_msg(upload).unwrap()), Some("s"));
        for raw in scoped {
            let m = parse_client_msg(raw).unwrap();
            assert_eq!(session_scope(&m), Some("s"), "{raw}");
        }
        for raw in [
            r#"{"type":"list"}"#,
            r#"{"type":"discover"}"#,
            r#"{"type":"spawn","project_id":"p","prompt":"x"}"#,
        ] {
            assert_eq!(
                session_scope(&parse_client_msg(raw).unwrap()),
                None,
                "{raw}"
            );
        }
    }

    #[test]
    fn upload_debug_never_prints_the_body() {
        let m = parse_client_msg(
            r#"{"type":"upload","sessionId":"s","requestId":"r","name":"a.png","data":"c2VjcmV0LWJvZHk="}"#,
        )
        .unwrap();
        let dbg = format!("{m:?}");
        assert!(!dbg.contains("c2VjcmV0"), "{dbg}");
        assert!(dbg.contains("data: 16"), "{dbg}");
    }

    #[test]
    fn upload_reply_answers_every_request_by_its_id() {
        let ok = upload_reply(None, "r1", "a.png", "aGk=", true);
        assert_eq!(ok["requestId"], "r1");
        assert_eq!(ok["ok"], false, "an unknown session cannot take a file");
        let limited = upload_reply(Some("/nowhere".into()), "r2", "a.png", "aGk=", false);
        assert_eq!(
            (limited["requestId"].as_str(), limited["ok"].as_bool()),
            (Some("r2"), Some(false))
        );
        let root = std::env::temp_dir().join(format!("conduit-upr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let good = upload_reply(
            Some(root.to_string_lossy().into_owned()),
            "r3",
            "a.png",
            "aGk=",
            true,
        );
        assert_eq!(good["ok"], true);
        assert!(good["path"]
            .as_str()
            .unwrap()
            .starts_with(".conduit-uploads/"));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!((UPLOADS_MAX, UPLOAD_WINDOW), (30, Duration::from_secs(600)));
    }

    #[test]
    fn spawn_agent_is_strict() {
        use crate::agent::AgentId;
        assert_eq!(spawn_agent(None), Some(AgentId::Claude));
        assert_eq!(spawn_agent(Some("claude")), Some(AgentId::Claude));
        assert_eq!(spawn_agent(Some("hermes")), Some(AgentId::Hermes));
        // The lenient Deserialize would have made these Claude.
        assert_eq!(spawn_agent(Some("gpt5-turbo")), None);
        assert_eq!(spawn_agent(Some("")), None);
        assert_eq!(spawn_agent(Some("Claude")), None);
    }

    #[test]
    fn spawn_name_is_the_first_line_clipped() {
        assert_eq!(
            spawn_session_name("Fix the login bug\nmore detail"),
            "Fix the login bug"
        );
        assert_eq!(
            spawn_session_name("\n  \n  hello   there  \n"),
            "hello there"
        );
        assert_eq!(spawn_session_name(""), "Mobile");
        assert_eq!(spawn_session_name(" \n\t\n"), "Mobile");
        let long = spawn_session_name(&"word ".repeat(30));
        assert!(long.chars().count() <= SPAWN_NAME_MAX, "{long}");
        assert!(long.ends_with('…'));
        let exact = "é".repeat(SPAWN_NAME_MAX);
        assert_eq!(
            spawn_session_name(&exact),
            exact,
            "exactly the limit is kept whole"
        );
    }

    #[test]
    fn spawns_are_budgeted_per_phone() {
        let spawns = Mutex::new(HashMap::new());
        for i in 0..SPAWNS_MAX {
            assert!(take_spawn_slot(&spawns, "dev-a"), "spawn {} allowed", i + 1);
        }
        assert!(
            !take_spawn_slot(&spawns, "dev-a"),
            "11th in the hour refused"
        );
        assert!(
            take_spawn_slot(&spawns, "dev-b"),
            "another phone is unaffected"
        );
        assert_eq!((SPAWNS_MAX, SPAWN_WINDOW), (10, Duration::from_secs(3600)));
        assert_eq!(
            spawn_budget_error(),
            json!({ "type": "error", "message": "too many new chats — try again later" })
        );
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
        let msg = status_payload("s1", "pretool", &serde_json::json!({ "tool_name": "Bash" }));
        assert_eq!(sorted_keys(&msg), ["body", "event", "sessionId", "type"]);
        assert_eq!(msg["sessionId"], "s1");
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
        let msg = history_payload("s1", &lines);
        assert_eq!(msg["type"], "history");
        assert_eq!(msg["sessionId"], "s1");
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
    fn foreign_origin_is_refused() {
        let lo: SocketAddr = "127.0.0.1:8456".parse().unwrap();
        let tn: SocketAddr = "100.64.0.1:8456".parse().unwrap();
        let ok = |o: &str, at: SocketAddr| origin_allowed(Some(o.as_bytes()), at, "mac.t.ts.net");
        // No Origin at all: the sidecar and plain clients.
        assert!(origin_allowed(None, lo, ""));
        // A browser page, including a DNS-rebinding one that targets our port.
        assert!(!ok("http://evil.example", lo));
        assert!(!ok("http://evil.example:8456", lo));
        assert!(!ok("https://evil.example:8456", tn));
        assert!(!ok("null", lo));
        assert!(!ok("", lo));
        // The wrong port, another address, a scheme other than http, or a path.
        assert!(!ok("http://127.0.0.1:8457", lo));
        assert!(!ok("http://127.0.0.1", lo));
        assert!(!ok("http://100.64.0.1:8456", lo));
        assert!(!ok("https://127.0.0.1:8456", lo));
        assert!(!ok("http://127.0.0.1:8456/x", lo));
        // localhost is never us (any local web page has it); our MagicDNS name only on the
        // tailnet address.
        assert!(!ok("http://localhost:8456", tn));
        assert!(!ok("http://localhost:8456", lo));
        assert!(!ok("http://mac.t.ts.net:8456", lo));
        assert!(!ok("http://other.t.ts.net:8456", tn));
        assert!(!origin_allowed(Some(b"http://:8456"), tn, ""));
        assert!(!origin_allowed(Some(b"http://\xff:8456"), lo, ""));
    }

    #[test]
    fn own_origin_is_accepted() {
        // What iOS's WebSocket sends: the URL it dialled, which it cannot be told to drop.
        let lo: SocketAddr = "127.0.0.1:8456".parse().unwrap();
        let tn: SocketAddr = "100.64.0.1:8456".parse().unwrap();
        let ok = |o: &str, at: SocketAddr| origin_allowed(Some(o.as_bytes()), at, "Mac.t.ts.net.");
        assert!(ok("http://127.0.0.1:8456", lo));
        assert!(ok("http://100.64.0.1:8456", tn));
        assert!(ok("http://mac.t.ts.net:8456", tn));
        assert!(ok("http://MAC.t.ts.net.:8456", tn));
    }

    /// Real socket handshake against `accept_ws`; `{port}` in an Origin is the listener's.
    fn handshake_with_origins(origins: &[&str]) -> Result<(), StatusCode> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            accept_ws(s, false, "").is_some()
        });
        let mut req =
            tungstenite::client::IntoClientRequest::into_client_request(format!("ws://{addr}/"))
                .unwrap();
        for o in origins {
            let o = o.replace("{port}", &addr.port().to_string());
            req.headers_mut().append("Origin", o.parse().unwrap());
        }
        let stream = TcpStream::connect(addr).unwrap();
        let out = match tungstenite::client(req, stream) {
            Ok(_) => Ok(()),
            Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(resp))) => {
                Err(resp.status())
            }
            Err(e) => panic!("unexpected handshake error: {e:?}"),
        };
        assert_eq!(
            server.join().unwrap(),
            out.is_ok(),
            "server upgrade must match"
        );
        out
    }

    #[test]
    fn origin_header_is_refused() {
        // Real socket: a browser-shaped handshake to loopback gets 403, not a WebSocket.
        assert_eq!(
            handshake_with_origins(&["http://evil.example:{port}"]),
            Err(StatusCode::FORBIDDEN)
        );
        // Two Origins are refused even when both name us: nothing honest sends that.
        assert_eq!(
            handshake_with_origins(&["http://127.0.0.1:{port}", "http://127.0.0.1:{port}"]),
            Err(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn ios_shaped_handshake_is_accepted() {
        // The phone app in the Simulator dials ws://127.0.0.1:<port> and SocketRocket adds
        // the matching Origin; the bridge must take it. `localhost` it does not.
        assert_eq!(handshake_with_origins(&["http://127.0.0.1:{port}"]), Ok(()));
        assert_eq!(
            handshake_with_origins(&["http://localhost:{port}"]),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(handshake_with_origins(&[]), Ok(()));
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
            let ok = accept_ws_within(s, true, "", Duration::from_millis(400)).is_some();
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
            let mut ws = accept_ws(s, true, "").expect("handshake");
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
        assert!(d1.is_closed());
        assert!(d1b.is_closed(), "every socket of the device closes");
        assert!(!d2.is_closed(), "other devices stay connected");
        // A connection that ends on its own deregisters; revoking later is a no-op.
        c.unregister_live("d2", &d2);
        c.disconnect_device("d2");
        assert!(!d2.is_closed());
    }

    #[test]
    fn closing_remote_access_disconnects_every_device() {
        let c = controller();
        let a = c.register_live("d1");
        let b = c.register_live("d2");
        c.disconnect_all_devices();
        assert!(a.is_closed() && b.is_closed());
    }

    fn wired_controller() -> (
        BridgeController,
        Arc<crate::asks::Asks>,
        Arc<crate::asks::AskGate>,
    ) {
        let c = controller();
        let asks = Arc::new(crate::asks::Asks::default());
        let gate = Arc::new(crate::asks::AskGate::default());
        c.wire_asks(asks.clone(), gate.clone());
        (c, asks, gate)
    }

    #[test]
    fn last_phone_leaving_hands_off() {
        use crate::asks::AskOutcome;
        let (c, asks, _gate) = wired_controller();
        assert!(!c.has_remote_phone());
        let a = c.register_live("d1");
        let b = c.register_live("d2");
        assert!(c.has_remote_phone());
        let (held, rx_held) =
            asks.register_held("s".into(), "t".into(), serde_json::json!([]), 1, true);
        let (desk, rx_desk) =
            asks.register_held("s".into(), "t".into(), serde_json::json!([]), 2, false);
        c.unregister_live("d1", &a);
        assert!(rx_held.try_recv().is_err(), "another phone still holds it");
        c.unregister_live("d2", &b);
        assert!(!c.has_remote_phone());
        assert_eq!(rx_held.try_recv().unwrap(), AskOutcome::HandOff);
        assert!(asks.get(&held).is_none());
        assert!(
            rx_desk.try_recv().is_err() && asks.get(&desk).is_some(),
            "the desktop's own question is untouched"
        );
    }

    #[test]
    fn last_phone_leaving_keeps_asks_while_the_desktop_watches() {
        let (c, asks, gate) = wired_controller();
        gate.set(true);
        let a = c.register_live("d1");
        let (held, rx) = asks.register_held("s".into(), "t".into(), serde_json::json!([]), 1, true);
        c.unregister_live("d1", &a);
        assert!(rx.try_recv().is_err() && asks.get(&held).is_some());
    }

    #[test]
    fn revoking_the_last_phone_hands_off_too() {
        use crate::asks::AskOutcome;
        let (c, asks, _gate) = wired_controller();
        let _a = c.register_live("d1");
        let (_, rx) = asks.register_held("s".into(), "t".into(), serde_json::json!([]), 1, true);
        c.disconnect_device("d1");
        assert_eq!(rx.try_recv().unwrap(), AskOutcome::HandOff);
        let _b = c.register_live("d2");
        let (_, rx2) = asks.register_held("s".into(), "t".into(), serde_json::json!([]), 1, true);
        c.disconnect_all_devices();
        assert_eq!(rx2.try_recv().unwrap(), AskOutcome::HandOff);
    }

    #[test]
    fn answer_msg_parses_camel_case() {
        let m = parse_client_msg(r#"{"type":"answer","askId":"ask-3","answers":{"Q?":"A"}}"#);
        match m {
            Some(ClientMsg::Answer { ask_id, answers }) => {
                assert_eq!(ask_id, "ask-3");
                assert_eq!(answers["Q?"], "A");
            }
            other => panic!("expected Answer, got {other:?}"),
        }
        assert!(parse_client_msg(r#"{"type":"answer","ask_id":"x","answers":{}}"#).is_none());
        assert!(parse_client_msg(r#"{"type":"answer","askId":"x","answers":"A"}"#).is_none());
    }

    #[test]
    fn a_session_made_private_while_attached_stops_streaming() {
        let private = |s: &str| s == "secret";
        assert_eq!(
            attached_now_private(Some("secret"), private),
            Some("secret")
        );
        assert_eq!(attached_now_private(Some("open"), private), None);
        assert_eq!(attached_now_private(None, private), None);

        // The whole step: unsubscribe the PTY stream, drop the tail, say why (tagged).
        let (_tx, rx) = std::sync::mpsc::channel::<String>();
        let mut attached = Some(("secret".to_string(), 7u64, rx));
        let mut transcript = Some((PathBuf::from("/t/a.jsonl"), 3usize));
        let mut context_path = Some(PathBuf::from("/t/a.jsonl"));
        let mut tail_conversation = Some("conv".to_string());
        let mut attached_claude = true;
        let mut unsubscribed = Vec::new();
        let refusal = stop_streaming_if_private(
            &mut attached,
            &mut transcript,
            &mut context_path,
            &mut tail_conversation,
            &mut attached_claude,
            private,
            |sid, sub| unsubscribed.push((sid.to_string(), sub)),
        );
        assert_eq!(
            refusal,
            Some(json!({"type":"error","message":"private session","sessionId":"secret"}))
        );
        assert_eq!(unsubscribed, vec![("secret".to_string(), 7)]);
        assert!(attached.is_none() && transcript.is_none() && context_path.is_none());
        assert!(tail_conversation.is_none() && !attached_claude);

        // A session that is still open is left streaming, untouched.
        let (_tx, rx) = std::sync::mpsc::channel::<String>();
        let mut attached = Some(("open".to_string(), 8u64, rx));
        let mut transcript = Some((PathBuf::from("/t/b.jsonl"), 1usize));
        let mut context_path = Some(PathBuf::from("/t/b.jsonl"));
        let mut tail_conversation = Some("conv".to_string());
        let mut attached_claude = true;
        let refusal = stop_streaming_if_private(
            &mut attached,
            &mut transcript,
            &mut context_path,
            &mut tail_conversation,
            &mut attached_claude,
            private,
            |_, _| panic!("nothing to unsubscribe"),
        );
        assert!(refusal.is_none());
        assert!(attached.is_some() && transcript.is_some() && context_path.is_some());
        assert!(tail_conversation.is_some() && attached_claude);
    }

    #[test]
    fn a_silent_connection_is_pinged_then_dropped() {
        let t0 = Instant::now();
        assert!(!conn_is_stale(t0, t0));
        assert!(!conn_is_stale(t0, t0 + Duration::from_secs(34)));
        assert!(conn_is_stale(t0, t0 + Duration::from_secs(35)));
        assert!(!ping_due(t0, t0 + Duration::from_secs(14)));
        assert!(ping_due(t0, t0 + Duration::from_secs(15)));
        // Two pings go unanswered before a connection is given up on.
        assert!(STALE_AFTER > PING_EVERY * 2);
    }

    #[test]
    fn a_peer_that_stops_reading_cannot_stall_the_loop() {
        // A frozen phone stops reading but its kernel keeps the socket open (zero window),
        // so an unbounded write blocks forever and the loop never reaches the staleness
        // check. Measured in the Simulator: 70 s frozen, never dropped, question held.
        assert!(WRITE_STALL < STALE_AFTER);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).unwrap(); // never reads
        let (server, _) = listener.accept().unwrap();
        bound_writes(&server, Duration::from_millis(300)).unwrap();
        let chunk = vec![b'x'; 64 * 1024];
        let start = Instant::now();
        let mut w = &server;
        use std::io::Write;
        let failed = loop {
            if let Err(e) = w.write_all(&chunk) {
                break e;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "write never gave up"
            );
        };
        assert!(matches!(
            failed.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ));
    }

    #[test]
    fn a_timed_out_send_ends_the_connection() {
        use std::io::{Error as IoError, ErrorKind};
        for kind in [
            ErrorKind::TimedOut,
            ErrorKind::WouldBlock,
            ErrorKind::BrokenPipe,
        ] {
            assert!(
                send_failure_is_fatal(&tungstenite::Error::Io(IoError::from(kind))),
                "{kind:?} must end the connection"
            );
        }
        assert!(send_failure_is_fatal(&tungstenite::Error::ConnectionClosed));
        assert!(send_failure_is_fatal(&tungstenite::Error::AlreadyClosed));
        // Refusing one oversized frame leaves the socket itself usable.
        assert!(!send_failure_is_fatal(&tungstenite::Error::Capacity(
            tungstenite::error::CapacityError::MessageTooLong {
                size: 2,
                max_size: 1
            }
        )));
    }

    #[test]
    fn raw_output_goes_to_loopback_only() {
        assert!(streams_raw_output(false), "loopback: sidecar + Simulator");
        assert!(!streams_raw_output(true), "a remote phone never renders it");
    }

    #[test]
    fn a_spawn_that_never_starts_is_reported_once() {
        let t0 = Instant::now();
        let mut w = SpawnWatch::default();
        w.watch("s1".into(), t0);
        w.watch("s2".into(), t0);
        assert!(w
            .stalled(t0 + TRUST_STALL - Duration::from_millis(1))
            .is_empty());
        w.started("s2");
        assert_eq!(w.stalled(t0 + TRUST_STALL), vec!["s1".to_string()]);
        assert!(w.stalled(t0 + TRUST_STALL * 3).is_empty(), "said once");
        let f = trust_stall_frame("s1");
        assert_eq!(f["type"], "error");
        assert_eq!(f["sessionId"], "s1");
        assert_eq!(
            f["message"],
            "Claude is waiting on your Mac \u{2014} open this folder there once to trust it"
        );
    }

    #[test]
    fn a_stale_phone_stops_holding_questions() {
        let (c, _asks, _gate) = wired_controller();
        let slot = c.register_live("d1");
        let now = Instant::now();
        assert!(c.has_remote_phone_at(now));
        let later = now + STALE_AFTER;
        assert!(
            !c.has_remote_phone_at(later),
            "a phone silent for STALE_AFTER no longer holds a question"
        );
        slot.heard(later);
        assert!(c.has_remote_phone_at(later), "a frame from it counts again");
        // Two sockets: one fresh one is enough.
        let fresh = c.register_live("d2");
        fresh.heard(later + STALE_AFTER);
        assert!(c.has_remote_phone_at(later + STALE_AFTER));
    }

    #[test]
    fn answer_refused_for_silo() {
        let view = crate::asks::AskView {
            id: "ask-1".into(),
            session: "s".into(),
            tool_use_id: "t".into(),
            questions: serde_json::json!([{"question":"Q?","options":[{"label":"A"}]}]),
            created_ms: 0,
        };
        let good: serde_json::Map<String, serde_json::Value> =
            serde_json::from_value(serde_json::json!({"Q?":"A"})).unwrap();
        let bad: serde_json::Map<String, serde_json::Value> =
            serde_json::from_value(serde_json::json!({"Other?":"A"})).unwrap();
        assert!(phone_may_answer(Some(&view), false, &good));
        assert!(
            !phone_may_answer(Some(&view), true, &good),
            "a private session is never answered from a phone"
        );
        assert!(!phone_may_answer(Some(&view), false, &bad), "validated");
        assert!(!phone_may_answer(None, false, &good), "already resolved");
    }

    fn perm_view(id: &str) -> crate::broker::PermissionView {
        crate::broker::PermissionView {
            id: id.into(),
            session: "s".into(),
            tool_name: "Bash".into(),
            summary: "ls".into(),
            created_ms: 0,
        }
    }

    #[test]
    fn approve_refused_for_silo() {
        let view = perm_view("perm-1");
        assert!(phone_may_approve(Some(&view), false));
        assert!(
            !phone_may_approve(Some(&view), true),
            "a private session's permission is never decided from a phone"
        );
        assert!(!phone_may_approve(None, false), "already resolved");
        // The refusal names the session, so a phone in another chat can ignore it.
        assert_eq!(
            approve_refusal(&view),
            vec![
                serde_json::json!({ "type": "error", "message": "private session", "sessionId": "s" }),
                serde_json::json!({ "type": "approveResult", "id": "perm-1", "ok": false }),
            ]
        );
    }

    #[test]
    fn approve_msg_parses_camel_case() {
        match parse_client_msg(r#"{"type":"approve","id":"perm-2","allow":true}"#) {
            Some(ClientMsg::Approve { id, allow }) => {
                assert_eq!(id, "perm-2");
                assert!(allow);
            }
            other => panic!("expected Approve, got {other:?}"),
        }
        assert!(parse_client_msg(r#"{"type":"approve","id":"x"}"#).is_none());
        assert!(parse_client_msg(r#"{"type":"approve","id":"x","allow":"yes"}"#).is_none());
        // Not session-scoped by its fields: the handler checks the permission's own session.
        let m = parse_client_msg(r#"{"type":"approve","id":"x","allow":false}"#).unwrap();
        assert_eq!(session_scope(&m), None);
    }

    #[test]
    fn last_phone_leaving_hands_off_permissions_too() {
        use crate::asks::By;
        use crate::broker::Decision;
        let (c, _asks, gate) = wired_controller();
        let broker = Arc::new(crate::broker::Broker::default());
        c.wire_permissions(broker.clone());
        let a = c.register_live("d1");
        let (held, rx_held) =
            broker.register_held("s".into(), "Bash".into(), serde_json::json!({}), 1, true);
        let (desk, rx_desk) =
            broker.register_held("s".into(), "Bash".into(), serde_json::json!({}), 2, false);
        c.unregister_live("d1", &a);
        assert_eq!(
            rx_held.try_recv().unwrap(),
            (Decision::FallThrough, By::Terminal)
        );
        assert!(broker.get(&held).is_none());
        assert!(rx_desk.try_recv().is_err() && broker.get(&desk).is_some());
        // While the desktop watches, its card can still answer: nothing is handed off.
        gate.set(true);
        let b = c.register_live("d2");
        let (kept, rx_kept) =
            broker.register_held("s".into(), "Bash".into(), serde_json::json!({}), 3, true);
        c.unregister_live("d2", &b);
        assert!(rx_kept.try_recv().is_err() && broker.get(&kept).is_some());
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
