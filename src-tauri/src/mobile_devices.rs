//! The mobile-access switch, the bridge port, and the paired phones.
//!
//! Lives in its own `<data_dir>/mobile-devices.json`, never in `state.json` (an
//! unparseable value there empties the store and the orphan sweep kills every session).
//! Only the SHA-256 of a device token is stored; the plaintext is returned once, by
//! `add_device`, and never logged.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// File-only record. It carries the token hash, so it must never be returned from a
/// command or event: the frontend gets `DeviceView` and nothing else.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) token_hash: String,
    pub(crate) tailscale_login: Option<String>,
    pub(crate) created_at: u64,
    pub(crate) last_seen: Option<u64>,
}

/// What the frontend may see: a `Device` without its hash.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub tailscale_login: Option<String>,
    pub created_at: u64,
    pub last_seen: Option<u64>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct FileV1 {
    version: u32,
    enabled: bool,
    port: Option<u16>,
    devices: Vec<Device>,
}

pub struct MobileDevices {
    path: PathBuf,
    inner: Mutex<FileV1>,
    /// The file exists but could not be read or set aside. Defaults are in memory, but
    /// every write is refused so the original survives.
    read_failed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSettings {
    pub enabled: bool,
    pub port: Option<u16>,
    pub devices: Vec<DeviceView>,
}

/// `last_seen` is only rewritten when older than this.
const LAST_SEEN_THROTTLE_SECS: u64 = 60;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 256-bit secret from two v4 UUIDs (the `cli_open` recipe).
pub fn mint_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl MobileDevices {
    /// Only `NotFound` means "defaults". An unparseable file is renamed to a unique
    /// `.bak.<secs>` (never overwriting an earlier backup). Any other failure keeps
    /// defaults in memory but refuses all writes.
    pub fn load(path: PathBuf) -> Self {
        let mut read_failed = false;
        let inner = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<FileV1>(&bytes) {
                Ok(f) => f,
                Err(_) => {
                    let bak = PathBuf::from(format!("{}.bak.{}", path.display(), now_secs()));
                    if fs::rename(&path, &bak).is_err() {
                        read_failed = true;
                    }
                    FileV1::default()
                }
            },
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    read_failed = true;
                }
                FileV1::default()
            }
        };
        Self {
            path,
            inner: Mutex::new(inner),
            read_failed,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FileV1> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Atomic replace: tmp (0600 on unix), fsync, rename.
    fn save(&self, f: &FileV1) -> io::Result<()> {
        if self.read_failed {
            return Err(io::Error::other(
                "mobile-devices.json could not be read; refusing to overwrite it",
            ));
        }
        let json = serde_json::to_vec_pretty(f).map_err(io::Error::other)?;
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            let _ = fs::remove_file(&self.path);
        }
        fs::rename(&tmp, &self.path)
    }

    /// Apply to a clone, persist, and only then commit to memory.
    fn update<R>(&self, apply: impl FnOnce(&mut FileV1) -> R) -> io::Result<R> {
        let mut g = self.lock();
        let mut next = g.clone();
        next.version = 1;
        let out = apply(&mut next);
        self.save(&next)?;
        *g = next;
        Ok(out)
    }

    pub fn enabled(&self) -> bool {
        self.lock().enabled
    }

    pub fn set_enabled(&self, on: bool) -> io::Result<()> {
        self.update(|f| f.enabled = on)
    }

    pub fn port(&self) -> Option<u16> {
        self.lock().port
    }

    pub fn set_port(&self, p: u16) -> io::Result<()> {
        self.update(|f| f.port = Some(p))
    }

    /// Returns the record and the plaintext token (shown once, never stored).
    pub fn add_device(&self, name: &str, login: Option<String>) -> io::Result<(Device, String)> {
        let token = mint_secret();
        let d = Device {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            token_hash: sha256_hex(&token),
            tailscale_login: login,
            created_at: now_secs(),
            last_seen: None,
        };
        let rec = d.clone();
        self.update(|f| f.devices.push(rec))?;
        Ok((d, token))
    }

    /// Hash the presented token and compare hash-to-hash against every device
    /// (no early exit). The `last_seen` stamp is best-effort and throttled.
    pub fn verify(&self, token: &str) -> Option<String> {
        let presented = sha256_hex(token);
        let mut g = self.lock();
        let mut found = None;
        for (i, d) in g.devices.iter().enumerate() {
            if crate::cli_open::secret_eq(&presented, &d.token_hash) {
                found = Some(i);
            }
        }
        let i = found?;
        let id = g.devices[i].id.clone();
        let now = now_secs();
        let stale = g.devices[i]
            .last_seen
            .is_none_or(|t| now.saturating_sub(t) >= LAST_SEEN_THROTTLE_SECS);
        if stale {
            let mut next = g.clone();
            next.devices[i].last_seen = Some(now);
            if self.save(&next).is_ok() {
                *g = next;
            }
        }
        Some(id)
    }

    /// Is a device with this id still paired? (Cheap; no hashing.)
    pub fn contains(&self, id: &str) -> bool {
        self.lock().devices.iter().any(|d| d.id == id)
    }

    pub fn revoke(&self, id: &str) -> io::Result<bool> {
        self.update(|f| {
            let before = f.devices.len();
            f.devices.retain(|d| d.id != id);
            f.devices.len() != before
        })
    }

    pub fn list(&self) -> Vec<DeviceView> {
        self.lock()
            .devices
            .iter()
            .map(|d| DeviceView {
                id: d.id.clone(),
                name: d.name.clone(),
                tailscale_login: d.tailscale_login.clone(),
                created_at: d.created_at,
                last_seen: d.last_seen,
            })
            .collect()
    }
}

#[tauri::command]
pub fn mobile_settings(state: tauri::State<'_, Arc<MobileDevices>>) -> MobileSettings {
    MobileSettings {
        enabled: state.enabled(),
        port: state.port(),
        devices: state.list(),
    }
}

/// Persists the switch, then re-plans the bridge's Tailscale listener at once rather
/// than at the next 30 s tick. `(async)`: the reconcile runs the Tailscale CLI.
#[tauri::command(async)]
pub fn mobile_set_enabled(
    state: tauri::State<'_, Arc<MobileDevices>>,
    bridge: tauri::State<'_, Arc<crate::bridge::BridgeController>>,
    pairing: tauri::State<'_, Arc<crate::pairing::Pairing>>,
    app: tauri::AppHandle,
    on: bool,
) -> Result<(), String> {
    state.set_enabled(on).map_err(|e| e.to_string())?;
    if !on {
        // Off ends pairing at once: the QR secret and every waiting request.
        pairing.clear_and_announce(&app);
    }
    bridge.reconcile();
    Ok(())
}

/// Forget a device and close any socket it has open right now.
#[tauri::command(async)]
pub fn mobile_revoke_device(
    state: tauri::State<'_, Arc<MobileDevices>>,
    bridge: tauri::State<'_, Arc<crate::bridge::BridgeController>>,
    id: String,
) -> Result<bool, String> {
    let removed = state.revoke(&id).map_err(|e| e.to_string())?;
    if removed {
        bridge.disconnect_device(&id);
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("conduit-mobile-{}.json", uuid::Uuid::new_v4()))
    }

    fn baks(p: &std::path::Path) -> Vec<PathBuf> {
        let prefix = format!("{}.bak.", p.file_name().unwrap().to_string_lossy());
        fs::read_dir(p.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|q| {
                q.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(&prefix)
            })
            .collect()
    }

    #[test]
    fn missing_file_is_defaults() {
        let m = MobileDevices::load(tmp());
        assert!(!m.enabled());
        assert_eq!(m.port(), None);
        assert!(m.list().is_empty());
    }

    #[test]
    fn unparseable_file_is_backed_up_and_defaulted() {
        let p = tmp();
        fs::write(&p, "{not json").unwrap();
        let m = MobileDevices::load(p.clone());
        assert!(!m.enabled());
        let b = baks(&p);
        assert_eq!(b.len(), 1);
        assert_eq!(fs::read_to_string(&b[0]).unwrap(), "{not json");
        m.set_enabled(true).unwrap();
        assert_eq!(fs::read_to_string(&b[0]).unwrap(), "{not json");
        let _ = fs::remove_file(&b[0]);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn unreadable_path_refuses_writes_and_changes_nothing() {
        let p = tmp();
        fs::create_dir(&p).unwrap();
        let m = MobileDevices::load(p.clone());
        assert!(!m.enabled());
        assert!(m.set_enabled(true).is_err());
        assert!(!m.enabled(), "memory must not change on a failed write");
        assert!(m.add_device("x", None).is_err());
        assert!(m.list().is_empty());
        assert!(p.is_dir());
        let _ = fs::remove_dir(&p);
    }

    #[test]
    fn last_seen_is_throttled() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        let (_, token) = m.add_device("a", None).unwrap();
        m.verify(&token).unwrap();
        assert!(m.list()[0].last_seen.is_some());
        let recent = now_secs() - 10;
        m.lock().devices[0].last_seen = Some(recent);
        m.verify(&token).unwrap();
        assert_eq!(m.list()[0].last_seen, Some(recent));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn round_trip_persists_enabled_port_devices() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        m.set_enabled(true).unwrap();
        m.set_port(8460).unwrap();
        let (d, _) = m.add_device("Pixel", Some("a@b.c".into())).unwrap();
        let m2 = MobileDevices::load(p.clone());
        assert!(m2.enabled());
        assert_eq!(m2.port(), Some(8460));
        let l = m2.list();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].id, d.id);
        assert_eq!(l[0].tailscale_login.as_deref(), Some("a@b.c"));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn token_verifies_and_hash_is_stored_not_token() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        let (d, token) = m.add_device("iPhone", None).unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(m.verify(&token), Some(d.id));
        let raw = fs::read_to_string(&p).unwrap();
        assert!(!raw.contains(&token));
        assert!(raw.contains(&sha256_hex(&token)));
        assert!(m.list()[0].last_seen.is_some());
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn wrong_token_rejected() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        m.add_device("iPhone", None).unwrap();
        assert_eq!(m.verify("nope"), None);
        assert_eq!(m.verify(""), None);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn revoked_device_cannot_verify() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        let (d, token) = m.add_device("iPhone", None).unwrap();
        assert!(m.revoke(&d.id).unwrap());
        assert!(!m.revoke(&d.id).unwrap());
        assert_eq!(m.verify(&token), None);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn list_omits_token_hash() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        let (d, _) = m.add_device("iPhone", None).unwrap();
        let json = serde_json::to_string(&m.list()).unwrap();
        assert!(!json.contains(&d.token_hash));
        assert!(!json.to_lowercase().contains("tokenhash"));
        assert!(json.contains("createdAt"));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn atomic_write_leaves_no_tmp() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        m.set_enabled(true).unwrap();
        assert!(p.exists());
        assert!(!PathBuf::from(format!("{}.tmp", p.display())).exists());
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
