//! Pairing a phone with this Mac.
//!
//! Two ways in, one confirmation:
//! - **QR**: Settings -> "Pair a phone" mints a one-time secret (>= 128-bit, single use,
//!   5-minute TTL; a new QR replaces the old secret). The phone sends it back in `pair`.
//! - **Request**: a phone that discovered this Mac through another one sends
//!   `pair {request: true}`. Only while mobile access is on.
//!
//! Either way the Mac shows a prompt (`pair-request`, mirroring the `/ask` flow in
//! `asks.rs` + `hooks.rs`) with a 4-digit code both sides derive from the same inputs, and
//! the human allows or declines. A request waits [`REQUEST_WAIT`] and then resolves as
//! declined; there is at most one outstanding request per peer IP.
//!
//! Nothing here logs a secret, nonce or token. Types carrying a secret deliberately do not
//! derive `Debug`.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::tailscale::{Peer, TailscaleState};

/// How long a QR's secret stays valid.
pub const SECRET_TTL_SECS: u64 = 5 * 60;
/// How long a pair request waits for the human before it resolves as declined.
pub const REQUEST_WAIT: Duration = Duration::from_secs(120);
/// Per-peer budget for a discovery probe across the whole bridge port range.
pub const PROBE_BUDGET: Duration = Duration::from_millis(1500);
/// Longest device name kept (characters).
const MAX_DEVICE_NAME: usize = 64;
/// Longest nonce accepted (characters). The phone sends 32-64 hex chars.
const MAX_NONCE: usize = 256;

/// What the QR names: this Mac. Filled from Tailscale's `Running` state.
pub struct MacInfo {
    pub name: String,
    pub dns_name: String,
    pub ip: String,
}

/// The QR's content; the frontend renders `JSON.stringify(payload)`. Carries the secret,
/// so no `Debug`.
#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QrPayload {
    pub v: u8,
    pub mac_name: String,
    pub dns_name: String,
    pub ip: String,
    pub port: u16,
    pub secret: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Secret,
    Request,
}

/// One phone asking to pair. `secret` is set only for [`Via::Secret`] (already consumed)
/// and is used solely to derive the confirmation code. No `Debug`: it holds the secret
/// and the nonce.
pub struct PairRequest {
    pub peer: IpAddr,
    pub device_name: String,
    pub nonce: String,
    pub via: Via,
    pub login: Option<String>,
    pub secret: Option<String>,
}

/// What the Mac's prompt shows. Never carries the secret or the nonce.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairRequestView {
    pub id: String,
    pub device_name: String,
    pub code: String,
    pub login: Option<String>,
    pub peer: String,
    pub via: Via,
    pub expires_at: u64,
}

/// `format!("{:04}", u16::from_be_bytes(sha256(input ‖ nonce)[0..2]) % 10000)` -- the phone
/// computes the same from the QR secret (or the request id it was told) and its own nonce.
pub fn confirm_code(input: &str, nonce: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    h.update(nonce.as_bytes());
    let d = h.finalize();
    format!("{:04}", u16::from_be_bytes([d[0], d[1]]) % 10000)
}

/// Trimmed, control characters dropped, capped; "Phone" when nothing is left.
pub fn clean_device_name(raw: &str) -> String {
    let s: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DEVICE_NAME)
        .collect();
    let s = s.trim();
    if s.is_empty() {
        "Phone".to_string()
    } else {
        s.to_string()
    }
}

/// A nonce the code can be bound to: non-empty, bounded.
pub fn nonce_ok(nonce: &str) -> bool {
    !nonce.is_empty() && nonce.len() <= MAX_NONCE
}

struct Pending {
    view: PairRequestView,
    peer: IpAddr,
    tx: SyncSender<bool>,
}

struct Inner {
    /// The live QR secret and its expiry (unix seconds).
    secret: Option<(String, u64)>,
    pending: HashMap<String, Pending>,
}

type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// Managed as `Arc<Pairing>`.
pub struct Pairing {
    clock: Clock,
    inner: Mutex<Inner>,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Default for Pairing {
    fn default() -> Self {
        Self::with_clock(Box::new(unix_now))
    }
}

impl Pairing {
    /// `clock` returns unix seconds; tests inject one they can advance.
    pub fn with_clock(clock: Clock) -> Self {
        Self {
            clock,
            inner: Mutex::new(Inner {
                secret: None,
                pending: HashMap::new(),
            }),
        }
    }

    /// Lock and drop everything expired. Every public method goes through here. An expired
    /// request's sender is dropped, so its waiter sees `Disconnected` (= expired).
    fn swept(&self) -> (MutexGuard<'_, Inner>, u64) {
        let now = (self.clock)();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.secret.as_ref().is_some_and(|(_, exp)| now >= *exp) {
            g.secret = None;
        }
        g.pending.retain(|_, p| now < p.view.expires_at);
        (g, now)
    }

    /// Mint a fresh secret (replacing any previous one) and build the QR payload.
    pub fn start_qr(&self, mac: &MacInfo, port: u16) -> QrPayload {
        let (mut g, now) = self.swept();
        let secret = crate::mobile_devices::mint_secret();
        g.secret = Some((secret.clone(), now + SECRET_TTL_SECS));
        QrPayload {
            v: 1,
            mac_name: mac.name.clone(),
            dns_name: mac.dns_name.clone(),
            ip: mac.ip.clone(),
            port,
            secret,
        }
    }

    /// Single use, expiry-checked, constant-time. A wrong guess does not burn the real
    /// secret (guessing is rate-limited by the bridge instead).
    pub fn consume_secret(&self, s: &str) -> bool {
        let (mut g, _) = self.swept();
        let ok = g
            .secret
            .as_ref()
            .is_some_and(|(cur, _)| crate::cli_open::secret_eq(s, cur));
        if ok {
            g.secret = None;
        }
        ok
    }

    /// Does this peer already have a request waiting?
    pub fn busy(&self, peer: IpAddr) -> bool {
        self.swept().0.pending.values().any(|p| p.peer == peer)
    }

    /// Park a request for the human. `None` when this peer already has one outstanding.
    pub fn register(&self, req: PairRequest) -> Option<(String, Receiver<bool>)> {
        let (mut g, now) = self.swept();
        if g.pending.values().any(|p| p.peer == req.peer) {
            return None;
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let code_input = match req.via {
            Via::Secret => req.secret.as_deref().unwrap_or(""),
            Via::Request => id.as_str(),
        };
        let view = PairRequestView {
            id: id.clone(),
            device_name: req.device_name,
            code: confirm_code(code_input, &req.nonce),
            login: req.login,
            peer: req.peer.to_string(),
            via: req.via,
            expires_at: now + REQUEST_WAIT.as_secs(),
        };
        let (tx, rx) = sync_channel(1);
        g.pending.insert(
            id.clone(),
            Pending {
                view,
                peer: req.peer,
                tx,
            },
        );
        Some((id, rx))
    }

    /// First responder wins: the entry is removed and the answer sent under one lock, so
    /// `forget` + `try_recv` in the waiter is a true check-and-set (the `asks.rs` rule).
    pub fn resolve(&self, id: &str, allow: bool) -> bool {
        let (mut g, _) = self.swept();
        match g.pending.remove(id) {
            Some(p) => {
                let _ = p.tx.try_send(allow);
                true
            }
            None => false,
        }
    }

    pub fn forget(&self, id: &str) {
        self.swept().0.pending.remove(id);
    }

    pub fn get(&self, id: &str) -> Option<PairRequestView> {
        self.swept().0.pending.get(id).map(|p| p.view.clone())
    }

    /// Catch-up for a reload or a newly opened window. Oldest first.
    pub fn pending(&self) -> Vec<PairRequestView> {
        let mut v: Vec<PairRequestView> = self
            .swept()
            .0
            .pending
            .values()
            .map(|p| p.view.clone())
            .collect();
        v.sort_by_key(|p| p.expires_at);
        v
    }
}

// ---------------------------------------------------------------- discovery

/// Pure: the peers worth probing -- online, owned by the same Tailscale user as this Mac,
/// with an IPv4, and not this Mac.
pub fn discover_candidates(
    self_user: u64,
    self_ip: Option<Ipv4Addr>,
    peers: Vec<Peer>,
) -> Vec<(Peer, Ipv4Addr)> {
    peers
        .into_iter()
        .filter(|p| p.online && p.user_id == self_user)
        .filter_map(|p| p.ipv4.map(|ip| (p, ip)))
        .filter(|(_, ip)| Some(*ip) != self_ip)
        .collect()
}

/// Pure: a bridge's first frame, if it is a valid `hello`: (macName, conduitVersion).
pub fn parse_hello(text: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("type")?.as_str()? != "hello" {
        return None;
    }
    v.get("protocolVersion")?.as_u64()?;
    let name = v.get("macName")?.as_str()?.to_string();
    let version = v.get("conduitVersion")?.as_str()?.to_string();
    Some((name, version))
}

/// Probe one peer's bridge ports in order within `budget`; stop at the first that greets
/// with a valid `hello`. Returns (port, macName, conduitVersion).
fn probe(ip: Ipv4Addr, budget: Duration) -> Option<(u16, String, String)> {
    let end = Instant::now() + budget;
    for port in crate::bridge::BRIDGE_PORTS {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        let Ok(stream) = TcpStream::connect_timeout(&SocketAddr::from((ip, port)), left) else {
            continue;
        };
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero()
            || stream.set_read_timeout(Some(left)).is_err()
            || stream.set_write_timeout(Some(left)).is_err()
        {
            return None;
        }
        let Ok((mut ws, _)) = tungstenite::client::client(format!("ws://{ip}:{port}/"), stream)
        else {
            continue;
        };
        let first = ws.read();
        let _ = ws.close(None);
        let _ = ws.flush();
        if let Ok(tungstenite::Message::Text(t)) = first {
            if let Some((name, version)) = parse_hello(&t) {
                return Some((port, name, version));
            }
        }
    }
    None
}

/// The `macs` reply: every same-user online peer whose bridge answered. Blocks for about
/// [`PROBE_BUDGET`] (peers are probed in parallel), so call it off the connection loop.
pub fn discover_macs() -> serde_json::Value {
    let (self_user, self_ip) = match crate::tailscale::status() {
        TailscaleState::Running { user_id, ipv4, .. } => (user_id, ipv4),
        _ => return serde_json::json!({ "type": "macs", "macs": [] }),
    };
    let handles: Vec<_> = discover_candidates(self_user, self_ip, crate::tailscale::peers())
        .into_iter()
        .map(|(peer, ip)| {
            std::thread::spawn(move || {
                probe(ip, PROBE_BUDGET).map(|(port, name, version)| {
                    let name = if name.trim().is_empty() {
                        peer.name.clone()
                    } else {
                        name
                    };
                    serde_json::json!({
                        "name": name,
                        "dnsName": peer.dns_name,
                        "ip": ip.to_string(),
                        "port": port,
                        "online": peer.online,
                        "conduitVersion": version,
                    })
                })
            })
        })
        .collect();
    let macs: Vec<serde_json::Value> = handles
        .into_iter()
        .filter_map(|h| h.join().ok().flatten())
        .collect();
    serde_json::json!({ "type": "macs", "macs": macs })
}

// ---------------------------------------------------------------- commands

/// Mint a QR for "Pair a phone". Errors unless mobile access is on and Tailscale is
/// `Running` with an address. `(async)`: it runs the Tailscale CLI.
#[tauri::command(async)]
pub fn pair_start(
    pairing: tauri::State<'_, Arc<Pairing>>,
    devices: tauri::State<'_, Arc<crate::mobile_devices::MobileDevices>>,
    bridge: tauri::State<'_, Arc<crate::bridge::BridgeController>>,
) -> Result<QrPayload, String> {
    if !devices.enabled() {
        return Err("Mobile access is off".into());
    }
    let TailscaleState::Running {
        self_name,
        dns_name,
        ipv4: Some(ip),
        ..
    } = crate::tailscale::status()
    else {
        return Err("Tailscale is not running".into());
    };
    let port = bridge.current_port();
    if port == 0 {
        return Err("The mobile bridge is not listening".into());
    }
    let mac = MacInfo {
        name: self_name,
        dns_name,
        ip: ip.to_string(),
    };
    Ok(pairing.start_qr(&mac, port))
}

#[tauri::command]
pub fn pair_pending(pairing: tauri::State<'_, Arc<Pairing>>) -> Vec<PairRequestView> {
    pairing.pending()
}

/// Allow or decline a waiting request. `false` = it already resolved (answered elsewhere,
/// expired, or the phone went away).
#[tauri::command]
pub fn pair_respond(pairing: tauri::State<'_, Arc<Pairing>>, id: String, allow: bool) -> bool {
    pairing.resolve(&id, allow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn clocked(start: u64) -> (Pairing, Arc<AtomicU64>) {
        let t = Arc::new(AtomicU64::new(start));
        let c = t.clone();
        (
            Pairing::with_clock(Box::new(move || c.load(Ordering::SeqCst))),
            t,
        )
    }

    fn mac() -> MacInfo {
        MacInfo {
            name: "Uzair’s MacBook Pro".into(),
            dns_name: "uzairs-macbook-pro.tailc7b992.ts.net".into(),
            ip: "100.120.238.84".into(),
        }
    }

    fn req(peer: &str, via: Via) -> PairRequest {
        PairRequest {
            peer: peer.parse().unwrap(),
            device_name: "iPhone".into(),
            nonce: "nonce-xyz".into(),
            via,
            login: Some("uzair@".into()),
            secret: None,
        }
    }

    #[test]
    fn secret_is_single_use() {
        let (p, _) = clocked(1000);
        let qr = p.start_qr(&mac(), 8455);
        // A wrong guess does not burn the real secret.
        assert!(!p.consume_secret("not-the-secret"));
        assert!(p.consume_secret(&qr.secret));
        // The racing second request (a screenshot of the QR) gets nothing.
        assert!(!p.consume_secret(&qr.secret));
    }

    #[test]
    fn secret_expires_after_5_minutes() {
        let (p, t) = clocked(1000);
        let qr = p.start_qr(&mac(), 8455);
        t.store(1000 + SECRET_TTL_SECS - 1, Ordering::SeqCst);
        let qr2 = p.start_qr(&mac(), 8455); // fresh one at 1299
        assert_ne!(qr.secret, qr2.secret);
        t.store(1299 + SECRET_TTL_SECS - 1, Ordering::SeqCst);
        assert!(
            p.consume_secret(&qr2.secret),
            "valid until the 5 minutes are up"
        );

        let qr3 = p.start_qr(&mac(), 8455);
        t.fetch_add(SECRET_TTL_SECS, Ordering::SeqCst);
        assert!(!p.consume_secret(&qr3.secret), "expired at 5 minutes");
        assert_eq!(SECRET_TTL_SECS, 300);
    }

    #[test]
    fn new_qr_replaces_old_secret() {
        let (p, _) = clocked(0);
        let old = p.start_qr(&mac(), 8455);
        let new = p.start_qr(&mac(), 8455);
        assert!(!p.consume_secret(&old.secret));
        assert!(p.consume_secret(&new.secret));
    }

    #[test]
    fn secret_is_at_least_128_bit() {
        let (p, _) = clocked(0);
        let qr = p.start_qr(&mac(), 8455);
        assert!(qr.secret.len() >= 32 && qr.secret.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn code_is_4_digits_and_deterministic() {
        // sha256("secret-abc" ‖ "nonce-123")[0..2] = 0x4942 = 18754 -> 8754
        assert_eq!(confirm_code("secret-abc", "nonce-123"), "8754");
        // 0xee43 = 60995 -> 0995: the leading zero is kept.
        assert_eq!(confirm_code("req-1", "nonce-xyz"), "0995");
        assert_eq!(
            confirm_code("secret-abc", "nonce-123"),
            confirm_code("secret-abc", "nonce-123")
        );
        assert_ne!(
            confirm_code("secret-abc", "nonce-123"),
            confirm_code("secret-abc", "nonce-124")
        );
    }

    #[test]
    fn view_code_uses_secret_or_request_id() {
        let (p, _) = clocked(0);
        let mut r = req("100.64.0.2", Via::Secret);
        r.secret = Some("secret-abc".into());
        r.nonce = "nonce-123".into();
        let (id, _rx) = p.register(r).unwrap();
        assert_eq!(p.get(&id).unwrap().code, "8754");

        let (id2, _rx2) = p.register(req("100.64.0.3", Via::Request)).unwrap();
        assert_eq!(p.get(&id2).unwrap().code, confirm_code(&id2, "nonce-xyz"));
    }

    #[test]
    fn resolve_first_responder_wins() {
        let (p, _) = clocked(0);
        let (id, rx) = p.register(req("100.64.0.2", Via::Request)).unwrap();
        assert!(p.resolve(&id, true));
        assert!(!p.resolve(&id, false), "second responder finds nothing");
        assert_eq!(rx.try_recv(), Ok(true));
        assert!(p.pending().is_empty());
    }

    #[test]
    fn request_expires_as_declined() {
        let (p, t) = clocked(500);
        let (id, rx) = p.register(req("100.64.0.2", Via::Request)).unwrap();
        assert_eq!(p.get(&id).unwrap().expires_at, 620);
        t.store(500 + 119, Ordering::SeqCst);
        assert_eq!(p.pending().len(), 1);
        t.store(500 + 120, Ordering::SeqCst);
        assert!(p.pending().is_empty());
        assert!(!p.resolve(&id, true), "too late to allow");
        // The waiter never sees an allow: its sender is gone.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn one_outstanding_request_per_peer() {
        let (p, _) = clocked(0);
        let (id, _rx) = p.register(req("100.64.0.2", Via::Request)).unwrap();
        assert!(p.busy("100.64.0.2".parse().unwrap()));
        assert!(p.register(req("100.64.0.2", Via::Request)).is_none());
        // Another peer is unaffected.
        assert!(p.register(req("100.64.0.3", Via::Request)).is_some());
        // Once answered, the peer may ask again.
        p.forget(&id);
        assert!(p.register(req("100.64.0.2", Via::Request)).is_some());
    }

    #[test]
    fn qr_payload_camel_case_shape() {
        let (p, _) = clocked(0);
        let qr = p.start_qr(&mac(), 8456);
        let v = serde_json::to_value(&qr).unwrap();
        let obj = v.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            ["dnsName", "ip", "macName", "port", "secret", "v"].to_vec()
        );
        assert_eq!(v["v"], 1);
        assert_eq!(v["port"], 8456);
        assert_eq!(v["dnsName"], "uzairs-macbook-pro.tailc7b992.ts.net");
    }

    #[test]
    fn request_view_camel_case_shape_without_secrets() {
        let (p, _) = clocked(10);
        let mut r = req("100.64.0.2", Via::Secret);
        r.secret = Some("top-secret".into());
        let (id, _rx) = p.register(r).unwrap();
        let v = serde_json::to_value(p.get(&id).unwrap()).unwrap();
        let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "code",
                "deviceName",
                "expiresAt",
                "id",
                "login",
                "peer",
                "via"
            ]
        );
        assert_eq!(v["via"], "secret");
        assert_eq!(v["peer"], "100.64.0.2");
        let text = v.to_string();
        assert!(!text.contains("top-secret") && !text.contains("nonce-xyz"));
    }

    #[test]
    fn device_name_and_nonce_are_bounded() {
        assert_eq!(clean_device_name("  "), "Phone");
        assert_eq!(clean_device_name("Uzair\u{7}’s iPhone "), "Uzair’s iPhone");
        assert_eq!(clean_device_name(&"x".repeat(500)).chars().count(), 64);
        assert!(!nonce_ok(""));
        assert!(nonce_ok("abc"));
        assert!(!nonce_ok(&"a".repeat(MAX_NONCE + 1)));
    }

    fn peer(name: &str, ip: Option<&str>, online: bool, user: u64) -> Peer {
        Peer {
            name: name.into(),
            dns_name: format!("{name}.ts.net"),
            ipv4: ip.map(|s| s.parse().unwrap()),
            online,
            user_id: user,
            os: "macOS".into(),
        }
    }

    #[test]
    fn discover_keeps_online_same_user_peers_only() {
        let me: Ipv4Addr = "100.64.0.1".parse().unwrap();
        let got = discover_candidates(
            7,
            Some(me),
            vec![
                peer("studio", Some("100.64.0.2"), true, 7),
                peer("offline", Some("100.64.0.3"), false, 7),
                peer("friend", Some("100.64.0.4"), true, 8),
                peer("noip", None, true, 7),
                peer("self", Some("100.64.0.1"), true, 7),
            ],
        );
        let names: Vec<&str> = got.iter().map(|(p, _)| p.name.as_str()).collect();
        assert_eq!(names, ["studio"]);
    }

    #[test]
    fn hello_is_recognized() {
        let hello =
            r#"{"type":"hello","macName":"Studio","conduitVersion":"0.50.0","protocolVersion":1}"#;
        assert_eq!(
            parse_hello(hello),
            Some(("Studio".to_string(), "0.50.0".to_string()))
        );
        assert_eq!(parse_hello(r#"{"type":"error","message":"x"}"#), None);
        assert_eq!(parse_hello("HTTP/1.1 200 OK"), None);
    }
}
