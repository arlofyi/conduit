//! What an agent actually brings to a session: its memory, its skills, its MCP servers.
//!
//! The Model tab answers "what is this session running on". This answers the other half --
//! "what does it know and what can it reach" -- which for an agent with persistent memory
//! is the more interesting question and had no surface at all.
//!
//! **Adaptive by construction, and empty sections are omitted rather than drawn empty.**
//! Agents expose wildly different things: Hermes keeps files of learned memory and a skill
//! tree, Claude has MCP servers and subagents, OpenCode has neither. A panel with a fixed
//! set of headings would be mostly blank for most agents, and a blank "Memory" heading
//! reads as "this agent forgot everything" rather than "this agent has no such concept".
//! So the Rust side returns only the sections it could actually fill, and the frontend adds
//! the ones it already holds (Claude's MCP registry lives in the frontend, not here).
//!
//! Everything is READ-ONLY and degrades to an absent section: an unreadable file, a
//! renamed directory or a config that will not parse costs that section, never the panel.
//! Conduit does not own any of these files.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::agent::AgentId;

/// How much of a memory document to hand the UI.
///
/// These grow without bound -- `MEMORY.md` is appended to for the life of an install -- and
/// the panel shows a preview, not a reader. 16 KB is far more than fits on screen and
/// bounds the IPC payload; the file is named so the user can open the real thing.
const MEMORY_PREVIEW_BYTES: usize = 16 * 1024;

/// The most skills to enumerate. Hermes ships ~52 and a hub install can add many more;
/// past this the list stops being a list.
const MAX_SKILLS: usize = 200;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileItem {
    pub name: String,
    /// One line under the name -- a description, a transport, a size.
    pub detail: String,
    /// Full(ish) text, for items that have one (a memory document). None = nothing to open.
    pub body: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSection {
    /// Stable id for the UI ("memory" | "skills" | "mcp"), not a label.
    pub id: String,
    pub title: String,
    pub items: Vec<ProfileItem>,
    /// Where these came from, so the panel can say what it is showing and the user can go
    /// edit the real thing.
    pub source: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub sections: Vec<ProfileSection>,
    /// True when this agent has no profile surface Conduit can read at all, so the panel
    /// can say so plainly instead of rendering nothing and looking broken.
    pub unsupported: bool,
}

/// Read a file, capped, and return None when it is absent or empty.
///
/// Empty counts as absent on purpose: Hermes creates `MEMORY.md` before it has learned
/// anything, and an item titled "MEMORY.md — 0 bytes" is noise.
fn read_capped(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(if text.len() > MEMORY_PREVIEW_BYTES {
        // Cut on a char boundary -- a byte slice through UTF-8 panics.
        let mut end = MEMORY_PREVIEW_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n\n… truncated", &text[..end])
    } else {
        text
    })
}

/// The memory documents Hermes keeps, in the order a reader wants them.
///
/// `SOUL.md` is the persona the user wrote, `USER.md` is what the agent worked out ABOUT
/// the user, `MEMORY.md` is what it remembered. They are listed separately rather than
/// merged because "what it was told" and "what it inferred" are different things, and the
/// inferred one is the one worth checking.
const MEMORY_DOCS: &[(&str, &str)] = &[
    ("SOUL.md", "Persona you gave it"),
    ("USER.md", "What it has worked out about you"),
    ("MEMORY.md", "What it has remembered"),
];

fn hermes_memory(home: &Path) -> Option<ProfileSection> {
    let items: Vec<ProfileItem> = MEMORY_DOCS
        .iter()
        .filter_map(|(file, what)| {
            let body = read_capped(&home.join(file))?;
            Some(ProfileItem {
                name: (*file).to_string(),
                detail: format!("{what} · {}", human_bytes(body.len())),
                body: Some(body),
            })
        })
        .collect();
    (!items.is_empty()).then(|| ProfileSection {
        id: "memory".into(),
        title: "Memory".into(),
        items,
        source: home.to_string_lossy().into_owned(),
    })
}

fn human_bytes(n: usize) -> String {
    if n < 1024 {
        format!("{n} B")
    } else {
        format!("{:.1} KB", n as f64 / 1024.0)
    }
}

/// `name` and `description` out of a SKILL.md YAML frontmatter block.
///
/// Parsed with a real YAML reader rather than by hand: this is a file the user (or a skill
/// registry) wrote, so its quoting, folding and escapes are not ours to assume. Contrast
/// `hermes::managed_config_yaml`, which EMITS three known scalars and can stay hand-rolled.
/// A skill whose frontmatter will not parse still lists -- under its directory name -- so a
/// malformed one is visible rather than silently missing.
pub fn parse_skill_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let rest = match text.strip_prefix("---") {
        Some(r) => r,
        None => return (None, None),
    };
    let end = match rest.find("\n---") {
        Some(e) => e,
        None => return (None, None),
    };
    let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(&rest[..end]) else {
        return (None, None);
    };
    let get = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    (get("name"), get("description"))
}

/// Hermes lays skills out as `skills/<category>/<name>/SKILL.md`.
fn hermes_skills(home: &Path) -> Option<ProfileSection> {
    let root = home.join("skills");
    let mut items: Vec<ProfileItem> = Vec::new();
    let mut categories = std::fs::read_dir(&root)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .collect::<Vec<_>>();
    categories.sort_by_key(|e| e.file_name());
    for cat in categories {
        let category = cat.file_name().to_string_lossy().into_owned();
        let Ok(entries) = std::fs::read_dir(cat.path()) else {
            continue;
        };
        let mut skills = entries
            .filter_map(Result::ok)
            .filter(|e| e.path().is_dir())
            .collect::<Vec<_>>();
        skills.sort_by_key(|e| e.file_name());
        for sk in skills {
            if items.len() >= MAX_SKILLS {
                break;
            }
            let dir_name = sk.file_name().to_string_lossy().into_owned();
            let (name, desc) = std::fs::read_to_string(sk.path().join("SKILL.md"))
                .map(|t| parse_skill_frontmatter(&t))
                .unwrap_or((None, None));
            items.push(ProfileItem {
                name: name.unwrap_or(dir_name),
                detail: match desc {
                    Some(d) => format!("{category} · {d}"),
                    None => category.clone(),
                },
                body: None,
            });
        }
    }
    (!items.is_empty()).then(|| ProfileSection {
        id: "skills".into(),
        title: "Skills".into(),
        items,
        source: root.to_string_lossy().into_owned(),
    })
}

/// `mcp_servers:` out of Hermes' own config.yaml.
///
/// Read from the file rather than from `hermes mcp list`, which would cost a Python process
/// start (seconds) on every poll of a panel that refreshes while open.
pub fn parse_mcp_servers(config_yaml: &str) -> Vec<ProfileItem> {
    let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(config_yaml) else {
        return Vec::new();
    };
    let Some(map) = v.get("mcp_servers").and_then(|m| m.as_mapping()) else {
        return Vec::new();
    };
    let mut items: Vec<ProfileItem> = map
        .iter()
        .filter_map(|(k, def)| {
            let name = k.as_str()?.to_string();
            // A server is either a URL or a command; say which, because that is the thing
            // a user debugging a dead server needs to see.
            let detail = def
                .get("url")
                .and_then(|u| u.as_str())
                .map(|u| u.to_string())
                .or_else(|| {
                    def.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| c.to_string())
                })
                .unwrap_or_default();
            Some(ProfileItem {
                name,
                detail,
                body: None,
            })
        })
        .collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items
}

fn hermes_mcp(home: &Path) -> Option<ProfileSection> {
    let cfg = home.join("config.yaml");
    let items = parse_mcp_servers(&std::fs::read_to_string(&cfg).ok()?);
    (!items.is_empty()).then(|| ProfileSection {
        id: "mcp".into(),
        title: "MCP servers".into(),
        items,
        source: cfg.to_string_lossy().into_owned(),
    })
}

/// Hermes' home when no account pins one.
///
/// Mirrors `hermes_constants.get_hermes_home`: `HERMES_HOME` wins, then the platform
/// default -- which on Windows is `%LOCALAPPDATA%\hermes`, NOT `~/.hermes`. Getting that
/// wrong would read an empty directory and report an agent that has learned nothing.
pub fn hermes_default_home() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("HERMES_HOME") {
        let p = PathBuf::from(h);
        if p.is_dir() {
            return Some(p);
        }
    }
    #[cfg(windows)]
    let base = dirs::data_local_dir().map(|d| d.join("hermes"));
    #[cfg(not(windows))]
    let base = dirs::home_dir().map(|d| d.join(".hermes"));
    base.filter(|p| p.is_dir())
}

/// Everything Conduit can read about what one session's agent knows.
#[tauri::command]
pub async fn agent_profile(
    session_id: String,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<AgentProfile, String> {
    let agent = store.session_agent(&session_id);
    let account_dir = store.session_account_config_dir(&session_id);
    Ok(tauri::async_runtime::spawn_blocking(move || match agent {
        AgentId::Hermes => {
            let home = account_dir
                .as_deref()
                .and_then(crate::agent::hermes_home_dir)
                .or_else(hermes_default_home);
            match home {
                None => AgentProfile {
                    sections: Vec::new(),
                    unsupported: false,
                },
                Some(home) => AgentProfile {
                    sections: [
                        hermes_memory(&home),
                        hermes_skills(&home),
                        hermes_mcp(&home),
                    ]
                    .into_iter()
                    .flatten()
                    .collect(),
                    unsupported: false,
                },
            }
        }
        // Claude's MCP registry and its subagents already live in the frontend (the registry
        // is localStorage, the subagents have their own tab), so there is nothing to read
        // here that the panel does not already hold. Reporting `unsupported: false` with no
        // sections lets the frontend fill them itself.
        AgentId::Claude => AgentProfile {
            sections: Vec::new(),
            unsupported: false,
        },
        _ => AgentProfile {
            sections: Vec::new(),
            unsupported: true,
        },
    })
    .await
    .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_skills_frontmatter_block() {
        let (name, desc) = parse_skill_frontmatter(
            "---\nname: sdlc-review\ndescription: Review Kanban handoffs.\nversion: 1.1.0\n---\n# body\n",
        );
        assert_eq!(name.as_deref(), Some("sdlc-review"));
        assert_eq!(desc.as_deref(), Some("Review Kanban handoffs."));
    }

    #[test]
    fn a_malformed_skill_yields_nothing_rather_than_panicking() {
        // The caller falls back to the directory name, so a broken skill still LISTS --
        // visible and wrong-looking beats silently missing.
        assert_eq!(parse_skill_frontmatter("no frontmatter"), (None, None));
        assert_eq!(parse_skill_frontmatter("---\n: : :\n---\n"), (None, None));
        assert_eq!(parse_skill_frontmatter("---\nname: x\n"), (None, None)); // unterminated
    }

    #[test]
    fn empty_frontmatter_fields_read_as_absent() {
        let (name, desc) = parse_skill_frontmatter("---\nname: \"\"\ndescription: \"  \"\n---\n");
        assert_eq!(name, None);
        assert_eq!(desc, None);
    }

    #[test]
    fn reads_mcp_servers_by_url_or_command() {
        let items = parse_mcp_servers(
            "mcp_servers:\n  zed:\n    url: https://example.com/mcp\n  local:\n    command: /usr/bin/thing\n",
        );
        assert_eq!(items.len(), 2);
        // Sorted, so the panel order does not depend on map iteration.
        assert_eq!(items[0].name, "local");
        assert_eq!(items[0].detail, "/usr/bin/thing");
        assert_eq!(items[1].name, "zed");
        assert_eq!(items[1].detail, "https://example.com/mcp");
    }

    #[test]
    fn no_mcp_block_is_empty_not_an_error() {
        assert!(parse_mcp_servers("model:\n  provider: openrouter\n").is_empty());
        assert!(parse_mcp_servers("").is_empty());
        assert!(parse_mcp_servers("{{ not yaml").is_empty());
    }

    #[test]
    fn a_memory_file_is_capped_on_a_char_boundary() {
        let dir = std::env::temp_dir().join(format!("conduit_profile_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("big.md");
        // Multi-byte chars straddling the cap would panic a naive byte slice.
        std::fs::write(&f, "é".repeat(MEMORY_PREVIEW_BYTES)).unwrap();
        let body = read_capped(&f).expect("reads");
        assert!(body.ends_with("… truncated"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_memory_file_is_absent_rather_than_an_empty_row() {
        let dir = std::env::temp_dir().join(format!("conduit_profile_e_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("MEMORY.md");
        std::fs::write(&f, "   \n\n").unwrap();
        assert!(read_capped(&f).is_none());
        assert!(read_capped(&dir.join("nope.md")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
