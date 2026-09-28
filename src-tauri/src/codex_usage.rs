//! Read Codex's own rate-limit snapshots from local rollout token_count events.
//! No account API call or token estimate is needed. Missing or expired windows stay unknown.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const TAIL_BYTES: u64 = 512 * 1024;
const MAX_FILES: usize = 32;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWindow {
    pub kind: &'static str,
    pub used_percent: f64,
    pub resets_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub windows: Vec<CodexWindow>,
    pub stale: bool,
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
}

/// Only the known Codex 5-hour and weekly windows can enter the meter. A changed
/// rollout schema or window duration yields unknown instead of a misleading label.
fn parse_rate_limits(body: &str, now: u64) -> Option<Vec<CodexWindow>> {
    let mut latest = None;
    for line in body.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(rate) = v.pointer("/payload/rate_limits") else {
            continue;
        };
        if rate.get("limit_id").and_then(Value::as_str) != Some("codex") {
            continue;
        }
        let mut windows = Vec::new();
        for (field, minutes, kind) in [
            ("primary", 300, "fiveHour"),
            ("secondary", 10_080, "weekly"),
        ] {
            let Some(w) = rate.get(field) else { continue };
            let (Some(used), Some(actual_minutes), Some(resets_at)) = (
                w.get("used_percent").and_then(Value::as_f64),
                w.get("window_minutes").and_then(Value::as_u64),
                w.get("resets_at").and_then(Value::as_u64),
            ) else {
                continue;
            };
            if actual_minutes == minutes
                && used.is_finite()
                && (0.0..=100.0).contains(&used)
                && resets_at > now
                && resets_at <= now.saturating_add(minutes * 60)
            {
                windows.push(CodexWindow {
                    kind,
                    used_percent: used,
                    resets_at,
                });
            }
        }
        latest = Some(windows);
    }
    latest.filter(|w| !w.is_empty())
}

fn collect_rollouts(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    // Codex names these paths sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl.
    // Descending names visit recent sessions first without statting every file.
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    for entry in entries {
        if out.len() >= MAX_FILES {
            break;
        }
        let path = entry.path();
        if depth < 3 && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            collect_rollouts(&path, depth + 1, out);
        } else if depth == 3
            && path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
        {
            out.push(path);
        }
    }
}

fn read_tail(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let mut body = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        body = body.split_once('\n')?.1.to_string();
    }
    Some(body)
}

fn read_usage(home: &Path, now: u64) -> Option<CodexUsage> {
    let mut files = Vec::new();
    collect_rollouts(&home.join("sessions"), 0, &mut files);
    for path in files {
        let Some(body) = read_tail(&path) else {
            continue;
        };
        if let Some(windows) = parse_rate_limits(&body, now) {
            let modified = path.metadata().ok()?.modified().ok()?;
            let age = modified.duration_since(UNIX_EPOCH).ok()?.as_secs();
            return Some(CodexUsage {
                windows,
                stale: now.saturating_sub(age) > 15 * 60,
            });
        }
    }
    None
}

/// A bounded disk scan runs off the UI thread. `None` means no trustworthy reading.
#[tauri::command(async)]
pub async fn fetch_codex_usage() -> Result<Option<CodexUsage>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = codex_home()?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        read_usage(&home, now)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_token_count_shape_yields_both_windows() {
        let body = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":100}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":21.0,"window_minutes":300,"resets_at":2000},"secondary":{"used_percent":4.0,"window_minutes":10080,"resets_at":3000}}}}"#;
        let windows = parse_rate_limits(body, 1000).unwrap();
        assert_eq!(windows[0].kind, "fiveHour");
        assert_eq!(windows[0].used_percent, 21.0);
        assert_eq!(windows[1].kind, "weekly");
        assert_eq!(windows[1].resets_at, 3000);
    }

    #[test]
    fn malformed_or_expired_limits_do_not_become_healthy_zeros() {
        let body = r#"{"payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":80,"window_minutes":300,"resets_at":100},"secondary":{"used_percent":-1,"window_minutes":10080,"resets_at":3000}}}}"#;
        assert!(parse_rate_limits(body, 1000).is_none());
        assert!(parse_rate_limits("not json", 1000).is_none());
    }

    #[test]
    fn most_recent_snapshot_wins() {
        let line = |used| {
            format!(
                r#"{{"payload":{{"type":"token_count","rate_limits":{{"limit_id":"codex","primary":{{"used_percent":{used},"window_minutes":300,"resets_at":2000}}}}}}}}"#
            )
        };
        let body = format!("{}\n{}", line(10), line(67));
        assert_eq!(
            parse_rate_limits(&body, 1000).unwrap()[0].used_percent,
            67.0
        );
    }

    #[test]
    fn rollout_scan_stops_at_limit_in_newest_named_day() {
        let root = std::env::temp_dir().join(format!(
            "conduit_codex_usage_scan_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for day in ["01", "02"] {
            let dir = root.join("2026").join("09").join(day);
            fs::create_dir_all(&dir).unwrap();
            for n in 0..MAX_FILES {
                fs::write(
                    dir.join(format!("rollout-2026-09-{day}T12-{n:02}.jsonl")),
                    "",
                )
                .unwrap();
            }
        }
        let mut out = Vec::new();
        collect_rollouts(&root, 0, &mut out);
        assert_eq!(out.len(), MAX_FILES);
        assert!(out.iter().all(
            |p| p.to_string_lossy().contains("/02/") || p.to_string_lossy().contains("\\02\\")
        ));
        fs::remove_dir_all(root).unwrap();
    }
}
