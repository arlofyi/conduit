//! The `conduit` CLI launcher's HTTP entry point.
//!
//! `hooks.rs` documents its own trust model for hook bodies explicitly: untrusted,
//! unauthenticated, localhost display-data on which no security decision keys, so a
//! spoofed post at worst shows wrong numbers. `/open` is the opposite -- it adds an
//! arbitrary directory as a project and can start an agent inside it, so a spoofed post
//! is an agent process running against a directory of the caller's choosing. Hence
//! three independent layers here: a per-boot token, an `Origin` refusal, and (in
//! `hooks.rs`) never answering a CORS preflight.
//!
//! Nothing in this module touches Tauri. `handle_open` takes a SINK, which is what lets
//! `tests/cli_open.rs` drive the real handler with a real shim process over a real
//! socket. Keep it that way. The sink receives an `OpenPayload`: the parsed request after
//! `resolve` has validated its options and read the prompt file.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tiny_http::{Request, Response};

/// The header carrying the CLI token. Deliberately not a CORS-safelisted name: a
/// browser must send an `OPTIONS` preflight before it can use this, and the hook
/// server never answers a preflight.
pub const TOKEN_HEADER: &str = "x-conduit-token";

/// Cap the body so a runaway or hostile POST cannot exhaust memory -- same reasoning as
/// the hook loop's 1 MB cap, tighter because an open request is a path and a word.
const MAX_BODY: u64 = 64 * 1024;

/// The longest prompt file `/open` will read, in bytes.
pub const MAX_PROMPT_BYTES: u64 = 65_536;

/// The longest session name, in chars (not bytes).
const MAX_NAME_CHARS: usize = 80;

/// One `conduit <path> [--agent <id>] [--worktree <slug>] [--name <name>]
/// [--prompt-file <path>] [--provider <p>] [--model <m>] [--effort <e>]` invocation, as it
/// arrives on the wire.
///
/// `provider`/`model`/`effort` are what let ONE agent start another under conditions it
/// chose: a Hermes session running on a local model can launch a worker on OpenRouter, or on
/// Claude, without the human configuring anything first. Every optional field is
/// `#[serde(default)]` so a shim from an older install -- which sends only `path` and
/// `agent` -- still parses.
///
/// `provider`/`model`/`effort` are NOT validated here: whether "gpt-9" is a real model is a
/// question only the agent can answer, and the frontend re-checks the agent id against
/// `AGENTS` before spawning anything -- the same rule `dispatch_work` follows, for the same
/// reason: a model-invented id must never render as a promise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenRequest {
    pub path: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prompt_file: Option<String>,
    /// Endpoint preset for the new session's agent ("openrouter", "ollama", ...).
    #[serde(default)]
    pub provider: Option<String>,
    /// Exact model id, in the agent's own spelling.
    #[serde(default)]
    pub model: Option<String>,
    /// Reasoning effort, for agents that take one.
    #[serde(default)]
    pub effort: Option<String>,
}

/// A validated `OpenRequest` with the prompt file already read: the shape emitted as the
/// `cli-open` event and returned by `take_pending_opens`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenPayload {
    pub path: String,
    pub agent: Option<String>,
    pub worktree: Option<String>,
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// Validate an authenticated request and read its prompt file. `worktree`, `name` and
/// `prompt_file` only make sense when an agent is started, so they require `agent`.
/// Any failure is a `BadBody`, and the caller never fires the sink.
pub fn resolve(req: OpenRequest) -> Result<OpenPayload, Reject> {
    let OpenRequest {
        path,
        agent,
        worktree,
        name,
        prompt_file,
        provider,
        model,
        effort,
    } = req;
    if agent.is_none() && (worktree.is_some() || name.is_some() || prompt_file.is_some()) {
        return Err(Reject::BadBody);
    }
    if let Some(slug) = &worktree {
        if !crate::worktree::valid_slug(slug) {
            return Err(Reject::BadBody);
        }
    }
    let name = name
        .map(|n| n.trim().chars().take(MAX_NAME_CHARS).collect::<String>())
        .filter(|n| !n.is_empty());
    let prompt = prompt_file.map(|p| read_prompt(&p)).transpose()?;
    Ok(OpenPayload {
        path,
        agent,
        worktree,
        name,
        prompt,
        provider,
        model,
        effort,
    })
}

/// Read a prompt file: absolute, a regular file (links followed), at most
/// `MAX_PROMPT_BYTES`, UTF-8. The metadata check precedes any open, so a FIFO is never
/// opened (which would block).
fn read_prompt(path: &str) -> Result<String, Reject> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(Reject::BadBody);
    }
    let meta = fs::metadata(p).map_err(|_| Reject::BadBody)?;
    if !meta.is_file() || meta.len() > MAX_PROMPT_BYTES {
        return Err(Reject::BadBody);
    }
    let bytes = fs::read(p).map_err(|_| Reject::BadBody)?;
    String::from_utf8(bytes).map_err(|_| Reject::BadBody)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    BadToken,
    BrowserOrigin,
    BadBody,
}

impl Reject {
    /// The wire status. `BadToken` and `BrowserOrigin` both answer 403 with an empty
    /// body, so a caller learns nothing about which layer refused it.
    pub fn status(self) -> u16 {
        match self {
            Reject::BadToken | Reject::BrowserOrigin => 403,
            Reject::BadBody => 400,
        }
    }
}

pub fn token_file_path_in(dir: &Path) -> PathBuf {
    dir.join("cli-token")
}

pub fn token_file_path() -> PathBuf {
    token_file_path_in(&crate::store::data_dir())
}

/// Write a fresh 256-bit token into `dir`, owner-only, and return it.
///
/// Two v4 UUIDs rather than a `rand` dependency -- `uuid` is already in the tree and v4
/// is CSPRNG-backed, so this respects the lean-dependency rule. Regenerated on every
/// boot, so a token captured from a backup or an old shell's scrollback is already dead.
pub fn write_token_file_in(dir: &Path) -> String {
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let path = token_file_path_in(dir);
    if let Err(e) = fs::write(&path, format!("{token}\n")) {
        eprintln!("conduit: could not write cli token: {e}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    token
}

pub fn write_token_file() -> String {
    write_token_file_in(&crate::store::data_dir())
}

/// Constant-time-ish equality: no early return on the first differing byte.
fn secret_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Authenticate and parse one `/open` request. Pure -- no IO, no Tauri.
pub fn parse_open(
    headers: &[(String, String)],
    body: &str,
    expected: &str,
) -> Result<OpenRequest, Reject> {
    // Origin FIRST: a page must not be able to use this route as a token oracle.
    if headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("origin"))
    {
        return Err(Reject::BrowserOrigin);
    }
    let supplied = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(TOKEN_HEADER))
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    // An empty expected token means the boot-time write failed. Fail shut, not open.
    if expected.is_empty() || !secret_eq(supplied, expected) {
        return Err(Reject::BadToken);
    }
    let req: OpenRequest = serde_json::from_str(body).map_err(|_| Reject::BadBody)?;
    if req.path.trim().is_empty() {
        return Err(Reject::BadBody);
    }
    Ok(req)
}

/// Handle one `/open`. On success the sink runs BEFORE the response is written, so a
/// shim that waits for 200 knows the app has already acted. The sink receives the
/// resolved `OpenPayload`; a request that fails `resolve` is a 400 and never reaches it.
pub fn handle_open<F: FnOnce(OpenPayload)>(mut request: Request, expected: &str, sink: F) {
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

    let mut body = String::new();
    let _ = request.as_reader().take(MAX_BODY).read_to_string(&mut body);

    match parse_open(&headers, &body, expected).and_then(resolve) {
        Ok(open) => {
            sink(open);
            let _ = request.respond(Response::from_string("ok"));
        }
        Err(reject) => {
            let _ = request.respond(Response::empty(reject.status()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hdrs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    const TOK: &str = "abc123";

    #[test]
    fn accepts_a_well_formed_request() {
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        let got = parse_open(&h, r#"{"path":"/tmp/p","agent":"claude"}"#, TOK).unwrap();
        assert_eq!(
            got,
            OpenRequest {
                path: "/tmp/p".into(),
                agent: Some("claude".into()),
                worktree: None,
                name: None,
                prompt_file: None,
                provider: None,
                model: None,
                effort: None,
            }
        );
    }

    #[test]
    fn spawn_conditions_ride_along_so_one_agent_can_launch_another() {
        // The point of these three: a Hermes session on a local model launching a worker
        // on OpenRouter, without a human configuring anything in between.
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        let got = parse_open(
            &h,
            r#"{"path":"/tmp/p","agent":"hermes","provider":"openrouter","model":"x-ai/grok-4","effort":"high"}"#,
            TOK,
        )
        .unwrap();
        assert_eq!(got.provider.as_deref(), Some("openrouter"));
        assert_eq!(got.model.as_deref(), Some("x-ai/grok-4"));
        assert_eq!(got.effort.as_deref(), Some("high"));
    }

    #[test]
    fn a_shim_that_predates_the_new_fields_still_parses() {
        // The installed shim is generated, and an older one sends only path+agent. If that
        // stopped parsing, every `conduit .` from a stale shim would 400.
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        let got = parse_open(&h, r#"{"path":"/tmp/p","agent":"claude"}"#, TOK).unwrap();
        assert_eq!(got.provider, None);
        assert_eq!(got.model, None);
        assert_eq!(got.effort, None);
    }

    #[test]
    fn agent_is_optional() {
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        let got = parse_open(&h, r#"{"path":"/tmp/p"}"#, TOK).unwrap();
        assert_eq!(got.agent, None);
    }

    #[test]
    fn header_name_is_case_insensitive() {
        let h = hdrs(&[("x-conduit-token", TOK)]);
        assert!(parse_open(&h, r#"{"path":"/tmp/p"}"#, TOK).is_ok());
    }

    #[test]
    fn rejects_a_missing_or_wrong_token() {
        assert_eq!(
            parse_open(&hdrs(&[]), r#"{"path":"/p"}"#, TOK),
            Err(Reject::BadToken)
        );
        let h = hdrs(&[("X-Conduit-Token", "nope")]);
        assert_eq!(
            parse_open(&h, r#"{"path":"/p"}"#, TOK),
            Err(Reject::BadToken)
        );
    }

    /// A browser cannot suppress Origin on a cross-origin request, and a shell client
    /// never sends one. Checked BEFORE the token so a page cannot probe token validity.
    #[test]
    fn rejects_anything_carrying_origin() {
        let h = hdrs(&[("X-Conduit-Token", TOK), ("Origin", "https://evil.example")]);
        assert_eq!(
            parse_open(&h, r#"{"path":"/p"}"#, TOK),
            Err(Reject::BrowserOrigin)
        );
        let h = hdrs(&[("origin", "null"), ("X-Conduit-Token", TOK)]);
        assert_eq!(
            parse_open(&h, r#"{"path":"/p"}"#, TOK),
            Err(Reject::BrowserOrigin)
        );
    }

    #[test]
    fn rejects_a_bad_body() {
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        assert_eq!(parse_open(&h, "not json", TOK), Err(Reject::BadBody));
        assert_eq!(parse_open(&h, r#"{"path":""}"#, TOK), Err(Reject::BadBody));
        assert_eq!(
            parse_open(&h, r#"{"agent":"claude"}"#, TOK),
            Err(Reject::BadBody)
        );
    }

    #[test]
    fn an_empty_expected_token_accepts_nothing() {
        // Defensive: if the boot-time write ever failed, the route must be shut, not open.
        let h = hdrs(&[("X-Conduit-Token", "")]);
        assert_eq!(
            parse_open(&h, r#"{"path":"/p"}"#, ""),
            Err(Reject::BadToken)
        );
    }

    #[test]
    fn token_file_round_trips_and_is_not_guessable() {
        let dir = std::env::temp_dir().join(format!("conduit-tok-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let a = write_token_file_in(&dir);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            fs::read_to_string(token_file_path_in(&dir)).unwrap().trim(),
            a
        );
        // Regenerated per boot: a token read from a backup is worthless.
        assert_ne!(a, write_token_file_in(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("conduit-tok-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        write_token_file_in(&dir);
        let mode = fs::metadata(token_file_path_in(&dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "token file must not be group/world readable"
        );
        fs::remove_dir_all(&dir).ok();
    }

    fn req_with(f: impl FnOnce(&mut OpenRequest)) -> OpenRequest {
        let mut r = OpenRequest {
            path: "/tmp/p".into(),
            agent: Some("claude".into()),
            worktree: None,
            name: None,
            prompt_file: None,
            provider: None,
            model: None,
            effort: None,
        };
        f(&mut r);
        r
    }

    fn tmpdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conduit-tok-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn v1_bodies_still_resolve_unchanged() {
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        let req = parse_open(&h, r#"{"path":"/tmp/p","agent":"claude"}"#, TOK).unwrap();
        assert_eq!(
            resolve(req).unwrap(),
            OpenPayload {
                path: "/tmp/p".into(),
                agent: Some("claude".into()),
                worktree: None,
                name: None,
                prompt: None,
                provider: None,
                model: None,
                effort: None,
            }
        );
        let req = parse_open(&h, r#"{"path":"/tmp/p"}"#, TOK).unwrap();
        assert_eq!(resolve(req).unwrap().agent, None);
    }

    #[test]
    fn options_without_agent_are_rejected() {
        for body in [
            r#"{"path":"/p","worktree":"fix-a"}"#,
            r#"{"path":"/p","name":"x"}"#,
            r#"{"path":"/p","prompt_file":"/tmp/x"}"#,
        ] {
            let req: OpenRequest = serde_json::from_str(body).unwrap();
            assert_eq!(resolve(req), Err(Reject::BadBody), "{body}");
        }
    }

    #[test]
    fn slug_must_be_safe() {
        for bad in [
            "",
            "Fix-A",
            "fix_a",
            "-fix",
            "fix-",
            "fix--a",
            "../x",
            &"a".repeat(61),
        ] {
            assert_eq!(
                resolve(req_with(|r| r.worktree = Some(bad.into()))),
                Err(Reject::BadBody),
                "{bad}"
            );
        }
        assert_eq!(
            resolve(req_with(
                |r| r.worktree = Some("fix-push-main-01abcd".into())
            ))
            .unwrap()
            .worktree
            .as_deref(),
            Some("fix-push-main-01abcd")
        );
    }

    #[test]
    fn name_is_trimmed_and_capped_by_chars() {
        let long = "\u{e9}".repeat(100);
        let got = resolve(req_with(|r| r.name = Some(format!("  {long}  ")))).unwrap();
        assert_eq!(got.name.unwrap().chars().count(), 80);
        assert_eq!(
            resolve(req_with(|r| r.name = Some("   ".into())))
                .unwrap()
                .name,
            None
        );
    }

    fn prompt_of(p: &Path) -> Result<Option<String>, Reject> {
        resolve(req_with(|r| r.prompt_file = Some(p.display().to_string()))).map(|o| o.prompt)
    }

    #[test]
    fn prompt_file_is_read_and_checked() {
        let dir = tmpdir();
        let ok = dir.join("brief.md");
        fs::write(&ok, "Fix: push main\n").unwrap();
        assert_eq!(prompt_of(&ok).unwrap().as_deref(), Some("Fix: push main\n"));

        let exact = dir.join("exact.md");
        fs::write(&exact, vec![b'a'; 65_536]).unwrap();
        assert!(prompt_of(&exact).is_ok());

        let big = dir.join("big.md");
        fs::write(&big, vec![b'a'; 65_537]).unwrap();
        let not_utf8 = dir.join("bin.md");
        fs::write(&not_utf8, [0xff, 0xfe, 0x00]).unwrap();
        for bad in [
            dir.join("missing.md"),
            dir.clone(),
            big,
            not_utf8,
            PathBuf::from("relative.md"),
        ] {
            assert_eq!(prompt_of(&bad), Err(Reject::BadBody), "{}", bad.display());
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn prompt_file_symlinks_follow_but_fifos_are_refused() {
        use std::os::unix::fs::symlink;
        let dir = tmpdir();
        let file = dir.join("brief.md");
        fs::write(&file, "hello").unwrap();
        let link = dir.join("link.md");
        symlink(&file, &link).unwrap();
        assert_eq!(prompt_of(&link).unwrap().as_deref(), Some("hello"));

        let dir_link = dir.join("dirlink");
        symlink(&dir, &dir_link).unwrap();
        assert_eq!(prompt_of(&dir_link), Err(Reject::BadBody));

        let fifo = dir.join("fifo");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());
        // Must return promptly: a FIFO is rejected on metadata, never opened.
        assert_eq!(prompt_of(&fifo), Err(Reject::BadBody));
        fs::remove_dir_all(&dir).ok();
    }

    /// Serve exactly one request against a real socket, and report what the sink saw.
    fn serve_one(
        port_out: &std::sync::mpsc::Sender<u16>,
        token: String,
    ) -> std::sync::mpsc::Receiver<OpenPayload> {
        let (tx, rx) = std::sync::mpsc::channel();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        port_out
            .send(server.server_addr().to_ip().unwrap().port())
            .unwrap();
        std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                handle_open(req, &token, move |o| {
                    let _ = tx.send(o);
                });
            }
        });
        rx
    }

    #[test]
    fn handle_open_feeds_the_sink_and_answers_200() {
        let (ptx, prx) = std::sync::mpsc::channel();
        let rx = serve_one(&ptx, TOK.to_string());
        let port = prx.recv().unwrap();

        let out = std::process::Command::new("curl")
            .args([
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "-X",
                "POST",
                "-H",
                &format!("X-Conduit-Token: {TOK}"),
                "--data",
                r#"{"path":"/tmp/p","agent":"claude","name":"Fix: x","worktree":"fix-x"}"#,
                &format!("http://127.0.0.1:{port}/open"),
            ])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "200");
        let got = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(got.path, "/tmp/p");
        assert_eq!(got.agent.as_deref(), Some("claude"));
        assert_eq!(got.name.as_deref(), Some("Fix: x"));
        assert_eq!(got.worktree.as_deref(), Some("fix-x"));
    }

    #[test]
    fn handle_open_answers_403_and_never_fires_the_sink_without_a_token() {
        let (ptx, prx) = std::sync::mpsc::channel();
        let rx = serve_one(&ptx, TOK.to_string());
        let port = prx.recv().unwrap();

        let out = std::process::Command::new("curl")
            .args([
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "-X",
                "POST",
                "--data",
                r#"{"path":"/tmp/p"}"#,
                &format!("http://127.0.0.1:{port}/open"),
            ])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "403");
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err());
    }

    /// Every way `resolve` refuses an authenticated request is a 400 on the wire, and the
    /// sink never runs: a bad slug, an oversized prompt file, options without an agent.
    #[test]
    fn handle_open_answers_400_and_never_fires_the_sink_for_a_bad_request() {
        let dir = tmpdir();
        let big = dir.join("big.md");
        fs::write(&big, vec![b'a'; 65_537]).unwrap();
        let big_body = serde_json::json!({
            "path": "/tmp/p",
            "agent": "claude",
            "prompt_file": big.display().to_string(),
        })
        .to_string();
        for body in [
            r#"{"path":"/tmp/p","agent":"claude","worktree":"Fix_A"}"#.to_string(),
            big_body,
            r#"{"path":"/tmp/p","name":"no agent"}"#.to_string(),
        ] {
            let (ptx, prx) = std::sync::mpsc::channel();
            let rx = serve_one(&ptx, TOK.to_string());
            let port = prx.recv().unwrap();
            let out = std::process::Command::new("curl")
                .args([
                    "-s",
                    "-o",
                    if cfg!(windows) { "NUL" } else { "/dev/null" },
                    "-w",
                    "%{http_code}",
                    "-X",
                    "POST",
                    "-H",
                    &format!("X-Conduit-Token: {TOK}"),
                    "--data",
                    &body,
                    &format!("http://127.0.0.1:{port}/open"),
                ])
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), "400", "{body}");
            assert!(
                rx.recv_timeout(std::time::Duration::from_millis(300))
                    .is_err(),
                "the sink fired for {body}"
            );
        }
        fs::remove_dir_all(&dir).ok();
    }
}
