//! Hermes Agent's per-session config overlay: lifecycle hooks and endpoint routing,
//! delivered without touching a single file the user owns.
//!
//! Hermes has no project-scoped config. Its `hooks:` block is read only from the profile's
//! `config.yaml`, which is machine-wide -- writing there is exactly the failure
//! `hooks::hook_target_is_user_level` exists to prevent for Claude: Conduit's hooks would
//! fire for every `hermes` on the box, including ones Conduit never started.
//!
//! `HERMES_MANAGED_DIR` is the way out, and it is a documented Hermes seam rather than a
//! trick (`hermes_cli/managed_scope.py`). It names a directory whose `config.yaml` is
//! deep-merged per leaf ON TOP of the user's, with sibling keys left user-controlled; it is
//! read from the PROCESS environment, so it is per-spawn; it is fail-open, so an
//! unparseable file is logged and ignored rather than fatal; and `${VAR}` inside it expands
//! against the process env only -- which is what lets the endpoint key ride in one env var
//! instead of being written into a file.
//!
//! So Conduit writes `<dataDir>/hermes/<session_id>/config.yaml` and points exactly one
//! session at it. Nothing is ever written to the user's own Hermes home.

use std::path::PathBuf;

use crate::store::ProviderSettings;

/// The env var that names one session's overlay directory.
pub const MANAGED_DIR_ENV: &str = "HERMES_MANAGED_DIR";

/// The env var Hermes reads this preset's API key from.
///
/// **This must be the provider's OWN canonical variable, not a Conduit-private one.** The
/// first cut wrote `api_key: "${CONDUIT_HERMES_APIKEY}"` into the managed overlay on the
/// strength of `apply_managed_overlay`'s documented `${VAR}` expansion. The overlay *is*
/// applied -- provider and base URL resolve from it correctly -- but Hermes' credential
/// resolver never reads `model.api_key` from the process environment that way, so
/// `resolve_runtime_provider` came back with `api_key: ''` and the interactive startup gate
/// (`_probe_runtime_credentials`) decided nothing was configured and opened its provider
/// wizard. Measured both ways against the installed CLI:
///
/// ```text
/// CONDUIT_HERMES_APIKEY=… -> api_key: ''            READY: False   (wizard)
/// OPENROUTER_API_KEY=…    -> api_key: 'sk-or-…'     READY: True
/// ```
///
/// The names come from Hermes' own provider registry (`hermes_cli/providers.py`): OpenRouter
/// and LM Studio each name their variable, and the `custom` family (ollama / vLLM /
/// llama.cpp / OpenWebUI / a typed URL) goes through the OpenAI-compatible one.
///
/// `OPENAI_BASE_URL` is deliberately NOT set alongside it: `hermes_cli/main.py` reclassifies
/// a resolved `openrouter` as `custom` the moment that variable is present, which would
/// silently move the session off the provider the user picked.
pub fn key_env_var(preset: &str) -> &'static str {
    match preset {
        "openrouter" => "OPENROUTER_API_KEY",
        "lmstudio" => "LM_API_KEY",
        _ => "OPENAI_API_KEY",
    }
}

/// The `providers:` config key Conduit gives one pooled endpoint.
///
/// Prefixed so a user reading their merged config can tell at a glance which entries
/// Conduit owns, and suffixed on collision because two `custom` endpoints (two LAN servers)
/// legitimately share a preset. Lowercase and dash-separated because
/// `providers::custom_provider_slug` normalizes to that anyway -- emitting the normalized
/// form keeps the file and the slug the user types identical.
pub fn pool_config_key(preset: &str, taken: &[String]) -> String {
    let base = format!("conduit-{}", slugify(preset));
    if !taken.contains(&base) {
        return base;
    }
    for n in 2..100 {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    base
}

/// The provider slug `/model --provider <slug>` accepts for a pooled endpoint.
///
/// `hermes_cli/providers.py::custom_provider_slug` builds this from the `providers:` map
/// KEY (not the display name, which the user may change), so it is stable for as long as
/// the key is. Conduit computes it rather than shelling out: the slug is needed to render a
/// chip row, and a Python process start per repaint is not a price worth paying.
pub fn pool_provider_slug(config_key: &str) -> String {
    format!("custom:{}", slugify(config_key))
}

/// The env var one pooled endpoint's key rides in.
///
/// **A Conduit-private variable is CORRECT here, and that is not a contradiction of
/// `key_env_var` above.** The failure documented there was `model.api_key: "${VAR}"`, which
/// relies on overlay `${}` expansion that Hermes' credential resolver never consults. This
/// is a different mechanism: the provider entry itself NAMES the variable via `key_env`, and
/// `runtime_provider_custom` reads it with `get_secret_str(key_env)`. Measured against the
/// installed CLI -- two pooled entries, two private vars, each resolving its own key:
///
/// ```text
/// custom:conduit-openrouter -> https://openrouter.ai/api/v1   key: sk-test-…
/// custom:conduit-ollama     -> http://127.0.0.1:11434/v1      key: local-xy…
/// ```
///
/// One variable per ENDPOINT is the whole point: a single shared variable would hand the
/// local server the cloud key, which is exactly what per-slot `provider_keys` exists to
/// prevent on the Conduit side.
pub fn pool_key_env(config_key: &str) -> String {
    let mut out = String::from("CONDUIT_EP_KEY_");
    for c in config_key.chars() {
        out.push(if c.is_ascii_alphanumeric() {
            c.to_ascii_uppercase()
        } else {
            '_'
        });
    }
    out
}

/// Lowercase, dash-separated, alphanumerics kept. Matches Hermes' own normalization so the
/// key Conduit writes and the slug Hermes reports are the same string.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// One pooled endpoint as it will be written into the overlay: its config key, its
/// settings, and the key Conduit holds for it (if any).
#[derive(Clone, Debug, PartialEq)]
pub struct PooledEndpoint {
    pub config_key: String,
    pub settings: ProviderSettings,
    pub api_key: Option<String>,
}

/// Assign config keys to an agent's endpoint pool, in order, deduplicating collisions.
///
/// Takes `(settings, key)` pairs rather than reading the store so it stays pure and
/// testable -- the same reason `seed_endpoint_pool` is pure.
pub fn pool_entries(pool: &[(ProviderSettings, Option<String>)]) -> Vec<PooledEndpoint> {
    let mut taken: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (settings, api_key) in pool {
        // An endpoint with no URL is not addressable; writing it would give the user a
        // provider slug that resolves to nothing.
        if settings.base_url.trim().is_empty() {
            continue;
        }
        let config_key = pool_config_key(&settings.preset, &taken);
        taken.push(config_key.clone());
        out.push(PooledEndpoint {
            config_key,
            settings: settings.clone(),
            api_key: api_key.clone(),
        });
    }
    out
}

/// One Hermes lifecycle event mapped to the Conduit verb its `/hook` listener already
/// understands.
pub struct HermesHook {
    pub event: &'static str,
    pub verb: &'static str,
}

/// Hermes' events -> Conduit's verbs.
///
/// **The two `session` names do not mean what they look like, and getting this wrong costs
/// the whole status feature.** Verified in Hermes' own source, not inferred from the names:
///
/// - `on_session_end` is fired by `agent/turn_finalizer.py`, whose own comment reads
///   "run_conversation() runs once per message". It carries `turn_id`, `completed`,
///   `failed`, `interrupted`, `turn_exit_reason`. It is **once per TURN** -- the analogue of
///   Claude's `Stop`, so it maps to `stop`.
/// - `on_session_finalize` is fired by `hermes_cli/cli_session_mixin.py` at a real session
///   boundary (`/new`, exit). That is the analogue of Claude's `SessionEnd`, so it maps to
///   `sessionend`. Hermes' own telemetry agrees: `relay_shared_metrics` maps
///   `on_session_end` to `finish_task` and `on_session_finalize` to `close_session`.
///
/// Swapping them would leave every Hermes session reading `running` until the 20-minute
/// stale watchdog swept it, and would fire `sessionend` after every single turn.
///
/// `pre_approval_request` is what buys Hermes the `needsInput` badge that Command Code
/// never got: Hermes asks for command approval through a hook rather than only inside its
/// own TUI. Its payload carries no `notification_type`, and `status_rules::notification_status`
/// reads an absent type as the legacy `needsInput` -- which is the correct answer here, not
/// an accident. `post_approval_response` maps to `pretool` so the badge clears the moment
/// the human answers, rather than hanging until the next tool call.
pub const HOOKS: &[HermesHook] = &[
    HermesHook {
        event: "on_session_start",
        verb: "sessionstart",
    },
    HermesHook {
        event: "pre_llm_call",
        verb: "prompt",
    },
    HermesHook {
        event: "pre_tool_call",
        verb: "pretool",
    },
    HermesHook {
        event: "post_tool_call",
        verb: "tooluse",
    },
    HermesHook {
        event: "pre_approval_request",
        verb: "notification",
    },
    HermesHook {
        event: "post_approval_response",
        verb: "pretool",
    },
    HermesHook {
        event: "on_session_end",
        verb: "stop",
    },
    HermesHook {
        event: "on_session_finalize",
        verb: "sessionend",
    },
];

/// How long Hermes waits for one of our hooks before giving up. Every hook here is a
/// fire-and-forget POST to loopback; 5s is generous and the dispatcher fails OPEN, so a
/// slow or dead Conduit delays a turn by at most this and never blocks it.
const HOOK_TIMEOUT_S: u32 = 5;

/// The shell command for one hook.
///
/// **Hermes runs hook commands through `shlex.split` with `shell=False`** -- there is no
/// shell, so the POSIX form used for Claude (`${VAR:-default}`, `>/dev/null`, `|| true`)
/// and the cmd.exe form (`>NUL`, `|| ver >NUL`) are both wrong here: they would be passed
/// to curl as literal arguments. This is a bare argv invocation, and it needs no error
/// swallowing because Hermes already fails open on a non-zero exit.
///
/// The session id is BAKED IN rather than read from the environment, for the same reason:
/// with no shell there is nothing to expand `%CONDUIT_SESSION_ID%`. That is free here --
/// the overlay directory is per-session and rewritten at every spawn, so the id is known
/// when the file is written.
///
/// One consequence worth stating: there is no equivalent of Claude's endpoint-file layer,
/// which re-reads the live port at HOOK time. A Hermes session that outlived an app restart
/// onto a different port would post into a closed socket. The file is rewritten with the
/// live port on every spawn, so this can only bite a session that survives a restart
/// without respawning -- which on Windows (no tmux) cannot happen today.
///
/// **`hermes hooks doctor` reports two false problems for this command. Both are cosmetic
/// and neither is worth "fixing".** Measured against the installed CLI:
///
/// - *"script missing or not executable"*. `_resolve_script_path` guesses which token is
///   the script by taking the first one containing a `/`. That is
///   `Content-Type: application/json`, not a path. No argument order avoids it -- the URL
///   contains slashes too -- and the guess is used only by `doctor`/`script_mtime_iso`,
///   never by execution, which is a plain `shlex.split` + `Popen`.
/// - *"not allowlisted -- hook will NOT fire at runtime"*. `doctor` reads the allowlist
///   FILE, which is written when a session registers the hook. `hooks_auto_accept: true` in
///   the overlay is what makes that registration silent, and it is resolved at registration
///   time by `_resolve_effective_accept(cfg, ...)` off the MERGED config -- verified:
///   `hermes config get hooks_auto_accept` answers `false` without the overlay and `true`
///   with it, and `hermes hooks test on_session_start` fires the command successfully.
pub fn hook_command(port: u16, session_id: &str, verb: &str) -> String {
    let url = format!("http://127.0.0.1:{port}/hook?session={session_id}&event={verb}");
    format!("curl -s -m 2 -X POST -H \"Content-Type: application/json\" --data-binary @- \"{url}\"")
}

/// Quote a scalar as a YAML double-quoted string.
///
/// Conduit only ever EMITS this file, never parses a user's, so a single strict quoting
/// rule is enough and a YAML dependency is not (see CLAUDE.md's lean-dependency rule).
/// Double-quoted YAML is the one style with a defined escape for both characters that can
/// appear here, so a Windows path or a URL with a query string survives verbatim.
fn yaml_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Hermes' own id for a Conduit preset, from its provider registry
/// (`hermes_cli/providers.py`) and its `model.provider` documentation.
///
/// `ollama`, `vllm` and `llamacpp` are all aliases of `custom` in Hermes -- they are one
/// mechanism (an OpenAI-compatible URL), and only LM Studio is first-class. OpenWebUI has
/// no Hermes entry at all, so it is a `custom` endpoint too. Returning the alias rather
/// than `custom` would work, but naming what Hermes actually resolves keeps the generated
/// file readable when a user opens it to see what Conduit did.
pub fn hermes_provider_id(preset: &str) -> &'static str {
    match preset {
        "openrouter" => "openrouter",
        "lmstudio" => "lmstudio",
        _ => "custom",
    }
}

/// Build the managed-overlay `config.yaml` for one session.
///
/// Always carries the hook block. Carries a `model:` block ONLY when the agent's endpoint
/// settings are enabled and complete -- with routing off, a Hermes session spawns with
/// status hooks and nothing else, exactly as its own config dictates. That is the same
/// `enabled` gate OpenCode has, for the same reason.
///
/// `hooks_auto_accept` is why this is a file rather than a flag. Hermes prompts for consent
/// on first use of each `(event, command)` pair, which a Conduit session cannot answer --
/// there is no TTY at spawn. The blunt instrument is `--accept-hooks` /
/// `HERMES_ACCEPT_HOOKS=1`, which auto-approves EVERY hook in the merged config including
/// any the user wrote themselves. Setting it here has the same effect on Conduit's hooks
/// while keeping the decision in a file Conduit owns and the user can read.
pub fn managed_config_yaml(
    port: u16,
    session_id: &str,
    provider: Option<&ProviderSettings>,
    pool: &[PooledEndpoint],
) -> String {
    let mut out = String::new();
    out.push_str("# Generated by Conduit -- do not edit; rewritten at every spawn.\n");
    out.push_str("# This is a Hermes managed-scope overlay (HERMES_MANAGED_DIR). It is\n");
    out.push_str("# deep-merged per leaf on top of your own config.yaml, which is left\n");
    out.push_str("# untouched. Sibling keys stay yours.\n");
    out.push_str(&format!("# session: {session_id}\n\n"));

    // Consent, scoped to this overlay rather than to every hook on the machine.
    out.push_str("hooks_auto_accept: true\n");

    out.push_str("hooks:\n");
    for h in HOOKS {
        out.push_str(&format!("  {}:\n", h.event));
        out.push_str(&format!(
            "    - command: {}\n",
            yaml_str(&hook_command(port, session_id, h.verb))
        ));
        out.push_str(&format!("      timeout: {HOOK_TIMEOUT_S}\n"));
    }

    if !pool.is_empty() {
        // Every endpoint the user has configured for Hermes, so `/model --provider` can
        // reach all of them. Without this block only the endpoint the session LAUNCHED on
        // exists in the merged config, and a mid-session move from a local model to
        // OpenRouter was impossible -- which defeats live switching, whose entire value is
        // keeping the conversation while the model under it changes.
        //
        // This is a MAP, deep-merged per leaf like every other key, so a user's own
        // `providers:` entries survive beside Conduit's. Conduit only ever writes keys it
        // prefixed (`pool_config_key`).
        out.push_str("providers:\n");
        for e in pool {
            out.push_str(&format!("  {}:\n", e.config_key));
            out.push_str(&format!(
                "    name: {}\n",
                yaml_str(&format!(
                    "{} (Conduit)",
                    crate::agent::preset_label(&e.settings.preset)
                ))
            ));
            out.push_str(&format!(
                "    base_url: {}\n",
                yaml_str(e.settings.base_url.trim())
            ));
            // Named even when Conduit holds no key for it: a local server needs none, and
            // naming the variable means a key added later takes effect at the next spawn
            // without rewriting the entry.
            out.push_str(&format!(
                "    key_env: {}\n",
                yaml_str(&pool_key_env(&e.config_key))
            ));
            if !e.settings.model.trim().is_empty() {
                out.push_str(&format!(
                    "    model: {}\n",
                    yaml_str(e.settings.model.trim())
                ));
            }
            if let Some(c) = e.settings.context_limit {
                out.push_str(&format!("    context_length: {c}\n"));
            }
        }
    }

    if let Some(p) = provider.filter(|p| p.is_ready()) {
        out.push_str("model:\n");
        out.push_str(&format!("  default: {}\n", yaml_str(p.model.trim())));
        out.push_str(&format!(
            "  provider: {}\n",
            yaml_str(hermes_provider_id(&p.preset))
        ));
        out.push_str(&format!("  base_url: {}\n", yaml_str(p.base_url.trim())));
        // No `api_key` line. It would be inert (see `key_env_var`) and actively misleading:
        // a reader of this file would conclude the key travels here when it does not. The
        // key reaches Hermes through its provider's own env var, set at spawn.
        if let Some(c) = p.context_limit {
            // Hermes auto-detects the window from the provider and only needs telling when
            // that detection is wrong -- a local server with a custom num_ctx, or a proxy
            // that does not expose /v1/models. Emitting it only when the user supplied one
            // keeps the good path on Hermes' own detection.
            out.push_str(&format!("  context_length: {c}\n"));
        }
    }
    out
}

/// This session's overlay directory. Under `store::data_dir()` rather than a hardcoded
/// name so a dev build (`CONDUIT_DATA_DIR_NAME`) never writes over the installed app's.
pub fn managed_dir(session_id: &str) -> PathBuf {
    crate::store::data_dir().join("hermes").join(session_id)
}

/// Write the overlay and return its directory, or None if it could not be written.
/// A failure is not fatal: the caller simply does not set `HERMES_MANAGED_DIR`, and the
/// session runs as a plain Hermes session with no Conduit status.
pub fn write_managed_config(
    session_id: &str,
    port: u16,
    provider: Option<&ProviderSettings>,
    pool: &[PooledEndpoint],
) -> Option<PathBuf> {
    let dir = managed_dir(session_id);
    std::fs::create_dir_all(&dir).ok()?;
    let body = managed_config_yaml(port, session_id, provider, pool);
    std::fs::write(dir.join("config.yaml"), body).ok()?;
    Some(dir)
}

/// Everything one Hermes spawn needs beyond its command line: the overlay directory to
/// point `HERMES_MANAGED_DIR` at, and the endpoint key that rides in its own env var.
/// Nothing here is written to disk except the overlay itself, and the key never is.
#[derive(Clone, Debug, PartialEq)]
pub struct HermesSpawnConfig {
    pub managed_dir: PathBuf,
    /// `(env var, key)` for the ACTIVE endpoint -- the var is the PROVIDER's own name, so
    /// Hermes' startup credential gate finds it. See `key_env_var`.
    pub api_key: Option<(String, String)>,
    /// `(env var, key)` per POOLED endpoint, each naming that entry's own `key_env`. The
    /// active endpoint appears here too; the two paths do not conflict, they just give
    /// Hermes two ways to find the same credential.
    pub pool_keys: Vec<(String, String)>,
}

/// Write this session's overlay and describe its spawn env.
///
/// Returns None only when the overlay could not be written -- the session then spawns as a
/// plain Hermes session with no Conduit status, which is a degradation rather than a
/// failure. The overlay is written even when `provider` is None or disabled, because the
/// HOOKS are the part that is never optional.
///
/// The key is carried only when there is actually an endpoint to use it on: handing a
/// session `CONDUIT_HERMES_APIKEY` while its config pins no `api_key` placeholder would put
/// a secret in a child's environment for nothing.
pub fn build_spawn_config(
    session_id: &str,
    port: u16,
    provider: Option<&ProviderSettings>,
    api_key: Option<&str>,
    pool: &[(ProviderSettings, Option<String>)],
) -> Option<HermesSpawnConfig> {
    let entries = pool_entries(pool);
    let managed_dir = write_managed_config(session_id, port, provider, &entries)?;
    // One variable per pooled endpoint that Conduit actually holds a key for. An endpoint
    // with no key still gets its entry (and so its slug) -- a local server needs none.
    let pool_keys: Vec<(String, String)> = entries
        .iter()
        .filter_map(|e| {
            e.api_key
                .as_ref()
                .map(|k| (pool_key_env(&e.config_key), k.clone()))
        })
        .collect();
    // Only when there is actually an endpoint to use it on: handing a session a provider
    // key while its config pins no endpoint would put a secret in a child's environment
    // for nothing -- and, because Hermes ingests an env key into its credential pool,
    // would register a credential for a provider the user never selected.
    let key = provider
        .filter(|p| p.is_ready())
        .and_then(|p| api_key.map(|k| (key_env_var(&p.preset).to_string(), k.to_string())));
    Some(HermesSpawnConfig {
        managed_dir,
        api_key: key,
        pool_keys,
    })
}

/// Remove a session's overlay directory. Called when a session is destroyed, so the data
/// dir does not accumulate one directory per session ever created.
pub fn remove_managed_config(session_id: &str) {
    let _ = std::fs::remove_dir_all(managed_dir(session_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(preset: &str, url: &str, model: &str) -> ProviderSettings {
        ProviderSettings {
            enabled: true,
            preset: preset.into(),
            base_url: url.into(),
            model: model.into(),
            ..Default::default()
        }
    }

    #[test]
    fn turn_end_and_session_end_are_not_the_same_event() {
        // The whole status feature rests on this mapping; see HOOKS' doc comment.
        let verb = |e: &str| {
            HOOKS
                .iter()
                .find(|h| h.event == e)
                .map(|h| h.verb)
                .unwrap_or("<missing>")
        };
        assert_eq!(verb("on_session_end"), "stop", "fires once per TURN");
        assert_eq!(
            verb("on_session_finalize"),
            "sessionend",
            "fires at a real session boundary"
        );
    }

    #[test]
    fn approval_round_trip_raises_then_clears_the_badge() {
        let verb = |e: &str| HOOKS.iter().find(|h| h.event == e).map(|h| h.verb);
        // `notification` with no notification_type is read as needsInput by status_rules.
        assert_eq!(verb("pre_approval_request"), Some("notification"));
        // ...and the answer puts the session straight back to running.
        assert_eq!(verb("post_approval_response"), Some("pretool"));
    }

    #[test]
    fn hook_command_is_bare_argv_with_no_shell_syntax() {
        let cmd = hook_command(8423, "sess-1", "stop");
        // Hermes runs this through shlex.split with shell=False.
        for forbidden in ["${", "%CONDUIT", ">/dev/null", ">NUL", "||", "&&", ";"] {
            assert!(
                !cmd.contains(forbidden),
                "{forbidden:?} would reach curl as a literal argument: {cmd}"
            );
        }
        assert!(cmd.contains("session=sess-1"), "session id is baked in");
        assert!(cmd.contains("event=stop"));
        assert!(cmd.contains("127.0.0.1:8423"));
    }

    #[test]
    fn config_always_has_hooks_and_consent() {
        let y = managed_config_yaml(8423, "s1", None, &[]);
        assert!(y.contains("hooks_auto_accept: true"));
        for h in HOOKS {
            assert!(y.contains(&format!("  {}:\n", h.event)), "{}", h.event);
        }
        assert!(
            !y.contains("model:"),
            "routing off must not pin a model -- the session runs on its own config"
        );
    }

    #[test]
    fn an_incomplete_endpoint_pins_nothing() {
        // Enabled but no model: not a half-route to guess at.
        let mut s = settings("openrouter", "https://openrouter.ai/api/v1", "");
        s.enabled = true;
        assert!(!managed_config_yaml(8423, "s1", Some(&s), &[]).contains("model:"));
    }

    /// The exact shape measured against the installed CLI. `providers:` entries keyed
    /// `conduit-<preset>` resolve to `custom:conduit-<preset>`, and each entry's key comes
    /// from the variable its own `key_env` names:
    ///
    /// ```text
    /// custom:conduit-openrouter -> https://openrouter.ai/api/v1   key: sk-test-…
    /// custom:conduit-ollama     -> http://127.0.0.1:11434/v1      key: local-xy…
    /// ```
    ///
    /// If this ever drifts, `/model --provider` silently stops reaching the second
    /// endpoint -- the switch is accepted and nothing changes -- so the format is pinned.
    #[test]
    fn pooled_endpoints_become_switchable_providers() {
        let cloud = ProviderSettings {
            enabled: true,
            preset: "openrouter".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            model: "anthropic/claude-sonnet-5".into(),
            ..Default::default()
        };
        let local = ProviderSettings {
            enabled: true,
            preset: "ollama".into(),
            base_url: "http://127.0.0.1:11434/v1".into(),
            model: "qwen3:30b-a3b".into(),
            ..Default::default()
        };
        let entries = pool_entries(&[
            (cloud.clone(), Some("sk-or-cloud".into())),
            (local.clone(), None),
        ]);
        assert_eq!(entries[0].config_key, "conduit-openrouter");
        assert_eq!(entries[1].config_key, "conduit-ollama");
        assert_eq!(
            pool_provider_slug(&entries[0].config_key),
            "custom:conduit-openrouter"
        );
        assert_eq!(
            pool_key_env("conduit-openrouter"),
            "CONDUIT_EP_KEY_CONDUIT_OPENROUTER"
        );

        let y = managed_config_yaml(8423, "s1", Some(&cloud), &entries);
        assert!(y.contains("providers:\n"));
        assert!(y.contains("  conduit-openrouter:\n"));
        assert!(y.contains("  conduit-ollama:\n"));
        assert!(y.contains("base_url: \"http://127.0.0.1:11434/v1\""));
        // Named even with no key held: a local server needs none, and a key added later
        // then takes effect without rewriting the entry.
        assert!(y.contains("key_env: \"CONDUIT_EP_KEY_CONDUIT_OLLAMA\""));
        // The secret itself is never in the file -- only the name of the variable.
        assert!(!y.contains("sk-or-cloud"), "key leaked into the overlay");
    }

    #[test]
    fn two_endpoints_on_one_preset_get_distinct_keys() {
        let a = ProviderSettings {
            preset: "custom".into(),
            base_url: "http://box-a:8000/v1".into(),
            ..Default::default()
        };
        let b = ProviderSettings {
            preset: "custom".into(),
            base_url: "http://box-b:8000/v1".into(),
            ..Default::default()
        };
        let entries = pool_entries(&[(a, None), (b, None)]);
        assert_eq!(entries[0].config_key, "conduit-custom");
        assert_eq!(entries[1].config_key, "conduit-custom-2");
        // Distinct config keys mean distinct slugs AND distinct env vars; collapsing them
        // would point both LAN servers at one credential.
        assert_ne!(
            pool_key_env(&entries[0].config_key),
            pool_key_env(&entries[1].config_key)
        );
    }

    #[test]
    fn an_endpoint_with_no_url_is_not_written() {
        let blank = ProviderSettings {
            preset: "ollama".into(),
            base_url: "   ".into(),
            ..Default::default()
        };
        let real = ProviderSettings {
            preset: "openrouter".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            ..Default::default()
        };
        // A blank entry would render a provider slug that resolves to nothing.
        let entries = pool_entries(&[(blank, None), (real, None)]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].config_key, "conduit-openrouter");
        // With no pool at all the block is absent entirely rather than emitted empty --
        // `providers:` with no children is a parse hazard, not a no-op.
        assert!(!managed_config_yaml(8423, "s1", None, &[]).contains("providers:"));
    }

    #[test]
    fn pool_keys_ride_env_vars_and_never_the_overlay() {
        let cloud = ProviderSettings {
            enabled: true,
            preset: "openrouter".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            model: "anthropic/claude-sonnet-5".into(),
            ..Default::default()
        };
        let local = ProviderSettings {
            enabled: true,
            preset: "ollama".into(),
            base_url: "http://127.0.0.1:11434/v1".into(),
            model: "qwen3:30b-a3b".into(),
            ..Default::default()
        };
        let cfg = build_spawn_config(
            "s-pool",
            8423,
            Some(&cloud),
            Some("sk-or-active"),
            &[
                (cloud.clone(), Some("sk-or-active".into())),
                (local, Some("local-secret".into())),
            ],
        )
        .expect("overlay written");
        // The ACTIVE endpoint still gets the provider's canonical variable -- that is what
        // Hermes' startup credential gate reads (see `key_env_var`).
        assert_eq!(
            cfg.api_key,
            Some(("OPENROUTER_API_KEY".into(), "sk-or-active".into()))
        );
        // ...and every pooled endpoint gets its own, which is what makes a mid-session
        // switch to the second one authenticate.
        assert!(cfg.pool_keys.contains(&(
            "CONDUIT_EP_KEY_CONDUIT_OLLAMA".into(),
            "local-secret".into()
        )));
        assert_eq!(cfg.pool_keys.len(), 2);
        let body = std::fs::read_to_string(cfg.managed_dir.join("config.yaml")).unwrap();
        assert!(!body.contains("local-secret"));
        remove_managed_config("s-pool");
    }

    #[test]
    fn openrouter_routes_through_hermes_own_provider_id() {
        let s = settings(
            "openrouter",
            "https://openrouter.ai/api/v1",
            "anthropic/claude-sonnet-5",
        );
        let y = managed_config_yaml(8423, "s1", Some(&s), &[]);
        assert!(y.contains("provider: \"openrouter\""));
        assert!(y.contains("default: \"anthropic/claude-sonnet-5\""));
        assert!(y.contains("base_url: \"https://openrouter.ai/api/v1\""));
        // No api_key line at all: it was inert, and a reader would wrongly conclude the
        // key travels in this file. It reaches Hermes via the provider's own env var.
        assert!(
            !y.contains("api_key"),
            "the overlay must not imply the key travels here: {y}"
        );
    }

    #[test]
    fn the_key_rides_the_providers_own_env_var() {
        // Hermes' credential resolver only reads the canonical names. A Conduit-private
        // variable resolved to an EMPTY api_key, and the startup gate then offered its
        // "no provider configured" wizard over a fully configured endpoint.
        assert_eq!(key_env_var("openrouter"), "OPENROUTER_API_KEY");
        assert_eq!(key_env_var("lmstudio"), "LM_API_KEY");
        // The `custom` family (ollama / vLLM / llama.cpp / OpenWebUI / a typed URL) all
        // go through the OpenAI-compatible variable.
        for p in ["ollama", "vllm", "llamacpp", "openwebui", "custom"] {
            assert_eq!(key_env_var(p), "OPENAI_API_KEY", "{p}");
        }
    }

    #[test]
    fn a_key_is_only_carried_when_an_endpoint_will_use_it() {
        // Hermes INGESTS an env key into its credential pool, so handing one to a session
        // with no configured endpoint would register a credential for a provider the user
        // never chose.
        let ready = settings("openrouter", "https://openrouter.ai/api/v1", "x/y");
        let cfg = build_spawn_config("s-ready", 8423, Some(&ready), Some("sk-or-secret"), &[]);
        assert_eq!(
            cfg.unwrap().api_key,
            Some(("OPENROUTER_API_KEY".to_string(), "sk-or-secret".to_string()))
        );

        let half = ProviderSettings {
            model: String::new(),
            ..ready
        };
        let cfg = build_spawn_config("s-half", 8423, Some(&half), Some("sk-or-secret"), &[]);
        assert_eq!(cfg.unwrap().api_key, None, "no endpoint, no credential");

        let cfg = build_spawn_config("s-none", 8423, None, Some("sk-or-secret"), &[]);
        assert_eq!(cfg.unwrap().api_key, None, "routing off, no credential");

        for id in ["s-ready", "s-half", "s-none"] {
            remove_managed_config(id);
        }
    }

    #[test]
    fn local_presets_resolve_to_hermes_aliases() {
        // Hermes makes LM Studio first-class and folds the rest into `custom`.
        assert_eq!(hermes_provider_id("lmstudio"), "lmstudio");
        assert_eq!(hermes_provider_id("ollama"), "custom");
        assert_eq!(hermes_provider_id("vllm"), "custom");
        assert_eq!(hermes_provider_id("llamacpp"), "custom");
        assert_eq!(hermes_provider_id("openwebui"), "custom");
        assert_eq!(hermes_provider_id("custom"), "custom");
    }

    #[test]
    fn context_length_is_emitted_only_when_supplied() {
        let s = settings("ollama", "http://127.0.0.1:11434/v1", "qwen3:30b");
        assert!(!managed_config_yaml(8423, "s1", Some(&s), &[]).contains("context_length"));
        let s2 = ProviderSettings {
            context_limit: Some(262144),
            ..s
        };
        assert!(managed_config_yaml(8423, "s1", Some(&s2), &[]).contains("context_length: 262144"));
    }

    #[test]
    fn a_windows_path_or_quoted_value_survives_quoting() {
        assert_eq!(yaml_str(r"C:\Users\x"), "\"C:\\\\Users\\\\x\"");
        assert_eq!(yaml_str("a\"b"), "\"a\\\"b\"");
    }
}
