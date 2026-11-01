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
use std::sync::{Condvar, Mutex};
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

/// Control APIs that answer HTTP and are never offered: the Docker daemon (2375 plain, 2376
/// TLS -- its API starts containers with the host's filesystem mounted) and Ollama (11434,
/// which pulls and runs models). The exposure is a denylist, so the probe ALSO recognises a
/// debugger or Docker on any port ([`classify`]); these are the well-known ports caught even
/// when the probe cannot tell.
pub const CONTROL_PORTS: &[u16] = &[2375, 2376, 11434];

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

/// How long a "not a web port" verdict is trusted. A dev server can be slower than the probe
/// on its first request (Next.js compiles the page it is asked for), and a verdict cached
/// forever meant that server was never offered until it restarted.
const NOT_WEB_TTL: Duration = Duration::from_secs(30);

/// The most of a probe reply that is read: enough for headers and a `/json/version` body.
const PROBE_READ_MAX: usize = 8 * 1024;

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
        || CONTROL_PORTS.contains(&l.port)
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

/// Fill in process names from a pid -> name memo, calling `fetch` (the expensive full
/// process list) only when a pid has never been looked up. Pids no longer listening are
/// forgotten, so the memo stays the size of the listening set and a reused pid is looked up
/// afresh once its old owner has gone.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn apply_names(
    list: &mut [Listening],
    memo: &mut HashMap<u32, Option<String>>,
    fetch: impl FnOnce() -> HashMap<u32, String>,
) {
    memo.retain(|pid, _| list.iter().any(|l| l.pid == Some(*pid)));
    let unknown: Vec<u32> = list
        .iter()
        .filter_map(|l| l.pid)
        .filter(|p| !memo.contains_key(p))
        .collect();
    if !unknown.is_empty() {
        let names = fetch();
        for pid in unknown {
            // A pid the list does not name is remembered as nameless, so it does not make
            // every later scan run the full list again.
            memo.insert(pid, names.get(&pid).cloned());
        }
    }
    for l in list.iter_mut() {
        l.process = l.pid.and_then(|p| memo.get(&p).cloned().flatten());
    }
}

#[cfg(windows)]
fn list_listening(names_memo: &mut HashMap<u32, Option<String>>) -> Vec<Listening> {
    use crate::NoWindow;
    let run = |args: &[&str]| {
        std::process::Command::new("netstat")
            .args(args)
            .no_window()
            .output()
            .map_err(|e| {
                crate::diag::warn_once("ports-netstat", "ports", format!("netstat failed: {e}"))
            })
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let mut list = parse_netstat(&run(&["-ano", "-p", "TCP"]));
    list.extend(parse_netstat(&run(&["-ano", "-p", "TCPv6"])));
    // tasklist costs ~700 ms; it runs only when a listening pid is new.
    apply_names(&mut list, names_memo, || {
        std::process::Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .no_window()
            .output()
            .ok()
            .map(|o| parse_tasklist(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    });
    list
}

#[cfg(target_os = "macos")]
fn list_listening(_names_memo: &mut HashMap<u32, Option<String>>) -> Vec<Listening> {
    use crate::NoWindow;
    std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])
        .no_window()
        .output()
        .map_err(|e| crate::diag::warn_once("ports-lsof", "ports", format!("lsof failed: {e}")))
        .ok()
        .map(|o| parse_lsof(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn list_listening(_names_memo: &mut HashMap<u32, Option<String>>) -> Vec<Listening> {
    use crate::NoWindow;
    std::process::Command::new("ss")
        .args(["-ltnpH"])
        .no_window()
        .output()
        .map_err(|e| crate::diag::warn_once("ports-ss", "ports", format!("ss failed: {e}")))
        .ok()
        .map(|o| parse_ss(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

/// One HTTP/1.0 exchange: send `req`, read the reply until the server closes, the read cap,
/// or (with `stop_at_head`) the end of the headers -- whichever is first, all inside
/// `timeout` (connect, write and every read share one deadline). None if nothing was read.
fn http_exchange(
    target: IpAddr,
    port: u16,
    req: &str,
    timeout: Duration,
    stop_at_head: bool,
) -> Option<Vec<u8>> {
    let deadline = Instant::now() + timeout;
    let mut s = TcpStream::connect_timeout(&SocketAddr::new(target, port), timeout).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    s.write_all(req.as_bytes()).ok()?;
    let mut out = Vec::new();
    let mut buf = [0u8; 2048];
    while out.len() < PROBE_READ_MAX {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || s.set_read_timeout(Some(left)).is_err() {
            break;
        }
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
        }
        if stop_at_head && out.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    out.truncate(PROBE_READ_MAX);
    (!out.is_empty()).then_some(out)
}

/// Does `target:port` answer HTTP? One `HEAD /` naming `localhost` (what the phone's
/// browser will send, so a dev server's host check passes), judged by the status line.
#[cfg(test)]
pub fn answers_http(target: IpAddr, port: u16, timeout: Duration) -> bool {
    head_reply(target, port, timeout).is_some()
}

fn head_reply(target: IpAddr, port: u16, timeout: Duration) -> Option<Vec<u8>> {
    let req = format!("HEAD / HTTP/1.0\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    http_exchange(target, port, &req, timeout, true).filter(|r| r.starts_with(b"HTTP/"))
}

/// What a probe concluded about a port that answered HTTP.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// An ordinary web app: offered to the phone.
    Web,
    /// A debugger or a Docker daemon: never offered, whatever the port.
    Dangerous,
}

/// Does this reply carry a header only a Docker daemon sends? It adds `Api-Version` (and
/// `Docker-Experimental`, `Server: Docker/...`) to EVERY reply, a 404 included -- so `HEAD /`
/// already shows them, and `GET /_ping` would add nothing a header check does not.
fn docker_headers(reply: &[u8]) -> bool {
    let text = String::from_utf8_lossy(reply);
    let head = text.split("\r\n\r\n").next().unwrap_or("");
    head.lines().skip(1).any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        let name = name.trim().to_ascii_lowercase();
        name == "api-version"
            || name == "docker-experimental"
            || (name == "server" && value.trim().to_ascii_lowercase().starts_with("docker/"))
    })
}

/// Pure: judge a port from its `HEAD /` reply and, when one came, its `GET /json/version`
/// reply. A DevTools-protocol endpoint (Chrome, Edge, Electron, `node --inspect`, workerd)
/// answers `/json/version` with a `webSocketDebuggerUrl` and/or `Protocol-Version` (Node's
/// carries only the latter) -- and that WebSocket is code execution on this computer.
pub fn classify(head: &[u8], json_version: Option<&[u8]>) -> Verdict {
    if docker_headers(head) || json_version.is_some_and(docker_headers) {
        return Verdict::Dangerous;
    }
    if let Some(body) = json_version {
        let text = String::from_utf8_lossy(body);
        if text.contains("webSocketDebuggerUrl") || text.contains("\"Protocol-Version\"") {
            return Verdict::Dangerous;
        }
    }
    Verdict::Web
}

/// Probe one candidate: the first loopback target that answers HTTP, and what it is. None =
/// nothing answered HTTP. Bounded: at most two exchanges of `timeout` per target tried.
fn probe(c: &Candidate, timeout: Duration) -> Option<(IpAddr, Verdict)> {
    c.targets.iter().copied().find_map(|t| {
        let head = head_reply(t, c.port, timeout)?;
        let req = format!(
            "GET /json/version HTTP/1.0\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
            c.port
        );
        // A debugger answers this at once; an app too slow to answer it is not one.
        let json = http_exchange(t, c.port, &req, timeout, false);
        Some((t, classify(&head, json.as_deref())))
    })
}

/// A remembered probe for one (port, pid).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Memo {
    /// A web port, reached at this address. Kept while the process lives.
    Web(IpAddr),
    /// A debugger or Docker daemon. Kept while the process lives: never offered.
    Refused,
    /// Did not answer HTTP when probed at this instant; probed again after [`NOT_WEB_TTL`].
    NotWeb(Instant),
}

/// Pure: may a memo stand in for a fresh probe?
fn memo_valid(m: Memo, now: Instant) -> bool {
    match m {
        Memo::Web(_) | Memo::Refused => true,
        Memo::NotWeb(at) => now.saturating_duration_since(at) < NOT_WEB_TTL,
    }
}

#[derive(Default)]
struct Cache {
    at: Option<Instant>,
    ports: Vec<WebPort>,
    /// (port, pid) -> what its probe found. A new process on the same port is probed again.
    probed: HashMap<(u16, Option<u32>), Memo>,
    /// Windows: pid -> process name, so `tasklist` runs only for new pids.
    names: HashMap<u32, Option<String>>,
    /// A rescan is running; other callers wait for its result instead of starting their own.
    scanning: bool,
}

/// The scan's cached answer. One per bridge; every phone shares it.
#[derive(Default)]
pub struct WebPorts {
    cache: Mutex<Cache>,
    /// Signalled when a rescan finishes.
    scanned: Condvar,
}

/// Clears `scanning` and wakes the waiters however a rescan ends, a panic included, so one
/// failed scan cannot leave every later caller waiting.
struct ScanGuard<'a>(&'a WebPorts);

impl Drop for ScanGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().scanning = false;
        self.0.scanned.notify_all();
    }
}

/// How long a caller waits for someone else's rescan before serving what there is.
const SCAN_WAIT: Duration = Duration::from_secs(10);

impl WebPorts {
    fn lock(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The web ports now, rescanning if the last scan is older than [`SCAN_EVERY`]. Blocks
    /// for the OS query plus a bounded probe (probes run in parallel), so it is never called
    /// on the UI thread or a bridge connection's poll loop. Single-flight: while one caller
    /// rescans, the others wait for its result instead of each running their own.
    pub fn list(&self) -> Vec<WebPort> {
        let mut cache = self.lock();
        let waited_from = Instant::now();
        loop {
            if cache.at.is_some_and(|at| at.elapsed() < SCAN_EVERY) {
                return cache.ports.clone();
            }
            if !cache.scanning {
                break;
            }
            let left = SCAN_WAIT.saturating_sub(waited_from.elapsed());
            if left.is_zero() {
                return cache.ports.clone();
            }
            cache = self
                .scanned
                .wait_timeout(cache, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        cache.scanning = true;
        drop(cache);
        {
            let _guard = ScanGuard(self);
            self.rescan();
        }
        self.lock().ports.clone()
    }

    /// The loopback address a tunnel to `port` dials, if it is a web port. Always judged by a
    /// scan no older than [`SCAN_EVERY`]: a hit from an old scan may name a port whose
    /// process has since been replaced (by a debugger, say), and a miss may be a dev server
    /// started a second ago -- the common case, not an attack.
    pub fn target_for(&self, port: u16) -> Option<IpAddr> {
        self.list()
            .into_iter()
            .find(|p| p.port == port)
            .map(|p| p.target)
    }

    fn rescan(&self) {
        let (known, mut names) = {
            let mut c = self.lock();
            (c.probed.clone(), std::mem::take(&mut c.names))
        };
        let found = candidates(&list_listening(&mut names), std::process::id());
        let now = Instant::now();
        let results: Vec<(Candidate, Memo)> = std::thread::scope(|scope| {
            let handles: Vec<_> = found
                .into_iter()
                .map(|c| {
                    let memo = known
                        .get(&(c.port, c.pid))
                        .copied()
                        .filter(|m| memo_valid(*m, now));
                    scope.spawn(move || {
                        let m = memo.unwrap_or_else(|| match probe(&c, PROBE_TIMEOUT) {
                            Some((t, Verdict::Web)) => Memo::Web(t),
                            Some((_, Verdict::Dangerous)) => Memo::Refused,
                            None => Memo::NotWeb(Instant::now()),
                        });
                        (c, m)
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        let mut cache = self.lock();
        cache.names = names;
        cache.probed = results.iter().map(|(c, m)| ((c.port, c.pid), *m)).collect();
        cache.ports = results
            .into_iter()
            .filter_map(|(c, m)| match m {
                Memo::Web(target) => Some(WebPort {
                    port: c.port,
                    process: c.process,
                    target,
                }),
                _ => None,
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
    fn docker_and_ollama_ports_are_never_candidates() {
        let list = vec![
            l("127.0.0.1", 2375, 7),
            l("127.0.0.1", 2376, 7),
            l("127.0.0.1", 11434, 7),
            l("127.0.0.1", 5173, 7),
        ];
        let got = candidates(&list, 1);
        assert_eq!(got.iter().map(|c| c.port).collect::<Vec<_>>(), vec![5173]);
    }

    #[test]
    fn classify_refuses_devtools_endpoints_on_any_port() {
        let head = b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\n";
        let chrome = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\n   \"Browser\": \"Chrome/130.0\",\n   \"Protocol-Version\": \"1.3\",\n   \"webSocketDebuggerUrl\": \"ws://127.0.0.1:9333/devtools/browser/abc\"\n}";
        assert_eq!(classify(head, Some(chrome)), Verdict::Dangerous);
        // node --inspect: /json/version carries no webSocketDebuggerUrl, only the protocol.
        let node = b"HTTP/1.0 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{\"Browser\": \"node.js/v22.11.0\", \"Protocol-Version\": \"1.1\"}";
        assert_eq!(classify(head, Some(node)), Verdict::Dangerous);
    }

    #[test]
    fn classify_refuses_a_docker_daemon_by_its_headers() {
        let head = b"HTTP/1.1 404 Not Found\r\nApi-Version: 1.47\r\nDocker-Experimental: false\r\nOstype: linux\r\nServer: Docker/27.3.1 (linux)\r\n\r\n";
        assert_eq!(classify(head, None), Verdict::Dangerous);
        let server_only = b"HTTP/1.1 200 OK\r\nserver: docker/27.0 (windows)\r\n\r\n";
        assert_eq!(classify(server_only, None), Verdict::Dangerous);
        // The /_ping-style reply caught on the second exchange too.
        let ok = b"HTTP/1.1 200 OK\r\nAPI-VERSION: 1.47\r\n\r\nOK";
        assert_eq!(
            classify(b"HTTP/1.1 200 OK\r\n\r\n", Some(ok)),
            Verdict::Dangerous
        );
    }

    #[test]
    fn classify_offers_ordinary_dev_servers() {
        let vite = b"HTTP/1.1 200 OK\r\nVary: Origin\r\nContent-Type: text/html\r\n\r\n";
        // A SPA fallback answers /json/version with its index page.
        let spa =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<!doctype html><title>app</title>";
        assert_eq!(classify(vite, Some(spa)), Verdict::Web);
        assert_eq!(classify(vite, None), Verdict::Web);
        // A body merely mentioning the word in prose is not a header.
        let docs = b"HTTP/1.1 200 OK\r\n\r\nSet the Api-Version: header to 2";
        assert_eq!(classify(docs, None), Verdict::Web);
    }

    #[test]
    fn a_failed_probe_is_retried_after_the_ttl_and_a_hit_is_kept() {
        let now = Instant::now();
        assert!(memo_valid(Memo::Web(V4_LOOP), now));
        assert!(memo_valid(Memo::Refused, now));
        assert!(memo_valid(Memo::NotWeb(now), now));
        let later = now + NOT_WEB_TTL + Duration::from_secs(1);
        assert!(
            !memo_valid(Memo::NotWeb(now), later),
            "a slow dev server gets another look"
        );
        assert!(memo_valid(Memo::Web(V4_LOOP), later));
    }

    #[test]
    fn process_names_are_fetched_only_for_new_pids() {
        let mut memo = HashMap::new();
        let mut list = vec![l("127.0.0.1", 3000, 900), l("127.0.0.1", 4000, 901)];
        let mut calls = 0;
        let fetch = |calls: &mut i32| {
            *calls += 1;
            [(900u32, "node".to_string())].into_iter().collect()
        };
        apply_names(&mut list, &mut memo, || fetch(&mut calls));
        assert_eq!(list[0].process.as_deref(), Some("node"));
        assert_eq!(list[1].process, None);
        // Same pids again (901 included, though nameless): no second fetch.
        apply_names(&mut list, &mut memo, || fetch(&mut calls));
        assert_eq!(calls, 1);
        // A new pid triggers one; a gone pid is forgotten.
        let mut list2 = vec![l("127.0.0.1", 3000, 900), l("127.0.0.1", 5000, 902)];
        apply_names(&mut list2, &mut memo, || fetch(&mut calls));
        assert_eq!(calls, 2);
        assert!(!memo.contains_key(&901));
    }

    #[test]
    fn concurrent_callers_share_one_scan() {
        let ports = std::sync::Arc::new(WebPorts::default());
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let p = ports.clone();
                std::thread::spawn(move || p.list().len())
            })
            .collect();
        let lens: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(lens.windows(2).all(|w| w[0] == w[1]), "{lens:?}");
        assert!(!ports.lock().scanning, "the guard clears the flag");
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
