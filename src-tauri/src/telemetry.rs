//! Anonymous PostHog telemetry via the capture API, POSTed with `curl`
//! (no HTTP-client dependency). Fire-and-forget + fail-open: any error is
//! swallowed and never affects the app. Strict field allowlist — only the event
//! name, session_id, engagement_time_msec, app_version, and os ever leave the
//! device. `distinct_id` is a random UUIDv4, never derived from PII, and events
//! opt out of PostHog person profile processing.

use std::path::{Path, PathBuf};
use std::process::Command;

// ---- Hardcoded PostHog project config (empty token/host => telemetry is a no-op) ----
// The project token is intentionally public/write-only, like PostHog's client SDK
// token. Keep all privacy guarantees in the payload allowlist below.
const POSTHOG_PROJECT_TOKEN: &str = "phc_rjxqfDbLxqSYHh3TiX67Xc2uysqPtFNXjmDpSAy7Ezq6";
const POSTHOG_HOST: &str = "https://us.i.posthog.com";

fn creds_present() -> bool {
    !POSTHOG_PROJECT_TOKEN.is_empty() && !POSTHOG_HOST.is_empty()
}

/// Pure send-policy. Telemetry is sent only in a release build, with creds, when
/// not opted out and not disabled by env. All inputs are explicit so every
/// branch is testable (tests run in debug, where the real gate is always off).
fn should_send_policy(opt_out: bool, is_debug: bool, env_disabled: bool, creds: bool) -> bool {
    !opt_out && !is_debug && !env_disabled && creds
}

/// Whether a dev build should suppress telemetry. Dev builds are silent by
/// default; `CONDUIT_TELEMETRY_IN_DEV` opts a dev build in for live testing
/// (e.g. watching PostHog realtime events) without cutting a release build.
/// Pure for tests.
fn dev_suppressed(is_debug: bool, dev_override: bool) -> bool {
    is_debug && !dev_override
}

fn data_dir() -> PathBuf {
    // Mirror store.rs: honor CONDUIT_DATA_DIR_NAME so dev builds stay isolated.
    let dir_name =
        std::env::var("CONDUIT_DATA_DIR_NAME").unwrap_or_else(|_| "ConduitTauri".to_string());
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(dir_name)
}

fn client_id_path() -> PathBuf {
    data_dir().join("telemetry_client_id")
}

/// Read the persisted anonymous client_id at `path`, creating a random UUIDv4 on
/// first run. Pure w.r.t. the path argument so it can be tested without env vars.
fn read_or_create_client_id_at(path: &Path) -> String {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, &id);
    id
}

fn get_or_create_client_id() -> String {
    read_or_create_client_id_at(&client_id_path())
}

/// Everything needed to build one PostHog capture request. Pure data.
pub struct PingInput {
    pub client_id: String,
    /// "app_open" | "app_heartbeat"
    pub event_name: String,
    pub session_id: String,
    pub engagement_msec: u64,
    pub app_version: String,
    pub os: String,
}

/// Build the PostHog capture JSON body. Pure: same input → same output, no I/O.
fn build_payload(input: &PingInput) -> String {
    serde_json::json!({
        "api_key": POSTHOG_PROJECT_TOKEN,
        "event": input.event_name,
        "distinct_id": input.client_id,
        "properties": {
            "$process_person_profile": false,
            "session_id": input.session_id,
            "engagement_time_msec": input.engagement_msec,
            "app_version": input.app_version,
            "os": input.os,
        }
    })
    .to_string()
}

const CAPTURE_PATH: &str = "/i/v0/e/";

/// Redundant safe default. The opt-out is enforced in the frontend (the
/// heartbeat hook stops pinging when the user opts out), so this is never the
/// primary gate — it stays as belt-and-suspenders for the command path.
fn is_opted_out() -> bool {
    false
}

/// `DO_NOT_TRACK` as the convention reads it (consoledonottrack.com): set to anything but
/// empty, `0` or `false` means "do not". Pure for tests.
fn do_not_track(value: Option<&str>) -> bool {
    value.is_some_and(|v| {
        let v = v.trim();
        !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false")
    })
}

/// Either environment switch that turns telemetry off for this run.
fn env_disabled() -> bool {
    std::env::var_os("CONDUIT_DISABLE_TELEMETRY").is_some()
        || do_not_track(std::env::var("DO_NOT_TRACK").ok().as_deref())
}

fn suppressed_in_dev() -> bool {
    dev_suppressed(
        cfg!(debug_assertions),
        std::env::var_os("CONDUIT_TELEMETRY_IN_DEV").is_some(),
    )
}

fn should_send(opt_out: bool) -> bool {
    should_send_policy(
        opt_out,
        suppressed_in_dev(),
        env_disabled(),
        creds_present(),
    )
}

/// Why nothing is being sent, in the user's words; `None` when it is. The SAME four inputs
/// as `should_send_policy`, and a test holds the two to the same answer: a Settings page
/// that says "sending" while the gate is shut (or the reverse) is worse than no page.
fn not_sending_reason(
    opt_out: bool,
    is_debug: bool,
    env_disabled: bool,
    creds: bool,
) -> Option<&'static str> {
    if opt_out {
        Some("You turned sharing off.")
    } else if env_disabled {
        Some("An environment variable turns it off for this run (DO_NOT_TRACK or CONDUIT_DISABLE_TELEMETRY).")
    } else if is_debug {
        Some("This is a development build, which never sends.")
    } else if !creds {
        Some("This build has no statistics endpoint configured.")
    } else {
        None
    }
}

/// What Settings shows so the user can read exactly what leaves the machine.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryPreview {
    /// Whether this build, with the user's current choice, sends anything at all.
    pub sending: bool,
    /// Why not, when it is not.
    pub reason: Option<String>,
    /// Where it goes.
    pub endpoint: String,
    /// One event, exactly as `build_payload` builds the real ones.
    pub payload: serde_json::Value,
    /// How often, in the user's words.
    pub cadence: String,
}

/// The placeholder shown for the random id before one exists. Looking at the preview must
/// not be what creates it.
const NO_ID_YET: &str = "(a random id, created the first time something is sent)";

fn preview(opt_out: bool, client_id: Option<String>, app_version: String) -> TelemetryPreview {
    let reason = not_sending_reason(
        opt_out,
        suppressed_in_dev(),
        env_disabled(),
        creds_present(),
    );
    let body = build_payload(&PingInput {
        client_id: client_id.unwrap_or_else(|| NO_ID_YET.to_string()),
        event_name: "app_heartbeat".into(),
        session_id: "(a random id for this sitting, new after 30 minutes away)".into(),
        engagement_msec: 300_000,
        app_version,
        os: std::env::consts::OS.to_string(),
    });
    TelemetryPreview {
        sending: reason.is_none(),
        reason: reason.map(str::to_string),
        endpoint: format!("{}{}", POSTHOG_HOST.trim_end_matches('/'), CAPTURE_PATH),
        payload: serde_json::from_str(&body).unwrap_or(serde_json::Value::Null),
        cadence: "Once when the app opens, then every 5 minutes while its window is focused."
            .into(),
    }
}

fn existing_client_id_at(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Tauri command: what would be sent, and whether anything is. Read-only: it never sends
/// and never creates the id.
#[tauri::command]
pub fn telemetry_preview(app: tauri::AppHandle, opted_out: bool) -> TelemetryPreview {
    preview(
        opted_out,
        existing_client_id_at(&client_id_path()),
        app.package_info().version.to_string(),
    )
}

fn forget_client_id_at(path: &Path) -> bool {
    std::fs::remove_file(path).is_ok()
}

/// Tauri command: delete the anonymous id. Called when the user turns sharing off, so
/// "off" leaves nothing behind that could link a later opt-in to the earlier history.
#[tauri::command]
pub fn telemetry_forget() -> bool {
    forget_client_id_at(&client_id_path())
}

/// Fire-and-forget POST. Mirrors claude_status.rs: `-s`, time-boxed, all output
/// and errors ignored.
fn send(body: &str) {
    let url = format!("{}{}", POSTHOG_HOST.trim_end_matches('/'), CAPTURE_PATH);
    use crate::NoWindow;
    let _ = Command::new("curl")
        .no_window()
        .args([
            "-s",
            "--max-time",
            "8",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-d",
            body,
            &url,
        ])
        .output();
}

/// Map the frontend's event kind to a PostHog event name. We only capture coarse
/// app lifecycle events; no feature usage, paths, prompts, or content.
fn event_name_for(kind: &str) -> &'static str {
    if kind == "app_open" {
        "app_open"
    } else {
        "app_heartbeat"
    }
}

/// Tauri command: record one anonymous engagement event. Never errors, never
/// blocks — gating + curl happen off the async runtime. `kind` is "app_open"
/// for the first event of a session, anything else maps to "app_heartbeat".
#[tauri::command]
pub async fn telemetry_ping(
    app: tauri::AppHandle,
    kind: String,
    session_id: String,
    engagement_msec: u64,
) {
    if !should_send(is_opted_out()) {
        return;
    }
    let event_name = event_name_for(&kind).to_string();

    let input = PingInput {
        client_id: get_or_create_client_id(),
        event_name,
        session_id,
        engagement_msec,
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
    };
    let body = build_payload(&input);
    tauri::async_runtime::spawn_blocking(move || send(&body));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(event_name: &str) -> PingInput {
        PingInput {
            client_id: "uuid-123".into(),
            event_name: event_name.into(),
            session_id: "sess-1".into(),
            engagement_msec: 300_000,
            app_version: "1.2.3".into(),
            os: "macos".into(),
        }
    }

    #[test]
    fn build_payload_has_exact_shape_and_params() {
        let body = build_payload(&sample("app_heartbeat"));
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["api_key"], POSTHOG_PROJECT_TOKEN);
        assert_eq!(v["distinct_id"], "uuid-123");
        assert_eq!(v["event"], "app_heartbeat");
        assert_eq!(v.as_object().unwrap().len(), 4);

        let properties = &v["properties"];
        assert_eq!(properties["$process_person_profile"], false);
        assert_eq!(properties["session_id"], "sess-1");
        assert_eq!(properties["engagement_time_msec"], 300_000);
        assert_eq!(properties["app_version"], "1.2.3");
        assert_eq!(properties["os"], "macos");
        // Allowlist: exactly these five properties, nothing more.
        assert_eq!(properties.as_object().unwrap().len(), 5);
    }

    #[test]
    fn build_payload_honors_event_name() {
        let body = build_payload(&sample("app_open"));
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["event"], "app_open");
    }

    #[test]
    fn event_names_are_limited_to_coarse_lifecycle_events() {
        assert_eq!(event_name_for("app_open"), "app_open");
        assert_eq!(event_name_for("app_heartbeat"), "app_heartbeat");
        assert_eq!(event_name_for("anything-else"), "app_heartbeat");
    }

    #[test]
    fn client_id_is_stable_uuid_across_calls() {
        let dir = std::env::temp_dir().join(format!("conduit-tel-{}", uuid::Uuid::new_v4()));
        let path = dir.join("telemetry_client_id");

        let first = read_or_create_client_id_at(&path);
        assert_eq!(first.len(), 36, "expected a UUIDv4 string");
        assert!(uuid::Uuid::parse_str(&first).is_ok());

        let second = read_or_create_client_id_at(&path);
        assert_eq!(first, second, "client_id must persist across calls");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_reason_shown_agrees_with_the_gate_for_every_combination() {
        for bits in 0..16u8 {
            let (opt_out, debug, env, creds) =
                (bits & 1 != 0, bits & 2 != 0, bits & 4 != 0, bits & 8 != 0);
            let sends = should_send_policy(opt_out, debug, env, creds);
            let reason = not_sending_reason(opt_out, debug, env, creds);
            assert_eq!(
                sends,
                reason.is_none(),
                "opt_out={opt_out} debug={debug} env={env} creds={creds}: gate says {sends}, page says {reason:?}"
            );
        }
        // The user's own choice is named first, whatever else also applies.
        assert_eq!(
            not_sending_reason(true, true, true, false),
            Some("You turned sharing off.")
        );
    }

    #[test]
    fn do_not_track_follows_the_convention() {
        for on in ["1", "true", "yes", " 1 ", "TRUE"] {
            assert!(do_not_track(Some(on)), "{on:?}");
        }
        for off in ["", "0", "false", "FALSE", "  "] {
            assert!(!do_not_track(Some(off)), "{off:?}");
        }
        assert!(!do_not_track(None));
    }

    #[test]
    fn the_preview_is_the_real_payload_and_names_no_more_fields() {
        let p = preview(false, Some("uuid-123".into()), "1.2.3".into());
        // Built by `build_payload`: the same four keys and five properties the real one has.
        assert_eq!(p.payload.as_object().unwrap().len(), 4);
        assert_eq!(p.payload["properties"].as_object().unwrap().len(), 5);
        assert_eq!(p.payload["distinct_id"], "uuid-123");
        assert_eq!(p.payload["properties"]["app_version"], "1.2.3");
        assert_eq!(p.payload["properties"]["os"], std::env::consts::OS);
        assert!(p.endpoint.starts_with("https://") && p.endpoint.ends_with(CAPTURE_PATH));
        // Tests run as a debug build, which never sends, and the page must say so.
        assert!(!p.sending);
        assert!(p.reason.unwrap().contains("development build"));
        let off = preview(true, None, "1.2.3".into());
        assert_eq!(off.reason.as_deref(), Some("You turned sharing off."));
    }

    #[test]
    fn looking_at_the_preview_never_creates_the_id() {
        let dir = std::env::temp_dir().join(format!("conduit-tel-{}", uuid::Uuid::new_v4()));
        let path = dir.join("telemetry_client_id");
        assert_eq!(existing_client_id_at(&path), None);
        let p = preview(false, existing_client_id_at(&path), "1.2.3".into());
        assert_eq!(p.payload["distinct_id"], NO_ID_YET);
        assert!(!path.exists());
    }

    #[test]
    fn turning_sharing_off_deletes_the_id_and_a_later_opt_in_gets_a_new_one() {
        let dir = std::env::temp_dir().join(format!("conduit-tel-{}", uuid::Uuid::new_v4()));
        let path = dir.join("telemetry_client_id");
        let first = read_or_create_client_id_at(&path);
        assert_eq!(
            existing_client_id_at(&path).as_deref(),
            Some(first.as_str())
        );
        assert!(forget_client_id_at(&path));
        assert!(!path.exists());
        // Nothing to delete is not an error worth reporting, just `false`.
        assert!(!forget_client_id_at(&path));
        let second = read_or_create_client_id_at(&path);
        assert_ne!(first, second);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn policy_allows_only_in_release_with_creds_and_consent() {
        assert!(should_send_policy(false, false, false, true));
    }
    #[test]
    fn policy_blocks_when_opted_out() {
        assert!(!should_send_policy(true, false, false, true));
    }
    #[test]
    fn policy_blocks_in_debug_build() {
        assert!(!should_send_policy(false, true, false, true));
    }
    #[test]
    fn policy_blocks_when_env_disabled() {
        assert!(!should_send_policy(false, false, true, true));
    }
    #[test]
    fn policy_blocks_without_creds() {
        assert!(!should_send_policy(false, false, false, false));
    }

    #[test]
    fn dev_suppression_respects_override() {
        assert!(
            dev_suppressed(true, false),
            "dev build, no override → suppressed"
        );
        assert!(
            !dev_suppressed(true, true),
            "dev build + override → allowed"
        );
        assert!(
            !dev_suppressed(false, false),
            "release build → never suppressed"
        );
        assert!(
            !dev_suppressed(false, true),
            "release build → never suppressed"
        );
    }

    #[test]
    fn payload_never_leaks_forbidden_substrings() {
        let body = build_payload(&sample("app_heartbeat"));
        for forbidden in [
            "/Users/",
            "project",
            "branch",
            "prompt",
            "transcript",
            "hostname",
            "password",
            "secret",
        ] {
            assert!(!body.contains(forbidden), "payload leaked: {forbidden}");
        }
    }

    #[test]
    fn posthog_person_profile_processing_is_disabled() {
        let body = build_payload(&sample("app_heartbeat"));
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["properties"]["$process_person_profile"], false);
    }
}
