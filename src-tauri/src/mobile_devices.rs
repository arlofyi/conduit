//! The mobile-access switch, the bridge port, and the paired phones.
//!
//! Lives in its own `<data_dir>/mobile-devices.json`, never in `state.json` (an
//! unparseable value there empties the store and the orphan sweep kills every session).
//! Only the SHA-256 of a device token is stored; the plaintext is returned once, by
//! `add_device`, and never logged.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub tailscale_login: Option<String>,
    pub created_at: u64,
    pub last_seen: Option<u64>,
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

#[derive(Serialize, Deserialize, Default)]
struct FileV1 {
    version: u32,
    enabled: bool,
    port: Option<u16>,
    devices: Vec<Device>,
}

pub struct MobileDevices {
    path: PathBuf,
    inner: Mutex<FileV1>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSettings {
    pub enabled: bool,
    pub port: Option<u16>,
    pub devices: Vec<DeviceView>,
}

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
    /// Missing or unparseable -> defaults. An unparseable file is renamed to `.bak`
    /// right away so the next write cannot destroy it.
    pub fn load(path: PathBuf) -> Self {
        let inner = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<FileV1>(&bytes) {
                Ok(f) => f,
                Err(_) => {
                    let mut bak = path.clone().into_os_string();
                    bak.push(".bak");
                    let _ = fs::rename(&path, PathBuf::from(bak));
                    FileV1::default()
                }
            },
            Err(_) => FileV1::default(),
        };
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    /// Atomic replace; the caller holds the lock.
    fn save(&self, f: &FileV1) {
        let Ok(json) = serde_json::to_vec_pretty(f) else {
            return;
        };
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        if fs::write(&tmp, &json).is_err() {
            eprintln!("conduit: could not write mobile-devices.json");
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        #[cfg(windows)]
        {
            let _ = fs::remove_file(&self.path);
        }
        if fs::rename(&tmp, &self.path).is_err() {
            eprintln!("conduit: could not commit mobile-devices.json");
        }
    }

    pub fn enabled(&self) -> bool {
        self.inner.lock().unwrap().enabled
    }

    pub fn set_enabled(&self, on: bool) {
        let mut g = self.inner.lock().unwrap();
        g.version = 1;
        g.enabled = on;
        self.save(&g);
    }

    pub fn port(&self) -> Option<u16> {
        self.inner.lock().unwrap().port
    }

    pub fn set_port(&self, p: u16) {
        let mut g = self.inner.lock().unwrap();
        g.version = 1;
        g.port = Some(p);
        self.save(&g);
    }

    /// Returns the record and the plaintext token (shown once, never stored).
    pub fn add_device(&self, name: &str, login: Option<String>) -> (Device, String) {
        let token = mint_secret();
        let d = Device {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            token_hash: sha256_hex(&token),
            tailscale_login: login,
            created_at: now_secs(),
            last_seen: None,
        };
        let mut g = self.inner.lock().unwrap();
        g.version = 1;
        g.devices.push(d.clone());
        self.save(&g);
        (d, token)
    }

    /// Hash the presented token and compare hash-to-hash against every device
    /// (no early exit), then stamp `last_seen`.
    pub fn verify(&self, token: &str) -> Option<String> {
        let presented = sha256_hex(token);
        let mut g = self.inner.lock().unwrap();
        let mut found = None;
        for (i, d) in g.devices.iter().enumerate() {
            if crate::cli_open::secret_eq(&presented, &d.token_hash) {
                found = Some(i);
            }
        }
        let i = found?;
        g.devices[i].last_seen = Some(now_secs());
        let id = g.devices[i].id.clone();
        self.save(&g);
        Some(id)
    }

    pub fn revoke(&self, id: &str) -> bool {
        let mut g = self.inner.lock().unwrap();
        let before = g.devices.len();
        g.devices.retain(|d| d.id != id);
        let removed = g.devices.len() != before;
        if removed {
            self.save(&g);
        }
        removed
    }

    pub fn list(&self) -> Vec<DeviceView> {
        self.inner
            .lock()
            .unwrap()
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

/// Persists the switch only; the bridge controller reconcile is wired in a later task.
#[tauri::command]
pub fn mobile_set_enabled(state: tauri::State<'_, Arc<MobileDevices>>, on: bool) {
    state.set_enabled(on);
}

#[tauri::command]
pub fn mobile_revoke_device(state: tauri::State<'_, Arc<MobileDevices>>, id: String) -> bool {
    state.revoke(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("conduit-mobile-{}.json", uuid::Uuid::new_v4()))
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
        let bak = PathBuf::from(format!("{}.bak", p.display()));
        assert_eq!(fs::read_to_string(&bak).unwrap(), "{not json");
        m.set_enabled(true);
        assert_eq!(fs::read_to_string(&bak).unwrap(), "{not json");
        let _ = fs::remove_file(&bak);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn round_trip_persists_enabled_port_devices() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        m.set_enabled(true);
        m.set_port(8460);
        let (d, _) = m.add_device("Pixel", Some("a@b.c".into()));
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
        let (d, token) = m.add_device("iPhone", None);
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
        m.add_device("iPhone", None);
        assert_eq!(m.verify("nope"), None);
        assert_eq!(m.verify(""), None);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn revoked_device_cannot_verify() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        let (d, token) = m.add_device("iPhone", None);
        assert!(m.revoke(&d.id));
        assert!(!m.revoke(&d.id));
        assert_eq!(m.verify(&token), None);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn list_omits_token_hash() {
        let p = tmp();
        let m = MobileDevices::load(p.clone());
        let (d, _) = m.add_device("iPhone", None);
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
        m.set_enabled(true);
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
