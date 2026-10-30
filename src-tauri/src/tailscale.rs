//! Read-only view of the user's installed Tailscale. Conduit never changes Tailscale
//! state (no `up`/`down`/`set`/`serve`/`funnel`/`login`); it only asks the CLI what is true
//! and parses the answer. Parsing is pure and fixture-tested; the runner is thin.

use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::NoWindow;

const CLI_DEADLINE: Duration = Duration::from_secs(3);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TailscaleState {
    NotInstalled,
    Stopped,
    NeedsLogin,
    #[serde(rename_all = "camelCase")]
    Running {
        tailnet: String,
        self_name: String,
        dns_name: String,
        ipv4: Option<Ipv4Addr>,
        ipv6: Option<Ipv6Addr>,
        user_id: u64,
    },
    Unknown {
        reason: String,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub name: String,
    pub dns_name: String,
    pub ipv4: Option<Ipv4Addr>,
    pub online: bool,
    pub user_id: u64,
    pub os: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhoIs {
    pub login_name: String,
    pub display_name: String,
    pub user_id: u64,
}

// ---- Incoming mirror of `tailscale status --json` / `whois --json` ----

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawNode {
    #[serde(rename = "HostName")]
    host_name: String,
    #[serde(rename = "DNSName")]
    dns_name: String,
    #[serde(rename = "TailscaleIPs")]
    ips: Vec<String>,
    #[serde(rename = "UserID")]
    user_id: u64,
    #[serde(rename = "OS")]
    os: String,
    #[serde(rename = "Online")]
    online: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawTailnet {
    #[serde(rename = "Name")]
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawStatus {
    #[serde(rename = "BackendState")]
    backend_state: String,
    #[serde(rename = "Self")]
    self_node: Option<RawNode>,
    #[serde(rename = "CurrentTailnet")]
    tailnet: Option<RawTailnet>,
    #[serde(rename = "Peer")]
    peers: Option<std::collections::HashMap<String, RawNode>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawProfile {
    #[serde(rename = "ID")]
    id: u64,
    #[serde(rename = "LoginName")]
    login_name: String,
    #[serde(rename = "DisplayName")]
    display_name: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawWhois {
    #[serde(rename = "UserProfile")]
    profile: Option<RawProfile>,
}

fn trim_dns(s: &str) -> String {
    s.trim_end_matches('.').to_string()
}

fn first_v4(ips: &[String]) -> Option<Ipv4Addr> {
    ips.iter().find_map(|s| s.parse().ok())
}

fn first_v6(ips: &[String]) -> Option<Ipv6Addr> {
    ips.iter().find_map(|s| s.parse().ok())
}

/// Backend state decides everything. `Self.TailscaleIPs` stays populated while Tailscale is
/// `Stopped`, so an address is never evidence that the tailnet is reachable.
pub fn parse_status(json: &str) -> TailscaleState {
    let raw: RawStatus = match serde_json::from_str(json) {
        Ok(r) => r,
        Err(e) => {
            return TailscaleState::Unknown {
                reason: format!("unreadable status: {e}"),
            }
        }
    };
    match raw.backend_state.as_str() {
        "Running" => {
            let me = raw.self_node.unwrap_or_default();
            TailscaleState::Running {
                tailnet: raw.tailnet.unwrap_or_default().name,
                self_name: me.host_name,
                dns_name: trim_dns(&me.dns_name),
                ipv4: first_v4(&me.ips),
                ipv6: first_v6(&me.ips),
                user_id: me.user_id,
            }
        }
        "Stopped" => TailscaleState::Stopped,
        "NeedsLogin" | "NeedsMachineAuth" => TailscaleState::NeedsLogin,
        other => TailscaleState::Unknown {
            reason: format!("backend state {other:?}"),
        },
    }
}

pub fn parse_peers(json: &str) -> Vec<Peer> {
    let Ok(raw) = serde_json::from_str::<RawStatus>(json) else {
        return Vec::new();
    };
    let mut out: Vec<Peer> = raw
        .peers
        .unwrap_or_default()
        .into_values()
        .map(|p| Peer {
            ipv4: first_v4(&p.ips),
            name: p.host_name,
            dns_name: trim_dns(&p.dns_name),
            online: p.online,
            user_id: p.user_id,
            os: p.os,
        })
        .collect();
    // A map has no order; keep the list stable between polls.
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.dns_name.cmp(&b.dns_name)));
    out
}

pub fn parse_whois(json: &str) -> Option<WhoIs> {
    let raw: RawWhois = serde_json::from_str(json).ok()?;
    let p = raw.profile?;
    Some(WhoIs {
        login_name: p.login_name,
        display_name: p.display_name,
        user_id: p.id,
    })
}

/// 100.64.0.0/10 (CGNAT, Tailscale's v4 range) or fd7a:115c:a1e0::/48.
pub fn is_tailnet_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xC0) == 0x40
        }
        IpAddr::V6(v6) => v6.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

pub fn is_allowed_peer(ip: IpAddr) -> bool {
    ip.is_loopback() || is_tailnet_addr(ip)
}

// ---- Locating and running the CLI ----

#[cfg(windows)]
const FIXED_CANDIDATES: &[&str] = &[r"C:\Program Files\Tailscale\tailscale.exe"];
#[cfg(not(windows))]
const FIXED_CANDIDATES: &[&str] = &[
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
];

const PATH_BIN: &str = if cfg!(windows) {
    "tailscale.exe"
} else {
    "tailscale"
};
const PATH_SEP: char = if cfg!(windows) { ';' } else { ':' };

/// Subprocess-free lookup (the `tmux::find_tmux` shape): fixed install locations first, then
/// `PATH`. `exists` is injected so tests do not depend on the host.
fn find_cli(exists: impl Fn(&Path) -> bool, path_env: Option<&str>) -> Option<PathBuf> {
    for c in FIXED_CANDIDATES {
        let p = Path::new(c);
        if exists(p) {
            return Some(p.to_path_buf());
        }
    }
    path_env?
        .split(PATH_SEP)
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(PATH_BIN))
        .find(|p| exists(p))
}

pub fn cli_path() -> Option<PathBuf> {
    find_cli(|p| p.is_file(), std::env::var("PATH").ok().as_deref())
}

/// The Mac App Store / standalone `Tailscale.app` binary is both the GUI and the CLI, and
/// it only acts as the CLI when it sees a terminal (`TERM`) or this variable. Conduit
/// launched from the Dock has no `TERM`, so without it the binary tries to start the GUI
/// and prints "The Tailscale GUI failed to start" instead of JSON. Harmless elsewhere.
const CLI_ENV: (&str, &str) = ("TAILSCALE_BE_CLI", "1");

fn run_cli_at(cli: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new(cli)
        .args(args)
        .env(CLI_ENV.0, CLI_ENV.1)
        .no_window()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    // Drain on a thread so a full pipe cannot stall the child while we poll for exit.
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() >= CLI_DEADLINE => {
                let _ = child.kill();
                let _ = child.wait();
                // Detach, never join: a grandchild holding the pipe would block forever.
                drop(reader);
                return Err("tailscale timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    };
    let out = reader.join().unwrap_or_default();
    // `tailscale status` exits non-zero in some non-running states yet still prints JSON.
    if out.trim().is_empty() {
        return Err(format!("tailscale exited {status} with no output"));
    }
    Ok(out)
}

fn run_cli(args: &[&str]) -> Result<String, String> {
    let cli = cli_path().ok_or("tailscale not installed")?;
    run_cli_at(&cli, args)
}

pub fn status() -> TailscaleState {
    let Some(cli) = cli_path() else {
        return TailscaleState::NotInstalled;
    };
    match run_cli_at(&cli, &["status", "--json"]) {
        Ok(json) => parse_status(&json),
        Err(reason) => TailscaleState::Unknown { reason },
    }
}

pub fn peers() -> Vec<Peer> {
    run_cli(&["status", "--json"])
        .map(|j| parse_peers(&j))
        .unwrap_or_default()
}

pub fn whois(ip: IpAddr) -> Option<WhoIs> {
    let ip = ip.to_string();
    parse_whois(&run_cli(&["whois", "--json", &ip]).ok()?)
}

#[tauri::command(async)]
pub fn tailscale_status() -> TailscaleState {
    status()
}

/// Bring the Tailscale app forward so the user can sign in or connect. Best-effort.
#[tauri::command(async)]
pub fn tailscale_open_app() {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open")
            .args(["-a", "Tailscale"])
            .no_window()
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new(r"C:\Program Files\Tailscale\tailscale-ipn.exe")
            .no_window()
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNNING: &str = r#"{"BackendState":"Running","Self":{"HostName":"Uzair’s MacBook Pro","DNSName":"uzairs-macbook-pro.tailc7b992.ts.net.","TailscaleIPs":["100.120.238.84","fd7a:115c:a1e0::5239:ee55"],"UserID":2963369091006053,"OS":"macOS","Online":true},"MagicDNSSuffix":"tailc7b992.ts.net","CurrentTailnet":{"Name":"uziiuzair.com","MagicDNSSuffix":"tailc7b992.ts.net","MagicDNSEnabled":true},"User":null,"Peer":null}"#;
    const STOPPED: &str = r#"{"BackendState":"Stopped","Self":{"HostName":"Uzair’s MacBook Pro","DNSName":"uzairs-macbook-pro.tailc7b992.ts.net.","TailscaleIPs":["100.120.238.84","fd7a:115c:a1e0::5239:ee55"],"UserID":2963369091006053,"OS":"macOS","Online":false},"MagicDNSSuffix":"tailc7b992.ts.net","CurrentTailnet":{"Name":"uziiuzair.com","MagicDNSSuffix":"tailc7b992.ts.net","MagicDNSEnabled":true},"User":null,"Peer":null}"#;

    /// A stand-in for `Tailscale.app`'s binary: CLI only when told so, GUI text otherwise —
    /// what a Conduit launched from the Dock (no `TERM`) used to get.
    #[cfg(unix)]
    #[test]
    fn cli_is_run_in_cli_mode_without_a_terminal() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("conduit-ts-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cli = dir.join("Tailscale");
        std::fs::write(
            &cli,
            "#!/bin/sh\nif [ \"$TAILSCALE_BE_CLI\" = 1 ]; then echo '{\"BackendState\":\"Running\"}'; \
             else echo 'The Tailscale GUI failed to start'; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let out = run_cli_at(&cli, &["status", "--json"]).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(out.trim_start().starts_with('{'), "{out}");
    }

    #[test]
    fn running_status_parses() {
        match parse_status(RUNNING) {
            TailscaleState::Running {
                tailnet,
                self_name,
                dns_name,
                ipv4,
                ipv6,
                user_id,
            } => {
                assert_eq!(tailnet, "uziiuzair.com");
                assert_eq!(self_name, "Uzair’s MacBook Pro");
                assert_eq!(dns_name, "uzairs-macbook-pro.tailc7b992.ts.net");
                assert_eq!(ipv4, Some("100.120.238.84".parse().unwrap()));
                assert_eq!(ipv6, Some("fd7a:115c:a1e0::5239:ee55".parse().unwrap()));
                assert_eq!(user_id, 2963369091006053);
            }
            other => panic!("expected Running, got {other:?}"),
        }
    }

    #[test]
    fn running_serializes_camel_case() {
        let v = serde_json::to_value(parse_status(RUNNING)).unwrap();
        assert_eq!(v["state"], "running");
        assert_eq!(v["dnsName"], "uzairs-macbook-pro.tailc7b992.ts.net");
        assert_eq!(v["selfName"], "Uzair’s MacBook Pro");
        assert_eq!(v["ipv4"], "100.120.238.84");
        assert_eq!(v["userId"], 2963369091006053u64);
        let s = serde_json::to_value(TailscaleState::NotInstalled).unwrap();
        assert_eq!(s["state"], "notInstalled");
    }

    #[test]
    fn stopped_with_ips_is_stopped() {
        assert_eq!(parse_status(STOPPED), TailscaleState::Stopped);
    }

    #[test]
    fn needs_login() {
        for s in ["NeedsLogin", "NeedsMachineAuth"] {
            let j = format!(r#"{{"BackendState":"{s}"}}"#);
            assert_eq!(parse_status(&j), TailscaleState::NeedsLogin);
        }
    }

    #[test]
    fn bad_json_is_unknown() {
        assert!(matches!(
            parse_status("not json"),
            TailscaleState::Unknown { .. }
        ));
        assert!(matches!(
            parse_status(r#"{"BackendState":"Starting"}"#),
            TailscaleState::Unknown { .. }
        ));
        assert!(matches!(parse_status("{}"), TailscaleState::Unknown { .. }));
    }

    #[test]
    fn peers_parse() {
        let j = r#"{"BackendState":"Running","Peer":{
          "nodekey:aa":{"HostName":"iphone","DNSName":"iphone.tail.ts.net.","TailscaleIPs":["100.64.0.2","fd7a:115c:a1e0::2"],"UserID":7,"OS":"iOS","Online":true},
          "nodekey:bb":{"HostName":"old-mac","DNSName":"old-mac.tail.ts.net.","TailscaleIPs":["100.64.0.3"],"UserID":8,"OS":"macOS","Online":false}}}"#;
        let p = parse_peers(j);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].name, "iphone");
        assert_eq!(p[0].dns_name, "iphone.tail.ts.net");
        assert_eq!(p[0].ipv4, Some("100.64.0.2".parse().unwrap()));
        assert!(p[0].online);
        assert_eq!(p[0].os, "iOS");
        assert_eq!(p[1].name, "old-mac");
        assert!(!p[1].online);
        assert!(parse_peers(STOPPED).is_empty());
        assert!(parse_peers("garbage").is_empty());
    }

    #[test]
    fn whois_parses() {
        let j = r#"{"Node":{"Name":"x"},"UserProfile":{"ID":42,"LoginName":"a@b.com","DisplayName":"Ab"}}"#;
        assert_eq!(
            parse_whois(j),
            Some(WhoIs {
                login_name: "a@b.com".into(),
                display_name: "Ab".into(),
                user_id: 42
            })
        );
        assert_eq!(parse_whois(r#"{"Node":{}}"#), None);
        assert_eq!(parse_whois("nope"), None);
    }

    #[test]
    fn tailnet_ranges() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(is_tailnet_addr(ip("100.64.0.1")));
        assert!(is_tailnet_addr(ip("100.127.255.255")));
        assert!(!is_tailnet_addr(ip("100.128.0.1")));
        assert!(!is_tailnet_addr(ip("100.63.255.255")));
        assert!(!is_tailnet_addr(ip("192.168.1.5")));
        assert!(is_tailnet_addr(ip("fd7a:115c:a1e0::1")));
        assert!(!is_tailnet_addr(ip("fe80::1")));
        assert!(!is_tailnet_addr(ip("127.0.0.1")));
        assert!(is_allowed_peer(ip("127.0.0.1")));
        assert!(is_allowed_peer(ip("::1")));
        assert!(is_allowed_peer(ip("100.100.1.1")));
        assert!(!is_allowed_peer(ip("192.168.1.5")));
    }

    #[cfg(not(windows))]
    #[test]
    fn find_cli_prefers_app_bundle() {
        let all = |_: &Path| true;
        assert_eq!(
            find_cli(all, Some("/x/bin")),
            Some(PathBuf::from(
                "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
            ))
        );
        let brew_only = |p: &Path| p == Path::new("/opt/homebrew/bin/tailscale");
        assert_eq!(
            find_cli(brew_only, None),
            Some(PathBuf::from("/opt/homebrew/bin/tailscale"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn find_cli_prefers_app_bundle() {
        let all = |_: &Path| true;
        assert_eq!(
            find_cli(all, Some(r"C:\x")),
            Some(PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe"))
        );
    }

    #[test]
    fn find_cli_falls_back_to_path() {
        let dir = if cfg!(windows) {
            r"C:\opt\ts"
        } else {
            "/opt/ts"
        };
        let want = Path::new(dir).join(PATH_BIN);
        let w = want.clone();
        let only = move |p: &Path| p == w;
        assert_eq!(find_cli(only, Some(dir)), Some(want));
        assert_eq!(find_cli(|_| false, Some(dir)), None);
        assert_eq!(find_cli(|_| false, None), None);
    }
}
