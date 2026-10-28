//! OpenRouter spend, for the usage bar.
//!
//! Every other meter in Conduit measures a SUBSCRIPTION: a rolling window with a cap, where
//! the useful number is "what fraction have I burned". OpenRouter is not that. It is
//! prepaid credit, so the honest numbers are dollars spent and dollars left, and a key may
//! legitimately have no cap at all.
//!
//!   GET https://openrouter.ai/api/v1/key
//!   Authorization: Bearer <key>
//!   -> { "data": { "label", "usage", "limit", "limit_remaining", "is_free_tier",
//!                  "usage_daily", "usage_weekly", "usage_monthly", ... } }
//!
//! `limit` is "credit limit for the key, or null if unlimited", and `limit_remaining`
//! likewise. **A null limit is the normal case, not an error** -- an uncapped key on a
//! funded account reports only what it has spent. That is why this module reports
//! `limit`/`remaining` as `Option` and never invents a denominator: a meter drawn against a
//! guessed cap is worse than no meter, and the row builder turns the capless case into a
//! plain figure rather than a bar.
//!
//! Secrets: the key is held in Conduit's memory (never on disk -- see `Store::provider_key`)
//! and reaches curl through STDIN via `-H @-`, so it never appears on a command line where
//! any local process could read it from a process listing. It is never logged, and never
//! echoed into an error string.

use serde::Serialize;

use crate::agent::AgentId;
use crate::NoWindow;

/// The documented key-info endpoint. `/api/v1/credits` is NOT used: it is undocumented and
/// reports account-wide totals, while this one answers for the key actually in use -- which
/// is what a per-agent meter has to show when two agents hold two different keys.
const KEY_ENDPOINT: &str = "https://openrouter.ai/api/v1/key";

/// One agent's OpenRouter spend.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterUsage {
    /// Which agent's endpoint this key belongs to. Two agents may hold different keys.
    pub agent: AgentId,
    /// The key's own label from OpenRouter, when it names one.
    pub label: String,
    /// Credits spent, all time (dollars).
    pub spent: f64,
    /// Credit limit on this key, or None when it is uncapped.
    pub limit: Option<f64>,
    /// Credits left on this key, or None when it is uncapped.
    pub remaining: Option<f64>,
    pub usage_daily: Option<f64>,
    pub usage_weekly: Option<f64>,
    pub usage_monthly: Option<f64>,
    pub is_free_tier: bool,
    /// "live" -- read from the API.
    /// "disconnected" -- no key held, i.e. nothing to ask with.
    /// "unavailable" -- a key is held but the call failed or answered a shape we do not know.
    ///
    /// Three states because the fixes differ: "disconnected" means paste a key, while
    /// "unavailable" means the key is rejected or the surface moved.
    pub source: String,
}

impl OpenRouterUsage {
    fn empty(agent: AgentId, source: &str) -> Self {
        OpenRouterUsage {
            agent,
            label: String::new(),
            spent: 0.0,
            limit: None,
            remaining: None,
            usage_daily: None,
            usage_weekly: None,
            usage_monthly: None,
            is_free_tier: false,
            source: source.to_string(),
        }
    }
}

/// Read a number that the API may send as a JSON number OR as a decimal string.
///
/// OpenRouter sends per-token prices as strings elsewhere in its API (see
/// `local_llm::price_per_million`), so accepting both here costs nothing and stops a future
/// type change from silently zeroing the meter.
fn num(v: Option<&serde_json::Value>) -> Option<f64> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Parse `GET /api/v1/key`. Pure, so it carries the tests -- this is the part that can be
/// verified without an account.
///
/// Accepts the documented `{"data": {...}}` envelope and a bare object, the same tolerance
/// `commandcode_usage` applies for the same reason: an API that moves should degrade to
/// "unavailable" on a shape we truly cannot read, not on a wrapper appearing or vanishing.
///
/// `usage` is the only required field. A response with no `usage` is not a zero-spend
/// account, it is a response we did not understand -- so it yields None and the caller
/// reports "unavailable" rather than drawing a confident $0.00.
pub fn parse_key_info(agent: AgentId, body: &str) -> Option<OpenRouterUsage> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    let d = root.get("data").unwrap_or(&root);
    let spent = num(d.get("usage"))?;
    Some(OpenRouterUsage {
        agent,
        label: d
            .get("label")
            .and_then(|l| l.as_str())
            .unwrap_or_default()
            .to_string(),
        spent,
        limit: num(d.get("limit")),
        remaining: num(d.get("limit_remaining")),
        usage_daily: num(d.get("usage_daily")),
        usage_weekly: num(d.get("usage_weekly")),
        usage_monthly: num(d.get("usage_monthly")),
        is_free_tier: d
            .get("is_free_tier")
            .and_then(|f| f.as_bool())
            .unwrap_or(false),
        source: "live".to_string(),
    })
}

/// GET the key endpoint with the bearer fed through STDIN, so the secret never reaches a
/// process listing. None on any failure -- including curl itself being absent.
fn fetch(key: &str) -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("curl")
        .args(["-s", "--max-time", "10", "-H", "@-", KEY_ENDPOINT])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .no_window()
        .spawn()
        .ok()?;
    child
        .stdin
        .take()?
        .write_all(format!("Authorization: Bearer {key}\n").as_bytes())
        .ok()?;
    let out = child.wait_with_output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Spend for every agent currently routed at OpenRouter.
///
/// Scoped to agents whose endpoint is ENABLED and set to the `openrouter` preset: a key
/// held for an endpoint the user has since switched away from is not something to bill a
/// meter against, and polling for it would keep a stale row on screen.
#[tauri::command]
pub async fn openrouter_usage(
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<Vec<OpenRouterUsage>, String> {
    let targets: Vec<(AgentId, Option<String>)> = store
        .all_provider_settings()
        .into_iter()
        .filter(|(_, s)| s.enabled && s.preset == "openrouter")
        .map(|(agent, _)| (agent, store.provider_key(agent)))
        .collect();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        targets
            .into_iter()
            .map(|(agent, key)| match key {
                None => OpenRouterUsage::empty(agent, "disconnected"),
                Some(k) => fetch(&k)
                    .and_then(|body| parse_key_info(agent, &body))
                    .unwrap_or_else(|| OpenRouterUsage::empty(agent, "unavailable")),
            })
            .collect()
    })
    .await
    .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"{"data":{
        "label":"conduit key","usage":12.4,"limit":50,"limit_remaining":37.6,
        "is_free_tier":false,"usage_daily":1.25,"usage_weekly":6.5,"usage_monthly":12.4}}"#;

    #[test]
    fn reads_spend_and_headroom() {
        let u = parse_key_info(AgentId::Hermes, FULL).expect("parses");
        assert_eq!(u.spent, 12.4);
        assert_eq!(u.limit, Some(50.0));
        assert_eq!(u.remaining, Some(37.6));
        assert_eq!(u.usage_daily, Some(1.25));
        assert_eq!(u.label, "conduit key");
        assert_eq!(u.source, "live");
        assert_eq!(u.agent, AgentId::Hermes);
    }

    #[test]
    fn an_uncapped_key_reports_spend_with_no_denominator() {
        // The NORMAL case for a funded account. Inventing a cap here would draw a bar
        // against a number the API explicitly declined to give.
        let u = parse_key_info(
            AgentId::OpenCode,
            r#"{"data":{"usage":3.5,"limit":null,"limit_remaining":null}}"#,
        )
        .expect("parses");
        assert_eq!(u.spent, 3.5);
        assert_eq!(u.limit, None);
        assert_eq!(u.remaining, None);
    }

    #[test]
    fn a_bare_object_parses_like_a_wrapped_one() {
        let u = parse_key_info(AgentId::Hermes, r#"{"usage":1.0}"#).expect("parses");
        assert_eq!(u.spent, 1.0);
    }

    #[test]
    fn numbers_sent_as_strings_are_accepted() {
        // OpenRouter sends prices as decimal strings elsewhere; a type change here must
        // not silently zero the meter.
        let u =
            parse_key_info(AgentId::Hermes, r#"{"usage":"2.50","limit":"10"}"#).expect("parses");
        assert_eq!(u.spent, 2.5);
        assert_eq!(u.limit, Some(10.0));
    }

    #[test]
    fn a_shape_without_usage_is_unknown_not_zero() {
        // A confident $0.00 over a response we did not understand is the failure mode this
        // avoids: the caller reports "unavailable" instead.
        assert!(parse_key_info(AgentId::Hermes, r#"{"data":{"limit":50}}"#).is_none());
        assert!(parse_key_info(AgentId::Hermes, "not json").is_none());
        assert!(parse_key_info(AgentId::Hermes, r#"{"error":{"message":"invalid"}}"#).is_none());
    }

    #[test]
    fn the_free_tier_flag_survives() {
        let u = parse_key_info(AgentId::Hermes, r#"{"usage":0,"is_free_tier":true}"#).unwrap();
        assert!(u.is_free_tier);
    }
}
