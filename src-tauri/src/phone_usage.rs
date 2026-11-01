//! The phone's `usage` reply: one row per agent account, built from CACHED reads only.
//!
//! Nothing here fetches. Claude's plan windows come from `ClaudeAuth`'s last good read,
//! agy's from the last status-line snapshot (`AgyUsageState`), Command Code's and
//! OpenRouter's from the last result of the desktop's own polls (remembered below by the
//! Tauri commands that make them). `/api/oauth/usage` rate-limits and the `claude` CLI
//! competes with Conduit for the same budget (see CLAUDE.md, "Where the usage meter's
//! semantics live") -- a phone asking must never add a request.
//!
//! The vocabulary is `src/usageRows.ts`'s: `used` is the fraction CONSUMED, and window
//! labels come from the same kind table (`windowLabel`), so the phone and the desktop name
//! the same window the same way.
//!
//! A session's `usageKey` (in the `projects` frame) names its row by an OPAQUE key: a short
//! hash of agent + account, never the account id or a config path.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agent::AgentId;
use crate::agy_usage::AgyUsage;
use crate::claude_usage::{account_key, PlanWindow};
use crate::commandcode_usage::CommandCodeAccountUsage;
use crate::openrouter_usage::OpenRouterUsage;
use crate::store::{Project, Session};

/// A rebuilt reply is served for this long before the caches are read again.
pub const REBUILD_GAP: Duration = Duration::from_secs(30);
/// A Claude read younger than this is reported `live`: the desktop re-polls every 5 min.
const CLAUDE_LIVE_MAX_SECS: u64 = 6 * 60;
/// An agy snapshot younger than this is `live`; agy only reports while it runs.
const AGY_LIVE_MAX_MS: i64 = 10 * 60 * 1000;

/// The last Command Code poll (epoch ms, rows).
static COMMAND_CODE: Mutex<Option<(i64, Vec<CommandCodeAccountUsage>)>> = Mutex::new(None);
/// The last OpenRouter poll (epoch ms, rows).
static OPENROUTER: Mutex<Option<(i64, Vec<OpenRouterUsage>)>> = Mutex::new(None);
/// The last built rows, so a burst of phones (or `projects` pushes) reads the caches once.
static BUILT: Mutex<Option<(Instant, Vec<Value>)>> = Mutex::new(None);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Called by `fetch_command_code_usage` with every result it returns to the desktop.
pub fn remember_command_code(rows: &[CommandCodeAccountUsage]) {
    *COMMAND_CODE.lock().unwrap_or_else(|e| e.into_inner()) = Some((now_ms(), rows.to_vec()));
}

/// Called by `openrouter_usage` with every result it returns to the desktop.
pub fn remember_openrouter(rows: &[OpenRouterUsage]) {
    *OPENROUTER.lock().unwrap_or_else(|e| e.into_inner()) = Some((now_ms(), rows.to_vec()));
}

/// The opaque row key for an agent tag (`claude`, `openrouter:hermes`) and account key
/// (`default` or an account id): `u` + 12 hex digits of a domain-separated SHA-256. Stable
/// for the same pair, so a session's `usageKey` and its row's `key` match; one-way, so
/// neither reveals the account id.
pub fn usage_key(tag: &str, account: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"conduit-usage\0");
    h.update(tag.as_bytes());
    h.update(b"\0");
    h.update(account.as_bytes());
    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    format!("u{}", &hex[..12])
}

/// `usageRows.ts` `claudeKind`: Claude and Command Code label their windows in prose.
fn claude_kind(label: &str) -> &'static str {
    if label.contains("Opus") {
        "weeklyOpus"
    } else if label.to_lowercase().contains("week") {
        "weekly"
    } else {
        "fiveHour"
    }
}

/// `usageRows.ts` `agyKind`.
fn agy_kind(label: &str) -> &'static str {
    if label.to_lowercase().contains("week") {
        "weekly"
    } else {
        "fiveHour"
    }
}

/// `usageRows.ts` `KIND_LABEL`.
fn kind_label(kind: &str) -> &'static str {
    match kind {
        "fiveHour" => "5-hour",
        "weekly" => "Weekly",
        "weeklyOpus" => "Weekly · Opus",
        "context" => "Context",
        _ => "Credit",
    }
}

/// `usageRows.ts` `windowLabel`: a pool prefix survives only for agy.
pub fn window_label(kind: &str, pool: Option<&str>) -> String {
    match pool {
        Some(p) => format!("{p} · {}", kind_label(kind)),
        None => kind_label(kind).to_string(),
    }
}

/// agy's pool names, shortened exactly as `agyRow` does.
fn agy_pool(display: &str) -> String {
    if display.starts_with("Gemini") {
        "Gemini".into()
    } else if display.starts_with("Claude") {
        "Claude/GPT".into()
    } else {
        display.to_string()
    }
}

/// A reset time as RFC3339. Claude's endpoint answers either an RFC3339 string or an epoch
/// number (which `parse_plan` keeps as its decimal text).
fn rfc3339_reset(raw: Option<&str>) -> Value {
    let Some(r) = raw.map(str::trim).filter(|r| !r.is_empty()) else {
        return Value::Null;
    };
    match r.parse::<f64>() {
        Ok(n) if n.is_finite() && n > 0.0 => {
            // Seconds, unless it is plainly milliseconds.
            let secs = if n > 1e12 { n / 1000.0 } else { n };
            Value::String(crate::agy_transcript::rfc3339(secs as i64, 0))
        }
        Ok(_) => Value::Null,
        Err(_) => Value::String(r.to_string()),
    }
}

/// Epoch milliseconds as RFC3339 (the phone prefers ISO strings).
fn iso_ms(ms: i64) -> Value {
    Value::String(crate::agy_transcript::rfc3339(ms.div_euclid(1000), 0))
}

fn clamp01(n: f64) -> f64 {
    if n.is_finite() {
        n.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn plan_windows(windows: &[PlanWindow]) -> Vec<Value> {
    windows
        .iter()
        .map(|w| {
            let kind = claude_kind(&w.label);
            json!({
                "kind": kind,
                "label": window_label(kind, None),
                "used": clamp01(w.pct_used),
                "resetsAt": rfc3339_reset(w.resets_at.as_deref()),
            })
        })
        .collect()
}

fn agent_wire(agent: AgentId) -> String {
    serde_json::to_value(agent)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// A Claude account as the panel lists it: (account id, label, last good plan read + unix secs).
pub type ClaudeAccountInput = (Option<String>, String, Option<(Vec<PlanWindow>, u64)>);

/// Everything the rows are built from, gathered by `rows` (or a test).
#[derive(Default)]
pub struct UsageInputs {
    /// Claude accounts the desktop shows: (account id, label, last good plan read + unix secs).
    pub claude: Vec<ClaudeAccountInput>,
    pub agy: Vec<AgyUsage>,
    /// Account id -> its display label, for agy rows.
    pub account_labels: HashMap<String, String>,
    pub command_code: Option<(i64, Vec<CommandCodeAccountUsage>)>,
    pub openrouter: Option<(i64, Vec<OpenRouterUsage>)>,
    pub now_secs: u64,
}

/// The rows of a `usage` reply. Pure.
pub fn build_rows(i: &UsageInputs) -> Vec<Value> {
    let mut out = Vec::new();
    for (account_id, label, cached) in &i.claude {
        let acct = account_key(account_id.as_deref());
        let (windows, updated, source) = match cached {
            Some((w, at)) => {
                let age = i.now_secs.saturating_sub(*at);
                if age <= CLAUDE_LIVE_MAX_SECS {
                    (plan_windows(w), iso_ms((*at * 1000) as i64), "live")
                } else if age <= crate::claude_usage::PLAN_STALE_MAX_SECS {
                    (plan_windows(w), iso_ms((*at * 1000) as i64), "stale")
                } else {
                    // Too old to act on: admitting we do not know beats an old number.
                    (Vec::new(), iso_ms((*at * 1000) as i64), "unavailable")
                }
            }
            None => (Vec::new(), Value::Null, "unavailable"),
        };
        out.push(json!({
            "key": usage_key("claude", &acct),
            "agent": "claude",
            "label": label,
            "plan": Value::Null,
            "windows": windows,
            "updatedAt": updated,
            "source": source,
        }));
    }
    let now_ms = (i.now_secs as i64) * 1000;
    for u in &i.agy {
        let acct = account_key(u.account_id.as_deref());
        let label = u
            .account_id
            .as_ref()
            .and_then(|id| i.account_labels.get(id))
            .cloned()
            .unwrap_or_else(|| "Antigravity".into());
        let mut windows = Vec::new();
        for g in &u.groups {
            let pool = agy_pool(&g.display_name);
            for b in g.buckets.iter().filter(|b| !b.disabled) {
                let kind = agy_kind(&b.label);
                windows.push(json!({
                    "kind": kind,
                    "label": window_label(kind, Some(&pool)),
                    // agy reports headroom; flipped once, here, as `agyRow` does.
                    "used": 1.0 - clamp01(b.remaining_fraction),
                    "resetsAt": rfc3339_reset(b.resets_at.as_deref()),
                }));
            }
        }
        let models: Vec<&str> = u.groups.iter().map(|g| g.display_name.as_str()).collect();
        let source = if now_ms - u.updated_at <= AGY_LIVE_MAX_MS {
            "live"
        } else {
            "stale"
        };
        out.push(json!({
            "key": usage_key("antigravity", &acct),
            "agent": "antigravity",
            "label": label,
            "plan": u.plan_tier,
            "windows": windows,
            "models": models,
            "updatedAt": iso_ms(u.updated_at),
            "source": source,
        }));
    }
    if let Some((at, rows)) = &i.command_code {
        // "disconnected" = not signed in: the desktop shows no meter for it either.
        for r in rows.iter().filter(|r| r.usage.source != "disconnected") {
            let acct = account_key(r.account_id.as_deref());
            out.push(json!({
                "key": usage_key("commandcode", &acct),
                "agent": "commandcode",
                "label": r.label,
                "plan": Value::Null,
                "windows": plan_windows(r.usage.windows.as_deref().unwrap_or(&[])),
                "updatedAt": iso_ms(*at),
                "source": r.usage.source,
            }));
        }
    }
    if let Some((at, rows)) = &i.openrouter {
        for r in rows.iter().filter(|r| r.source != "disconnected") {
            let wire = agent_wire(r.agent);
            // `openRouterRow`: no cap means no denominator, so no fraction is invented.
            let capped = r.limit.is_some_and(|l| l > 0.0);
            let used = match r.limit {
                Some(l) if l > 0.0 => clamp01(r.spent / l),
                _ => 0.0,
            };
            let label = if r.label.trim().is_empty() {
                "OpenRouter".to_string()
            } else {
                r.label.trim().to_string()
            };
            out.push(json!({
                "key": usage_key(&format!("openrouter:{wire}"), ""),
                "agent": wire,
                "label": label,
                "plan": Value::Null,
                "windows": [{
                    "kind": "credit",
                    "label": window_label("credit", None),
                    "used": if capped { used } else { 0.0 },
                    "resetsAt": Value::Null,
                }],
                "money": { "spent": r.spent, "limit": r.limit, "remaining": r.remaining },
                "updatedAt": iso_ms(*at),
                "source": r.source,
            }));
        }
    }
    out
}

/// The `usage` reply frame.
pub fn usage_frame(request_id: &str, rows: Vec<Value>) -> Value {
    json!({ "type": "usage", "requestId": request_id, "agents": rows })
}

/// The keys of the rows a reply would carry.
pub fn row_keys(rows: &[Value]) -> HashSet<String> {
    rows.iter()
        .filter_map(|r| r.get("key").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// The `usageKey` of a session: the key of the row its agent + account draws from, or None
/// when no such row exists. The account resolves along the spawn's own chain (session ->
/// project default -> global default), and an id that names no registered account falls
/// back to the environment default, exactly as `session_account_config_dir` does.
pub fn session_usage_key(
    s: &Session,
    p: &Project,
    globals: &HashMap<AgentId, String>,
    known_accounts: &HashSet<String>,
    rows: &HashSet<String>,
) -> Option<String> {
    let account = s
        .account_id
        .clone()
        .or_else(|| p.default_accounts.get(&s.agent).cloned())
        .or_else(|| globals.get(&s.agent).cloned())
        .filter(|id| known_accounts.contains(id));
    let acct = account_key(account.as_deref());
    let key = match s.agent {
        AgentId::Claude => usage_key("claude", &acct),
        AgentId::Antigravity => usage_key("antigravity", &acct),
        AgentId::CommandCode => usage_key("commandcode", &acct),
        // Prepaid endpoints are keyed per AGENT, not per account (see `openRouterRow`).
        other => usage_key(&format!("openrouter:{}", agent_wire(other)), ""),
    };
    rows.contains(&key).then_some(key)
}

/// The rows, from the caches, rebuilt at most once per [`REBUILD_GAP`].
pub fn rows(app: &tauri::AppHandle) -> Vec<Value> {
    use tauri::Manager;
    let mut built = BUILT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, rows)) = built.as_ref() {
        if at.elapsed() < REBUILD_GAP {
            return rows.clone();
        }
    }
    let store = app.state::<std::sync::Arc<crate::store::Store>>();
    let auth = app.state::<std::sync::Arc<crate::claude_usage::ClaudeAuth>>();
    let claude = store
        .usage_targets(AgentId::Claude)
        .into_iter()
        .map(|(id, label, _)| {
            let cached = auth.cached_plan(&account_key(id.as_deref()));
            (id, label, cached)
        })
        .collect();
    let inputs = UsageInputs {
        claude,
        agy: app
            .state::<std::sync::Arc<crate::agy_usage::AgyUsageState>>()
            .all(),
        account_labels: store
            .list_accounts()
            .into_iter()
            .map(|a| (a.id, a.label))
            .collect(),
        command_code: COMMAND_CODE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        openrouter: OPENROUTER.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        now_secs: (now_ms() / 1000) as u64,
    };
    let mut rows = build_rows(&inputs);
    // Stable order for the phone: by agent, then label.
    rows.sort_by(|a, b| {
        let k = |v: &Value| {
            (
                v["agent"].as_str().unwrap_or("").to_string(),
                v["label"].as_str().unwrap_or("").to_string(),
            )
        };
        k(a).cmp(&k(b))
    });
    *built = Some((Instant::now(), rows.clone()));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agy_usage::{AgyBucket, AgyGroup};
    use crate::commandcode_usage::CommandCodeUsage;

    fn keys(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    fn win(label: &str, used: f64, reset: Option<&str>) -> PlanWindow {
        PlanWindow {
            label: label.into(),
            pct_used: used,
            resets_at: reset.map(str::to_string),
        }
    }

    fn inputs() -> UsageInputs {
        UsageInputs {
            claude: vec![(
                Some("acct-secret-id".into()),
                "Work".into(),
                Some((
                    vec![
                        win("5-hour window", 0.18, Some("2026-11-01T15:50:00Z")),
                        win("Weekly (all)", 0.03, Some("1793635200")),
                        win("Weekly (Opus)", 0.79, None),
                    ],
                    1_000_000,
                )),
            )],
            agy: vec![AgyUsage {
                account_id: None,
                plan_tier: Some("Pro".into()),
                groups: vec![AgyGroup {
                    display_name: "Gemini Models".into(),
                    buckets: vec![
                        AgyBucket {
                            bucket_id: "gemini-weekly".into(),
                            label: "Weekly".into(),
                            remaining_fraction: 0.25,
                            resets_at: None,
                            disabled: false,
                        },
                        AgyBucket {
                            bucket_id: "gemini-5h".into(),
                            label: "5-hour".into(),
                            remaining_fraction: 1.0,
                            resets_at: None,
                            disabled: true,
                        },
                    ],
                }],
                updated_at: 999_000_000,
                ..Default::default()
            }],
            command_code: Some((
                5,
                vec![
                    CommandCodeAccountUsage {
                        account_id: None,
                        label: "Default".into(),
                        usage: CommandCodeUsage {
                            windows: Some(vec![win("Weekly", 0.5, None)]),
                            source: "live".into(),
                            limited: false,
                        },
                    },
                    CommandCodeAccountUsage {
                        account_id: Some("other".into()),
                        label: "Signed out".into(),
                        usage: CommandCodeUsage {
                            windows: None,
                            source: "disconnected".into(),
                            limited: false,
                        },
                    },
                ],
            )),
            openrouter: Some((
                6,
                vec![OpenRouterUsage {
                    agent: AgentId::Hermes,
                    label: String::new(),
                    spent: 12.4,
                    limit: None,
                    remaining: None,
                    usage_daily: None,
                    usage_weekly: None,
                    usage_monthly: None,
                    is_free_tier: false,
                    source: "live".into(),
                }],
            )),
            now_secs: 1_000_060,
            ..Default::default()
        }
    }

    #[test]
    fn usage_reply_keys_are_pinned() {
        let rows = build_rows(&inputs());
        let frame = usage_frame("r1", rows.clone());
        assert_eq!(keys(&frame), ["agents", "requestId", "type"]);
        assert_eq!(frame["type"], "usage");
        // Signed-out Command Code is dropped; one row per remaining agent account.
        assert_eq!(rows.len(), 4);
        let base = [
            "agent",
            "key",
            "label",
            "plan",
            "source",
            "updatedAt",
            "windows",
        ];
        assert_eq!(keys(&rows[0]), base);
        let mut agy = base.to_vec();
        agy.push("models");
        agy.sort();
        assert_eq!(keys(&rows[1]), agy);
        let mut money = base.to_vec();
        money.push("money");
        money.sort();
        assert_eq!(keys(&rows[3]), money);
        for r in &rows {
            for w in r["windows"].as_array().unwrap() {
                assert_eq!(keys(w), ["kind", "label", "resetsAt", "used"]);
            }
        }
    }

    #[test]
    fn windows_use_the_desktop_vocabulary() {
        let rows = build_rows(&inputs());
        let claude = &rows[0];
        assert_eq!(claude["source"], "live");
        assert_eq!(claude["updatedAt"], "1970-01-12T13:46:40.000Z");
        let w = claude["windows"].as_array().unwrap();
        assert_eq!(w[0]["kind"], "fiveHour");
        assert_eq!(w[0]["label"], "5-hour");
        assert_eq!(w[0]["used"], 0.18);
        assert_eq!(w[0]["resetsAt"], "2026-11-01T15:50:00Z");
        assert_eq!(w[1]["label"], "Weekly");
        assert_eq!(
            w[1]["resetsAt"], "2026-11-02T16:00:00.000Z",
            "epoch reset -> RFC3339"
        );
        assert_eq!(w[2]["kind"], "weeklyOpus");
        assert_eq!(w[2]["label"], "Weekly · Opus");
        assert!(w[2]["resetsAt"].is_null());

        let agy = &rows[1];
        assert_eq!(agy["plan"], "Pro");
        let w = agy["windows"].as_array().unwrap();
        assert_eq!(w.len(), 1, "a disabled bucket is not a meter");
        assert_eq!(w[0]["label"], "Gemini · Weekly");
        assert_eq!(w[0]["used"], 0.75, "headroom flipped to consumption");
        assert_eq!(agy["models"], json!(["Gemini Models"]));

        let or = &rows[3];
        assert_eq!(or["agent"], "hermes");
        assert_eq!(or["label"], "OpenRouter");
        assert_eq!(
            or["windows"][0]["used"], 0.0,
            "uncapped: no invented fraction"
        );
        assert!(or["money"]["limit"].is_null());
    }

    #[test]
    fn claude_staleness_follows_the_read_age() {
        let mut i = inputs();
        i.now_secs = 1_000_000 + 30 * 60;
        assert_eq!(build_rows(&i)[0]["source"], "stale");
        i.now_secs = 1_000_000 + 2 * 60 * 60;
        let r = &build_rows(&i)[0];
        assert_eq!(r["source"], "unavailable");
        assert!(r["windows"].as_array().unwrap().is_empty());
        i.claude[0].2 = None;
        assert!(build_rows(&i)[0]["updatedAt"].is_null());
    }

    #[test]
    fn usage_keys_are_opaque_and_stable() {
        let a = usage_key("claude", "acct-secret-id");
        assert_eq!(a, usage_key("claude", "acct-secret-id"));
        assert_ne!(a, usage_key("claude", "default"));
        assert_ne!(a, usage_key("antigravity", "acct-secret-id"));
        assert_eq!(a.len(), 13);
        assert!(a.starts_with('u'));
        let text = serde_json::to_string(&build_rows(&inputs())).unwrap();
        assert!(!text.contains("acct-secret-id"), "account id leaked");
    }

    #[test]
    fn a_session_finds_its_row_by_agent_and_account() {
        let rows = row_keys(&build_rows(&inputs()));
        let known: HashSet<String> = ["acct-secret-id".to_string()].into();
        let p: Project = serde_json::from_value(json!({
            "id": "p", "name": "p", "path": "/x", "sessions": [],
            "defaultAccounts": { "claude": "acct-secret-id" },
        }))
        .unwrap();
        let globals = HashMap::new();
        let claude = Session {
            id: "s".into(),
            ..Default::default()
        };
        assert_eq!(
            session_usage_key(&claude, &p, &globals, &known, &rows),
            Some(usage_key("claude", "acct-secret-id")),
            "project default account"
        );
        // A deleted account falls back to the env default, which has no Claude row here.
        let gone = Session {
            account_id: Some("deleted".into()),
            ..claude.clone()
        };
        assert_eq!(session_usage_key(&gone, &p, &globals, &known, &rows), None);
        let agy = Session {
            agent: AgentId::Antigravity,
            ..claude.clone()
        };
        assert_eq!(
            session_usage_key(&agy, &p, &globals, &known, &rows),
            Some(usage_key("antigravity", "default"))
        );
        let hermes = Session {
            agent: AgentId::Hermes,
            ..claude.clone()
        };
        assert_eq!(
            session_usage_key(&hermes, &p, &globals, &known, &rows),
            Some(usage_key("openrouter:hermes", ""))
        );
        let codex = Session {
            agent: AgentId::Codex,
            ..claude
        };
        assert_eq!(session_usage_key(&codex, &p, &globals, &known, &rows), None);
    }
}
