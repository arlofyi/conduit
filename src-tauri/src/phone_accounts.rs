//! Agent accounts as a paired phone sees and picks them: which account a new session
//! starts on, and moving an existing session to another one.
//!
//! The phone never gets an account id or a config path. It gets an opaque `ref` per
//! account (a one-way hash, same scheme as the usage rows' keys), the account's LABEL
//! (already shown on the phone's usage rows), the agents it is tagged for, and the usage
//! row key each agent draws from, so the picker can say which account is out of quota.
//! A ref the phone sends back is resolved by scanning the registered accounts; an
//! unknown ref is refused, never guessed.
//!
//! Moving a Claude session between accounts also moves its CONVERSATION: Claude keeps
//! transcripts under `<account cfg>/projects`, so a session restarted on the new account
//! would find nothing to `--resume` and silently start over. [`carry_transcript`] copies
//! the current conversation's transcript across first (never overwriting), which is what
//! makes "this account's week is spent, carry on with the other one" keep the context.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

use serde_json::{json, Value};

use crate::agent::AgentId;
use crate::claude_usage::account_key;
use crate::phone_usage::usage_key;
use crate::store::{Account, Project, Session, Store};

/// The opaque handle the phone uses for an account.
pub fn account_ref(account_id: &str) -> String {
    usage_key("account-ref", account_id)
}

/// The account a ref names, if any.
pub fn resolve_ref<'a>(accounts: &'a [Account], r: &str) -> Option<&'a Account> {
    accounts.iter().find(|a| account_ref(&a.id) == r)
}

fn agent_wire(agent: AgentId) -> String {
    serde_json::to_value(agent)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The usage row key an agent's session on `account` (None = the environment default)
/// draws from -- the same derivation as `phone_usage::session_usage_key`. None for agents
/// whose meter is not per account.
pub fn usage_key_for(agent: AgentId, account: Option<&str>) -> Option<String> {
    let acct = account_key(account);
    match agent {
        AgentId::Claude => Some(usage_key("claude", &acct)),
        AgentId::Antigravity => Some(usage_key("antigravity", &acct)),
        AgentId::CommandCode => Some(usage_key("commandcode", &acct)),
        _ => None,
    }
}

/// The account a session runs on: its own pin, else the project's default for its agent,
/// else the global default -- an id naming no registered account falls back to the
/// environment (None), exactly as the spawn resolves it.
pub fn effective_account<'a>(
    s: &Session,
    p: &Project,
    globals: &HashMap<AgentId, String>,
    accounts: &'a [Account],
) -> Option<&'a Account> {
    let id = s
        .account_id
        .as_ref()
        .or_else(|| p.default_accounts.get(&s.agent))
        .or_else(|| globals.get(&s.agent))?;
    accounts.iter().find(|a| &a.id == id)
}

/// The account a NEW session of `agent` in `p` would start on with no explicit pick.
fn default_for<'a>(
    p: &Project,
    agent: AgentId,
    globals: &HashMap<AgentId, String>,
    accounts: &'a [Account],
) -> Option<&'a Account> {
    let id = p
        .default_accounts
        .get(&agent)
        .or_else(|| globals.get(&agent))?;
    accounts.iter().find(|a| &a.id == id)
}

/// Per-session fields for the `projects` frame: the explicit pin's ref (null = following
/// the default) and the label of the account it actually runs on (null = the
/// environment's own login).
pub fn session_fields(
    s: &Session,
    p: &Project,
    globals: &HashMap<AgentId, String>,
    accounts: &[Account],
) -> (Value, Value) {
    let pinned = s
        .account_id
        .as_ref()
        .filter(|id| accounts.iter().any(|a| &a.id == *id))
        .map_or(Value::Null, |id| json!(account_ref(id)));
    let label = effective_account(s, p, globals, accounts).map_or(Value::Null, |a| json!(a.label));
    (pinned, label)
}

/// Per-project defaults for the `projects` frame: agent -> ref of the account a new
/// session would start on. Agents with no registered default are omitted.
pub fn project_defaults(
    p: &Project,
    globals: &HashMap<AgentId, String>,
    accounts: &[Account],
) -> Value {
    let mut out = serde_json::Map::new();
    for a in accounts {
        for agent in &a.agents {
            if let Some(d) = default_for(p, *agent, globals, accounts) {
                out.insert(agent_wire(*agent), json!(account_ref(&d.id)));
            }
        }
    }
    Value::Object(out)
}

/// The `accounts` list for the `projects` frame. `default_usage` carries, per agent, the
/// usage key of the environment's own login (what "Default" means when no account is set).
pub fn accounts_view(accounts: &[Account]) -> Value {
    let list: Vec<Value> = accounts
        .iter()
        .map(|a| {
            let usage: serde_json::Map<String, Value> = a
                .agents
                .iter()
                .filter_map(|agent| {
                    usage_key_for(*agent, Some(&a.id)).map(|k| (agent_wire(*agent), json!(k)))
                })
                .collect();
            json!({
                "ref": account_ref(&a.id),
                "label": a.label,
                "agents": a.agents.iter().map(|g| agent_wire(*g)).collect::<Vec<_>>(),
                "usage": usage,
            })
        })
        .collect();
    let default_usage: serde_json::Map<String, Value> =
        [AgentId::Claude, AgentId::Antigravity, AgentId::CommandCode]
            .into_iter()
            .filter_map(|g| usage_key_for(g, None).map(|k| (agent_wire(g), json!(k))))
            .collect();
    json!({ "list": list, "defaultUsage": default_usage })
}

/// What a phone asked for: `""` = back to the default chain, else a ref.
pub enum AccountChoice<'a> {
    Default,
    Account(&'a Account),
}

/// Resolve a phone's account choice for an agent. `Err` carries the user-facing reason.
pub fn choose<'a>(
    accounts: &'a [Account],
    agent: AgentId,
    r: &str,
) -> Result<AccountChoice<'a>, &'static str> {
    let r = r.trim();
    if r.is_empty() {
        return Ok(AccountChoice::Default);
    }
    let Some(a) = resolve_ref(accounts, r) else {
        return Err("That account no longer exists on your computer.");
    };
    if !a.agents.contains(&agent) {
        return Err("That account isn't set up for this agent.");
    }
    Ok(AccountChoice::Account(a))
}

/// Copy one conversation's transcript from one Claude `projects` dir to another: the
/// `<slug>/<conversation>.jsonl` file and, when present, its `<slug>/<conversation>/`
/// folder (subagent transcripts, tool results). Nothing that already exists at the
/// destination is overwritten. Ok(true) when the transcript was copied.
pub fn carry_transcript(from: &Path, to: &Path, conversation: &str) -> io::Result<bool> {
    if from == to || conversation.is_empty() || conversation.contains(['/', '\\', '.']) {
        return Ok(false);
    }
    let file = format!("{conversation}.jsonl");
    let Some(slug_dir) = fs::read_dir(from)?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.join(&file).is_file())
    else {
        return Ok(false);
    };
    let Some(slug) = slug_dir.file_name() else {
        return Ok(false);
    };
    let dest_dir = to.join(slug);
    let dest = dest_dir.join(&file);
    if dest.exists() {
        return Ok(false);
    }
    fs::create_dir_all(&dest_dir)?;
    let extra = slug_dir.join(conversation);
    if extra.is_dir() {
        copy_tree(&extra, &dest_dir.join(conversation))?;
    }
    // The .jsonl last: its presence is what makes `--resume` pick the conversation up.
    fs::copy(slug_dir.join(&file), &dest)?;
    Ok(true)
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)?.flatten() {
        let ft = e.file_type()?;
        let dest = to.join(e.file_name());
        // Never follow a link out of the transcript store.
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            copy_tree(&e.path(), &dest)?;
        } else if !dest.exists() {
            fs::copy(e.path(), &dest)?;
        }
    }
    Ok(())
}

/// Move a session to another account (`None` = back to the default chain), carrying a
/// Claude conversation's transcript to the new account first so the next start resumes
/// it. Shared by the desktop's account picker and the phone. Returns whether a transcript
/// was carried across.
pub fn move_session_account(store: &Store, session_id: &str, account_id: Option<String>) -> bool {
    let agent = store
        .list()
        .iter()
        .flat_map(|p| p.sessions.iter())
        .find(|s| s.id == session_id)
        .map(|s| s.agent);
    let before = crate::pty::session_projects_dir(store, session_id);
    store.set_session_account(session_id, account_id);
    if agent != Some(AgentId::Claude) {
        return false;
    }
    let after = crate::pty::session_projects_dir(store, session_id);
    let (Some(before), Some(after)) = (before, after) else {
        return false;
    };
    let conversation = store.claude_conversation_id(session_id);
    match carry_transcript(&before, &after, &conversation) {
        Ok(carried) => carried,
        Err(e) => {
            crate::diag::warn(
                "accounts",
                format!("could not carry a conversation to the new account: {e}"),
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn acct(id: &str, label: &str, agents: &[AgentId]) -> Account {
        Account {
            id: id.into(),
            label: label.into(),
            config_dir: format!("/cfg/{id}"),
            agents: agents.to_vec(),
        }
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("conduit-pacct-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_ref_is_opaque_stable_and_resolves_back() {
        let accounts = vec![
            acct("a1", "Arlo", &[AgentId::Claude]),
            acct("a2", "Personal", &[AgentId::Claude]),
        ];
        let r = account_ref("a1");
        assert_eq!(r, account_ref("a1"));
        assert!(!r.contains("a1"));
        assert_ne!(r, account_ref("a2"));
        assert_eq!(resolve_ref(&accounts, &r).unwrap().label, "Arlo");
        assert!(resolve_ref(&accounts, "u000000000000").is_none());
        // Not the same hash as a usage row's key for the account.
        assert_ne!(r, usage_key_for(AgentId::Claude, Some("a1")).unwrap());
    }

    #[test]
    fn the_view_never_carries_an_id_or_a_path() {
        let v = accounts_view(&[acct("secret-id", "Arlo", &[AgentId::Claude])]);
        let s = v.to_string();
        assert!(!s.contains("secret-id"));
        assert!(!s.contains("/cfg/"));
        let row = &v["list"][0];
        assert_eq!(row["label"], "Arlo");
        assert_eq!(row["agents"][0], "claude");
        assert_eq!(
            row["usage"]["claude"],
            json!(usage_key_for(AgentId::Claude, Some("secret-id")).unwrap())
        );
        assert_eq!(
            v["defaultUsage"]["claude"],
            json!(usage_key("claude", "default"))
        );
    }

    #[test]
    fn choosing_checks_the_ref_and_the_agent() {
        let accounts = vec![acct("a1", "Arlo", &[AgentId::Claude])];
        assert!(matches!(
            choose(&accounts, AgentId::Claude, ""),
            Ok(AccountChoice::Default)
        ));
        assert!(matches!(
            choose(&accounts, AgentId::Claude, &account_ref("a1")),
            Ok(AccountChoice::Account(a)) if a.id == "a1"
        ));
        assert!(choose(&accounts, AgentId::Antigravity, &account_ref("a1")).is_err());
        assert!(choose(&accounts, AgentId::Claude, "nope").is_err());
    }

    #[test]
    fn the_effective_account_follows_session_then_project_then_global() {
        let accounts = vec![
            acct("a1", "Arlo", &[AgentId::Claude]),
            acct("a2", "Personal", &[AgentId::Claude]),
        ];
        let mut p: Project = serde_json::from_value(json!({
            "id": "p", "name": "P", "path": "/x", "sessions": []
        }))
        .unwrap();
        let mut s = Session {
            id: "s".into(),
            name: "S".into(),
            ..Default::default()
        };
        let mut globals = HashMap::new();
        assert!(effective_account(&s, &p, &globals, &accounts).is_none());
        globals.insert(AgentId::Claude, "a2".to_string());
        assert_eq!(
            effective_account(&s, &p, &globals, &accounts).unwrap().id,
            "a2"
        );
        p.default_accounts.insert(AgentId::Claude, "a1".into());
        assert_eq!(
            effective_account(&s, &p, &globals, &accounts).unwrap().id,
            "a1"
        );
        assert_eq!(
            project_defaults(&p, &globals, &accounts)["claude"],
            json!(account_ref("a1"))
        );
        s.account_id = Some("a2".into());
        let (pinned, label) = session_fields(&s, &p, &globals, &accounts);
        assert_eq!(pinned, json!(account_ref("a2")));
        assert_eq!(label, json!("Personal"));
        // A pin naming a removed account is not reported as a pin.
        s.account_id = Some("gone".into());
        let (pinned, _) = session_fields(&s, &p, &globals, &accounts);
        assert_eq!(pinned, Value::Null);
    }

    #[test]
    fn a_transcript_is_carried_once_with_its_folder_and_never_overwritten() {
        let from = tmp("from");
        let to = tmp("to");
        let slug = from.join("C--work-repo");
        fs::create_dir_all(slug.join("conv-1").join("subagents")).unwrap();
        fs::write(slug.join("conv-1.jsonl"), "{\"a\":1}\n").unwrap();
        fs::write(
            slug.join("conv-1").join("subagents").join("agent-x.jsonl"),
            "x",
        )
        .unwrap();
        fs::write(slug.join("other.jsonl"), "o").unwrap();

        assert!(carry_transcript(&from, &to, "conv-1").unwrap());
        let dest = to.join("C--work-repo");
        assert_eq!(
            fs::read_to_string(dest.join("conv-1.jsonl")).unwrap(),
            "{\"a\":1}\n"
        );
        assert!(dest
            .join("conv-1")
            .join("subagents")
            .join("agent-x.jsonl")
            .is_file());
        assert!(!dest.join("other.jsonl").exists());

        // A second carry (or one onto a newer copy) changes nothing.
        fs::write(dest.join("conv-1.jsonl"), "newer").unwrap();
        assert!(!carry_transcript(&from, &to, "conv-1").unwrap());
        assert_eq!(
            fs::read_to_string(dest.join("conv-1.jsonl")).unwrap(),
            "newer"
        );

        // Missing conversation, same dir, or a path-like id: nothing happens.
        assert!(!carry_transcript(&from, &to, "missing").unwrap());
        assert!(!carry_transcript(&from, &from, "conv-1").unwrap());
        assert!(!carry_transcript(&from, &to, "../conv-1").unwrap());
        let _ = fs::remove_dir_all(&from);
        let _ = fs::remove_dir_all(&to);
    }
}
