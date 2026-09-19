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

/// The env var carrying the endpoint API key, referenced from the generated config as
/// `${CONDUIT_HERMES_APIKEY}`. One variable, so it is trivially redactable and never
/// duplicated into the config blob.
pub const API_KEY_ENV: &str = "CONDUIT_HERMES_APIKEY";

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

    if let Some(p) = provider.filter(|p| p.is_ready()) {
        out.push_str("model:\n");
        out.push_str(&format!("  default: {}\n", yaml_str(p.model.trim())));
        out.push_str(&format!(
            "  provider: {}\n",
            yaml_str(hermes_provider_id(&p.preset))
        ));
        out.push_str(&format!("  base_url: {}\n", yaml_str(p.base_url.trim())));
        // The literal placeholder, never the key: `${VAR}` in a managed file expands
        // against the PROCESS env, so the secret lives in exactly one env var.
        out.push_str(&format!("  api_key: \"${{{API_KEY_ENV}}}\"\n"));
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
) -> Option<PathBuf> {
    let dir = managed_dir(session_id);
    std::fs::create_dir_all(&dir).ok()?;
    let body = managed_config_yaml(port, session_id, provider);
    std::fs::write(dir.join("config.yaml"), body).ok()?;
    Some(dir)
}

/// Everything one Hermes spawn needs beyond its command line: the overlay directory to
/// point `HERMES_MANAGED_DIR` at, and the endpoint key that rides in its own env var.
/// Nothing here is written to disk except the overlay itself, and the key never is.
#[derive(Clone, Debug, PartialEq)]
pub struct HermesSpawnConfig {
    pub managed_dir: PathBuf,
    pub api_key: Option<String>,
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
) -> Option<HermesSpawnConfig> {
    let managed_dir = write_managed_config(session_id, port, provider)?;
    let routed = provider.is_some_and(|p| p.is_ready());
    Some(HermesSpawnConfig {
        managed_dir,
        api_key: routed.then(|| api_key.map(str::to_string)).flatten(),
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
        let y = managed_config_yaml(8423, "s1", None);
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
        assert!(!managed_config_yaml(8423, "s1", Some(&s)).contains("model:"));
    }

    #[test]
    fn openrouter_routes_through_hermes_own_provider_id() {
        let s = settings(
            "openrouter",
            "https://openrouter.ai/api/v1",
            "anthropic/claude-sonnet-5",
        );
        let y = managed_config_yaml(8423, "s1", Some(&s));
        assert!(y.contains("provider: \"openrouter\""));
        assert!(y.contains("default: \"anthropic/claude-sonnet-5\""));
        assert!(y.contains("base_url: \"https://openrouter.ai/api/v1\""));
        // The placeholder, never the key itself.
        assert!(y.contains("api_key: \"${CONDUIT_HERMES_APIKEY}\""));
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
        assert!(!managed_config_yaml(8423, "s1", Some(&s)).contains("context_length"));
        let s2 = ProviderSettings {
            context_limit: Some(262144),
            ..s
        };
        assert!(managed_config_yaml(8423, "s1", Some(&s2)).contains("context_length: 262144"));
    }

    #[test]
    fn a_windows_path_or_quoted_value_survives_quoting() {
        assert_eq!(yaml_str(r"C:\Users\x"), "\"C:\\\\Users\\\\x\"");
        assert_eq!(yaml_str("a\"b"), "\"a\\\"b\"");
    }
}
