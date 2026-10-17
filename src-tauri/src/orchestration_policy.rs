//! Versioned, display-only orchestration preferences. Enforcement belongs to later phases.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 1;

/// Omitted fields inherit from the next wider scope. No field in P1 changes launch behavior.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyOverlay {
    #[serde(default)]
    pub context_display: Option<bool>,
    #[serde(default)]
    pub context_warning_target: Option<u64>,
    #[serde(default)]
    pub context_hard_cap: Option<u64>,
    #[serde(default)]
    pub checkpoint_interval_minutes: Option<u32>,
    #[serde(default)]
    pub fleet_total: Option<u16>,
    #[serde(default)]
    pub writers_per_repo: Option<u16>,
    #[serde(default)]
    pub readers: Option<u16>,
    #[serde(default)]
    pub critics: Option<u16>,
    #[serde(default)]
    pub retry_rounds: Option<u16>,
    #[serde(default)]
    pub require_writer_worktree: Option<bool>,
    #[serde(default)]
    pub quota_pause_percent: Option<u8>,
    #[serde(default)]
    pub front_chat_agent: Option<String>,
    #[serde(default)]
    pub conductor_agent: Option<String>,
    #[serde(default)]
    pub different_review_provider: Option<bool>,
    #[serde(default)]
    pub require_review: Option<bool>,
    #[serde(default)]
    pub portability_enabled: Option<bool>,
}

impl PolicyOverlay {
    pub fn merge(&self, over: &Self) -> Self {
        macro_rules! field {
            ($name:ident) => {
                over.$name.clone().or_else(|| self.$name.clone())
            };
        }
        Self {
            context_display: field!(context_display),
            context_warning_target: field!(context_warning_target),
            context_hard_cap: field!(context_hard_cap),
            checkpoint_interval_minutes: field!(checkpoint_interval_minutes),
            fleet_total: field!(fleet_total),
            writers_per_repo: field!(writers_per_repo),
            readers: field!(readers),
            critics: field!(critics),
            retry_rounds: field!(retry_rounds),
            require_writer_worktree: field!(require_writer_worktree),
            quota_pause_percent: field!(quota_pause_percent),
            front_chat_agent: field!(front_chat_agent),
            conductor_agent: field!(conductor_agent),
            different_review_provider: field!(different_review_provider),
            require_review: field!(require_review),
            portability_enabled: field!(portability_enabled),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.context_warning_target == Some(0) || self.context_hard_cap == Some(0) {
            return Err("Context targets must be positive".into());
        }
        if self.checkpoint_interval_minutes == Some(0) {
            return Err("Checkpoint interval must be positive".into());
        }
        if [
            self.fleet_total,
            self.writers_per_repo,
            self.readers,
            self.critics,
        ]
        .into_iter()
        .flatten()
        .any(|n| n == 0 || n > 256)
        {
            return Err("Fleet limits must be between 1 and 256".into());
        }
        if self.retry_rounds.is_some_and(|n| n > 20) {
            return Err("Retry rounds must be at most 20".into());
        }
        if self.quota_pause_percent.is_some_and(|n| n == 0 || n > 100) {
            return Err("Quota pause must be between 1 and 100 percent".into());
        }
        for agent in [&self.front_chat_agent, &self.conductor_agent]
            .into_iter()
            .flatten()
        {
            if !matches!(
                agent.as_str(),
                "claude" | "codex" | "antigravity" | "commandcode" | "opencode" | "gemini"
            ) {
                return Err(format!("Unknown agent: {agent}"));
            }
        }
        Ok(())
    }
}

pub fn defaults() -> PolicyOverlay {
    PolicyOverlay {
        context_display: Some(false),
        require_writer_worktree: Some(false),
        different_review_provider: Some(false),
        require_review: Some(false),
        portability_enabled: Some(false),
        ..Default::default()
    }
}

fn version() -> u32 {
    VERSION
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyDocument {
    #[serde(default = "version")]
    pub version: u32,
    #[serde(default)]
    pub global: PolicyOverlay,
    #[serde(default)]
    pub projects: HashMap<String, PolicyOverlay>,
}

impl Default for PolicyDocument {
    fn default() -> Self {
        Self {
            version: VERSION,
            global: PolicyOverlay::default(),
            projects: HashMap::new(),
        }
    }
}

impl PolicyDocument {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != VERSION {
            return Err(format!("Unsupported policy version: {}", self.version));
        }
        self.global.validate()?;
        for (id, overlay) in &self.projects {
            if id.is_empty() {
                return Err("Project ID cannot be empty".into());
            }
            overlay.validate()?;
        }
        let global = defaults().merge(&self.global);
        if global
            .context_warning_target
            .zip(global.context_hard_cap)
            .is_some_and(|(a, b)| a >= b)
        {
            return Err("Context warning target must be below hard cap".into());
        }
        for overlay in self.projects.values() {
            let effective = global.merge(overlay);
            if effective
                .context_warning_target
                .zip(effective.context_hard_cap)
                .is_some_and(|(a, b)| a >= b)
            {
                return Err("Context warning target must be below hard cap".into());
            }
        }
        Ok(())
    }
}

/// A future/invalid policy must never make the surrounding state.json unreadable: startup
/// would then lose the session list used by the orphan sweep. Imports remain strict.
pub fn deserialize_persisted_safe<'de, D>(d: D) -> Result<PolicyDocument, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value::<PolicyDocument>(raw)
        .ok()
        .filter(|doc| doc.validate().is_ok())
        .unwrap_or_default())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyView {
    pub defaults: PolicyOverlay,
    pub global: PolicyOverlay,
    pub project: PolicyOverlay,
    pub effective: PolicyOverlay,
    pub source: HashMap<&'static str, &'static str>,
}

pub fn view(doc: &PolicyDocument, project_id: Option<&str>) -> PolicyView {
    let project = project_id
        .and_then(|id| doc.projects.get(id))
        .cloned()
        .unwrap_or_default();
    let defaults = defaults();
    let effective = defaults.merge(&doc.global).merge(&project);
    let mut source = HashMap::new();
    macro_rules! source {
        ($name:ident) => {
            source.insert(
                stringify!($name),
                if project.$name.is_some() {
                    "project"
                } else if doc.global.$name.is_some() {
                    "global"
                } else {
                    "default"
                },
            );
        };
    }
    source!(context_display);
    source!(context_warning_target);
    source!(context_hard_cap);
    source!(checkpoint_interval_minutes);
    source!(fleet_total);
    source!(writers_per_repo);
    source!(readers);
    source!(critics);
    source!(retry_rounds);
    source!(require_writer_worktree);
    source!(quota_pause_percent);
    source!(front_chat_agent);
    source!(conductor_agent);
    source!(different_review_provider);
    source!(require_review);
    source!(portability_enabled);
    PolicyView {
        defaults,
        global: doc.global.clone(),
        project,
        effective,
        source,
    }
}

fn check_project(id: &str, store: &crate::store::Store) -> Result<(), String> {
    if store.list().iter().any(|p| p.id == id) {
        Ok(())
    } else {
        Err("Project not found".into())
    }
}

#[tauri::command]
pub fn orchestration_policy_view(
    project_id: Option<String>,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<PolicyView, String> {
    if let Some(id) = &project_id {
        check_project(id, &store)?;
    }
    Ok(view(&store.orchestration_policy(), project_id.as_deref()))
}

#[tauri::command]
pub fn set_orchestration_overlay(
    project_id: Option<String>,
    overlay: PolicyOverlay,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<PolicyView, String> {
    if let Some(id) = &project_id {
        check_project(id, &store)?;
    }
    let doc = store.set_orchestration_overlay(project_id.as_deref(), overlay)?;
    Ok(view(&doc, project_id.as_deref()))
}

#[tauri::command]
pub fn export_orchestration_policy(
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<String, String> {
    serde_json::to_string_pretty(&store.orchestration_policy()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub current: PolicyDocument,
    pub proposed: PolicyDocument,
}

fn parse_import(json: &str, store: &crate::store::Store) -> Result<PolicyDocument, String> {
    let doc: PolicyDocument = serde_json::from_str(json).map_err(|e| e.to_string())?;
    doc.validate()?;
    for id in doc.projects.keys() {
        check_project(id, store)?;
    }
    Ok(doc)
}

#[tauri::command]
pub fn preview_orchestration_import(
    json: String,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<ImportPreview, String> {
    let proposed = parse_import(&json, &store)?;
    Ok(ImportPreview {
        current: store.orchestration_policy(),
        proposed,
    })
}

#[tauri::command]
pub fn import_orchestration_policy(
    json: String,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<(), String> {
    let proposed = parse_import(&json, &store)?;
    store.set_orchestration_policy(proposed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_state_defaults_and_sparse_inheritance() {
        let doc = PolicyDocument::default();
        assert_eq!(view(&doc, Some("p")).effective.context_display, Some(false));
        let mut doc = doc;
        doc.global.context_display = Some(true);
        doc.projects.insert(
            "p".into(),
            PolicyOverlay {
                context_display: Some(false),
                readers: Some(4),
                ..Default::default()
            },
        );
        let p = view(&doc, Some("p"));
        assert_eq!(p.effective.context_display, Some(false));
        assert_eq!(p.source["context_display"], "project");
        assert_eq!(p.effective.readers, Some(4));
        doc.projects.get_mut("p").unwrap().context_display = None;
        assert_eq!(view(&doc, Some("p")).effective.context_display, Some(true));
        assert_eq!(view(&doc, Some("p")).source["context_display"], "global");
    }

    #[test]
    fn import_rejects_unknown_and_invalid_without_mutating_source() {
        assert!(serde_json::from_str::<PolicyDocument>(r#"{"version":2}"#)
            .unwrap()
            .validate()
            .is_err());
        assert!(serde_json::from_str::<PolicyDocument>(
            r#"{"version":1,"global":{"surprise":true}}"#
        )
        .is_err());
        let doc = PolicyDocument::default();
        let before = doc.clone();
        let bad = PolicyDocument {
            global: PolicyOverlay {
                quota_pause_percent: Some(101),
                ..Default::default()
            },
            ..doc.clone()
        };
        assert!(bad.validate().is_err());
        assert_eq!(doc, before);
        assert_eq!(
            serde_json::from_str::<PolicyDocument>(&serde_json::to_string(&doc).unwrap()).unwrap(),
            doc
        );
    }
}
