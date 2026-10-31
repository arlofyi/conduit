//! Which local ports serve a web app a paired phone may open (port mirroring).
//!
//! The phone mirrors THIS computer's loopback onto its own, so `http://localhost:5173` opens
//! there exactly as it does here -- no app, agent or Tailscale change. This module answers
//! "which ports are those": everything listening on a loopback-reachable address, minus
//! Conduit's own sockets and the OS's, that answers an HTTP request.
//!
//! The answer is also the tunnel's allowlist (`bridge.rs`): a phone can only ever reach a
//! port this scan found, on the loopback address the scan reached it at. That is what keeps
//! a tunnel from being a general-purpose relay into the computer.
//!
//! Design: `docs/superpowers/specs/2026-10-31-port-mirroring-design.md`.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::ops::RangeInclusive;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Hook server 8423.., mobile bridge 8455.., fleet MCP 8475.., root MCP ..8516. They live in
/// Conduit's own process and are excluded by pid too; this is the backstop for when the OS
/// does not say who owns a socket.
pub const CONDUIT_RESERVED: RangeInclusive<u16> = 8423..=8516;

/// Debugger endpoints, never offered even though they answer HTTP: Chrome DevTools (9222)
/// and the V8 inspector (`node --inspect` 9229, wrangler/workerd 9229-9231). Their
/// WebSocket IS code execution on this computer, and while mirroring any app on the phone
/// can reach a mirrored port.
pub const DEBUGGER_PORTS: &[u16] = &[9222, 9229, 9230, 9231];

/// Where the OS hands out ports to `bind(0)`. A socket here is an internal IPC server (an
/// editor's extension host, a language server, an MCP or IDE bridge with its own token),
/// not an app someone chose a port for -- and there are dozens of them.
#[cfg(target_os = "linux")]
pub const EPHEMERAL_FROM: u16 = 32768;
#[cfg(not(target_os = "linux"))]
pub const EPHEMERAL_FROM: u16 = 49152;

/// How long one HTTP probe may take, connect and first bytes alike.
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

/// However many phones ask, the OS is asked at most this often.
const SCAN_EVERY: Duration = Duration::from_secs(2);

/// One listening socket as the OS reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listening {
    pub addr: IpAddr,
    pub port: u16,
    pub pid: Option<u32>,
    pub process: Option<String>,
}

/// A port worth probing, with the loopback addresses to try, best first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub port: u16,
    pub targets: Vec<IpAddr>,
    pub pid: Option<u32>,
    pub process: Option<String>,
}

/// What the phone is told about, and the address a tunnel to it dials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WebPort {
    pub port: u16,
    pub process: Option<String>,
    #[serde(skip)]
    pub target: IpAddr,
}

const V4_LOOP: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const V6_LOOP: IpAddr = IpAddr::V6(Ipv6Addr::LOCALHOST);

/// Which loopback addresses reach a socket bound to `addr`. A wildcard is reachable on its
/// own family's loopback (and, dual-stack, often the other's -- the probe settles it). A
/// socket bound to one specific non-loopback address (a LAN or tailnet IP) is not a local
/// app and is not mirrored.
fn loopback_targets(addr: IpAddr) -> Vec<IpAddr> {
    match addr {
        IpAddr::V4(a) if a.is_loopback() || a.is_unspecified() => vec![V4_LOOP],
        IpAddr::V6(a) if a.is_loopback() => vec![V6_LOOP],
        IpAddr::V6(a) if a.is_unspecified() => vec![V6_LOOP, V4_LOOP],
        _ => vec![],
    }
}

/// Is this socket one the phone must never be offered?
fn excluded(l: &Listening, own_pid: u32) -> bool {
    CONDUIT_RESERVED.contains(&l.port)
        || DEBUGGER_PORTS.contains(&l.port)
        || l.port >= EPHEMERAL_FROM
        || l.port == 0
        || l.pid == Some(own_pid)
        // Windows: pid 4 is `System` (http.sys, SMB, WSD), pid 0 the idle process.
        || (cfg!(windows) && matches!(l.pid, Some(0) | Some(4)))
}

/// Pure: collapse the OS's socket list into one candidate per port. A port bound on both
/// `127.0.0.1` and `::1` is one app; its targets are the union, IPv4 first.
pub fn candidates(list: &[Listening], own_pid: u32) -> Vec<Candidate> {
    let mut by_port: Vec<Candidate> = Vec::new();
    for l in list.iter().filter(|l| !excluded(l, own_pid)) {
        let targets = loopback_targets(l.addr);
        if targets.is_empty() {
            continue;
        }
        match by_port.iter_mut().find(|c| c.port == l.port) {
            Some(c) => {
                for t in targets {
                    if !c.targets.contains(&t) {
                        c.targets.push(t);
                    }
                }
                c.pid = c.pid.or(l.pid);
                if c.process.is_none() {
                    c.process = l.process.clone();
                }
            }
            None => by_port.push(Candidate {
                port: l.port,
                targets,
                pid: l.pid,
                process: l.process.clone(),
            }),
        }
    }
    for c in &mut by_port {
        c.targets.sort_by_key(|t| !t.is_ipv4());
    }
    by_port.sort_by_key(|c| c.port);
    by_port
}

/// `127.0.0.1:3000`, `0.0.0.0:3000`, `[::1]:3000`, `[::]:3000`, `*:3000` (lsof/ss), and
/// ss's `[::ffff:127.0.0.1]:3000` and `%lo` scope suffixes.
fn parse_addr_port(s: &str) -> Option<(IpAddr, u16)> {
    let (host, port) = s.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    // The scope suffix first: `[::1]%lo` only loses its brackets once `%lo` is gone.
    let host = host.split('%').next().unwrap_or(host);
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let addr = if host == "*" {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        match host.parse::<IpAddr>().ok()? {
            IpAddr::V6(v6) => v6
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(v6)),
            v4 => v4,
        }
    };
    Some((addr, port))
}

/// Windows `netstat -ano -p TCP` / `-p TCPv6`. A listening row is recognised by its foreign
/// address ending in `:0`, NOT by the word `LISTENING`, which Windows localizes.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_netstat(text: &str) -> Vec<Listening> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
                return None;
            }
            let (addr, port) = parse_addr_port(cols[1])?;
            if !cols[2].ends_with(":0") {
                return None;
            }
            Some(Listening {
                addr,
                port,
                pid: cols[cols.len() - 1].parse().ok(),
                process: None,
            })
        })
        .collect()
}

/// Windows `tasklist /FO CSV /NH`: `"node.exe","1234","Console","1","50,000 K"`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_tasklist(text: &str) -> HashMap<u32, String> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split("\",\"");
            let name = fields.next()?.trim_start_matches('"');
            let pid = fields.next()?.parse().ok()?;
            Some((pid, name.trim_end_matches(".exe").to_string()))
        })
        .collect()
}

/// macOS `lsof -nP -iTCP -sTCP:LISTEN -F pcn`: a `p<pid>` line, a `c<command>` line, then
/// one `n<addr>` line per socket that process holds.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_lsof(text: &str) -> Vec<Listening> {
    let (mut pid, mut command) = (None::<u32>, None::<String>);
    let mut out = Vec::new();
    for line in text.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        let rest = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                pid = rest.parse().ok();
                command = None;
            }
            'c' => command = Some(rest.to_string()),
            'n' => {
                if let Some((addr, port)) = parse_addr_port(rest) {
                    out.push(Listening {
                        addr,
                        port,
                        pid,
                        process: command.clone(),
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// Linux `ss -ltnpH`: `LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=20))`.
/// Without privileges `users:` is absent for other users' sockets; the port still lists.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub fn parse_ss(text: &str) -> Vec<Listening> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            let (addr, port) = parse_addr_port(cols.get(3)?)?;
            let users = line.split_once("users:((\"").map(|(_, u)| u);
            let process = users.and_then(|u| u.split('"').next()).map(str::to_string);
            let pid = users
                .and_then(|u| u.split_once("pid=").map(|(_, p)| p))
                .and_then(|p| p.split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|p| p.parse().ok());
            Some(Listening {
                addr,
                port,
                pid,
                process,
            })
        })
        .collect()
}

#[cfg(windows)]
fn list_listening() -> Vec<Listening> {
    use crate::NoWindow;
    let run = |args: &[&str]| {
        std::process::Command::new("netstat")
            .args(args)
            .no_window()
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let mut list = parse_netstat(&run(&["-ano", "-p", "TCP"]));
    list.extend(parse_netstat(&run(&["-ano", "-p", "TCPv6"])));
    let names = std::process::Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .no_window()
        .output()
        .ok()
        .map(|o| parse_tasklist(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    for l in &mut list {
        l.process = l.pid.and_then(|p| names.get(&p).cloned());
    }
    list
}

#[cfg(target_os = "macos")]
fn list_listening() -> Vec<Listening> {
    use crate::NoWindow;
    std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])
        .no_window()
        .output()
        .ok()
        .map(|o| parse_lsof(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn list_listening() -> Vec<Listening> {
    use crate::NoWindow;
    std::process::Command::new("ss")
        .args(["-ltnpH"])
        .no_window()
        .output()
        .ok()
        .map(|o| parse_ss(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

/// Does `target:port` answer HTTP? One `HEAD /` naming `localhost` (what the phone's
/// browser will send, so a dev server's host check passes), judged by the status line.
pub fn answers_http(target: IpAddr, port: u16, timeout: Duration) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&SocketAddr::new(target, port), timeout) else {
        return false;
    };
    if s.set_read_timeout(Some(timeout)).is_err() || s.set_write_timeout(Some(timeout)).is_err() {
        return false;
    }
    let req = format!("HEAD / HTTP/1.0\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 5];
    let mut got = 0;
    let deadline = Instant::now() + timeout;
    while got < head.len() && Instant::now() < deadline {
        match s.read(&mut head[got..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => got += n,
        }
    }
    got == head.len() && &head == b"HTTP/"
}

#[derive(Default)]
struct Cache {
    at: Option<Instant>,
    ports: Vec<WebPort>,
    /// (port, pid) -> the loopback address that answered HTTP, or None for "not a web
    /// port". A process is probed once; a new process on the same port is probed again.
    probed: HashMap<(u16, Option<u32>), Option<IpAddr>>,
}

/// The scan's cached answer. One per bridge; every phone shares it.
#[derive(Default)]
pub struct WebPorts {
    cache: Mutex<Cache>,
}

impl WebPorts {
    fn lock(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The web ports now, rescanning if the last scan is older than [`SCAN_EVERY`]. Blocks
    /// for the OS query plus at most one probe timeout (probes run in parallel), so it is
    /// never called on the UI thread or a bridge connection's poll loop.
    pub fn list(&self) -> Vec<WebPort> {
        let fresh = self.lock().at.is_some_and(|at| at.elapsed() < SCAN_EVERY);
        if !fresh {
            self.rescan();
        }
        self.lock().ports.clone()
    }

    /// The loopback address a tunnel to `port` dials, if it is a web port. A port absent
    /// from a scan older than [`SCAN_EVERY`] gets one rescan: a dev server started a second
    /// ago is the common case, not an attack.
    pub fn target_for(&self, port: u16) -> Option<IpAddr> {
        let find = |c: &Cache| c.ports.iter().find(|p| p.port == port).map(|p| p.target);
        if let Some(t) = find(&self.lock()) {
            return Some(t);
        }
        self.list();
        find(&self.lock())
    }

    fn rescan(&self) {
        let found = candidates(&list_listening(), std::process::id());
        let known = self.lock().probed.clone();
        let results: Vec<(Candidate, Option<IpAddr>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = found
                .into_iter()
                .map(|c| {
                    let memo = known.get(&(c.port, c.pid)).copied();
                    scope.spawn(move || {
                        let hit = match memo {
                            Some(m) => m,
                            None => c
                                .targets
                                .iter()
                                .copied()
                                .find(|t| answers_http(*t, c.port, PROBE_TIMEOUT)),
                        };
                        (c, hit)
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        let mut cache = self.lock();
        cache.probed = results
            .iter()
            .map(|(c, hit)| ((c.port, c.pid), *hit))
            .collect();
        cache.ports = results
            .into_iter()
            .filter_map(|(c, hit)| {
                hit.map(|target| WebPort {
                    port: c.port,
                    process: c.process,
                    target,
                })
            })
            .collect();
        cache.at = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn l(addr: &str, port: u16, pid: u32) -> Listening {
        Listening {
            addr: addr.parse().unwrap(),
            port,
            pid: Some(pid),
            process: None,
        }
    }

    #[test]
    fn netstat_rows_are_found_by_foreign_port_not_by_localized_state() {
        let text = "\
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2224
  TCP    127.0.0.1:5173         0.0.0.0:0              ABH\u{d6}REN         900
  TCP    127.0.0.1:5173         127.0.0.1:61000        ESTABLISHED     900
  TCP    [::1]:3000             [::]:0                 LISTENING       77
";
        let got = parse_netstat(text);
        assert_eq!(
            got,
            vec![
                l("0.0.0.0", 135, 2224),
                l("127.0.0.1", 5173, 900),
                l("::1", 3000, 77)
            ]
        );
    }

    #[test]
    fn tasklist_csv_maps_pid_to_name_without_exe() {
        let text = "\"node.exe\",\"900\",\"Console\",\"1\",\"50,000 K\"\r\n\"System\",\"4\",\"Services\",\"0\",\"100 K\"\r\n";
        let m = parse_tasklist(text);
        assert_eq!(m.get(&900).map(String::as_str), Some("node"));
        assert_eq!(m.get(&4).map(String::as_str), Some("System"));
    }

    #[test]
    fn lsof_fields_carry_pid_and_command_to_each_socket() {
        let text = "p900\ncnode\nn127.0.0.1:5173\nn[::1]:5173\np12\ncpython3.12\nn*:8000\n";
        let got = parse_lsof(text);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].process.as_deref(), Some("node"));
        assert_eq!(got[1].addr, "::1".parse::<IpAddr>().unwrap());
        assert_eq!((got[2].port, got[2].pid), (8000, Some(12)));
        assert_eq!(got[2].addr, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    }

    #[test]
    fn ss_rows_with_and_without_users() {
        let text = "\
LISTEN 0      511        127.0.0.1:3000      0.0.0.0:*    users:((\"node\",pid=12,fd=20))
LISTEN 0      4096   [::ffff:127.0.0.1]:8080 *:*
LISTEN 0      128          [::1]%lo:631      [::]:*
";
        let got = parse_ss(text);
        assert_eq!(got.len(), 3);
        assert_eq!(
            (got[0].port, got[0].pid, got[0].process.as_deref()),
            (3000, Some(12), Some("node"))
        );
        assert_eq!(got[1].addr, V4_LOOP, "a v4-mapped address is the v4 one");
        assert_eq!((got[2].addr, got[2].port), (V6_LOOP, 631));
    }

    #[test]
    fn candidates_skip_conduit_own_process_reserved_range_and_non_loopback_binds() {
        let list = vec![
            l("127.0.0.1", 5173, 900),
            l("127.0.0.1", 8456, 1),     // reserved range (bridge)
            l("127.0.0.1", 61000, 4242), // Conduit's own pid (an IDE port)
            l("100.100.1.2", 9000, 5),   // bound to a tailnet IP only
            l("192.168.1.4", 9001, 5),   // bound to a LAN IP only
        ];
        let got = candidates(&list, 4242);
        assert_eq!(got.iter().map(|c| c.port).collect::<Vec<_>>(), vec![5173]);
    }

    #[test]
    fn debugger_and_ephemeral_ports_are_never_candidates() {
        let list = vec![
            l("127.0.0.1", 9229, 7),
            l("127.0.0.1", 9222, 7),
            l("127.0.0.1", 54753, 7),
            l("127.0.0.1", 3000, 7),
        ];
        let got = candidates(&list, 1);
        assert_eq!(got.iter().map(|c| c.port).collect::<Vec<_>>(), vec![3000]);
    }

    #[test]
    fn a_port_on_both_families_is_one_candidate_ipv4_first() {
        let list = vec![l("::1", 5173, 900), l("127.0.0.1", 5173, 900)];
        let got = candidates(&list, 1);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].targets, vec![V4_LOOP, V6_LOOP]);
    }

    #[test]
    fn an_ipv6_wildcard_tries_both_loopbacks() {
        let got = candidates(&[l("::", 8080, 9)], 1);
        assert_eq!(got[0].targets, vec![V4_LOOP, V6_LOOP]);
    }

    #[test]
    fn http_probe_accepts_a_status_line_and_rejects_silence_and_other_protocols() {
        let http = TcpListener::bind("127.0.0.1:0").unwrap();
        let http_port = http.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = http.accept().unwrap();
            let mut buf = [0u8; 256];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\n\r\n");
        });
        assert!(answers_http(V4_LOOP, http_port, Duration::from_secs(2)));

        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let other_port = other.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = other.accept().unwrap();
            let _ = s.write_all(b"-ERR redis says no\r\n");
        });
        assert!(!answers_http(V4_LOOP, other_port, Duration::from_secs(2)));

        let silent = TcpListener::bind("127.0.0.1:0").unwrap();
        let silent_port = silent.local_addr().unwrap().port();
        assert!(!answers_http(
            V4_LOOP,
            silent_port,
            Duration::from_millis(200)
        ));
        drop(silent);
    }
}
