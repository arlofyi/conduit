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

/// Skills Hermes refuses to disable from any surface (`agent.skill_utils.ESSENTIAL_SKILLS`).
///
/// Kept for the day Conduit offers a skill switch: `save_disabled_skills` drops these
/// SILENTLY, so a control offered for one would flip, save, and come back on with no error
/// anywhere. Whatever surface eventually turns skills off must refuse these rather than
/// accept-and-ignore them.
#[cfg_attr(not(test), allow(dead_code))]
const ESSENTIAL_SKILLS: &[&str] = &["hermes-agent"];

/// How much of a SKILL.md to hand the UI. Same reasoning as `MEMORY_PREVIEW_BYTES`: a
/// truncated body must never be written back, and the UI refuses to save one.
const SKILL_PREVIEW_BYTES: usize = 64 * 1024;

/// The most skills to enumerate. Hermes ships ~52 and a hub install can add many more;
/// past this the list stops being a list.
const MAX_SKILLS: usize = 200;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileItem {
    pub name: String,
    /// One line under the name -- a description, a transport, a size.
    pub detail: String,
    /// Full(ish) text, for items that have one (a memory document, a SKILL.md).
    /// None = nothing to open.
    pub body: Option<String>,
    /// The identifier this item is addressed by when written back -- a skill's DIRECTORY
    /// name. None for items that cannot be acted on.
    ///
    /// The directory name rather than the frontmatter one because Hermes' own visibility
    /// predicate (`prompt_builder.hides`) accepts EITHER, and only the directory name is
    /// guaranteed to exist: a skill whose frontmatter will not parse still lists, and a
    /// toggle keyed on a name that parsed to nothing would silently do nothing.
    pub key: Option<String>,
    /// Whether this item is currently active, for things that can be inactive. None = the
    /// question does not apply.
    ///
    /// **Read-only, and it has to be.** Hermes' agent side reads `skills.disabled` straight
    /// out of `HERMES_HOME/config.yaml` (`agent/skill_utils.py::_load_raw_config`, whose own
    /// docstring says "no hermes_cli.config import"), so the managed-scope overlay -- which
    /// is a `hermes_cli.config.load_config` feature -- never reaches it. Measured: an overlay
    /// `skills.disabled: [findmy]` leaves `get_disabled_skill_names()` empty. Changing it
    /// would therefore mean writing the user's own config.yaml, which is machine-wide and
    /// their call, not a side effect of opening a panel.
    pub enabled: Option<bool>,
}

impl ProfileItem {
    /// An item that is only shown, never acted on (a memory document, an MCP server).
    fn inert(name: String, detail: String, body: Option<String>) -> Self {
        ProfileItem {
            name,
            detail,
            body,
            key: None,
            enabled: None,
        }
    }
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
    read_capped_to(path, MEMORY_PREVIEW_BYTES)
}

/// `read_capped` with an explicit cap. A SKILL.md is a document the user may want to edit
/// whole, so it gets a larger one than a memory preview.
fn read_capped_to(path: &Path, cap: usize) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(if text.len() > cap {
        // Cut on a char boundary -- a byte slice through UTF-8 panics.
        let mut end = cap;
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
            Some(ProfileItem::inert(
                (*file).to_string(),
                format!("{what} · {}", human_bytes(body.len())),
                Some(body),
            ))
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

/// Every skill on disk, as `(directory name, path to its SKILL.md)`.
///
/// **The one place a skill directory is located.** Both the reader and the writer walk this,
/// so a skill is only ever addressed by a path CONDUIT produced -- the frontend's string is
/// compared against these names, never joined onto a path. Same reasoning as `MEMORY_DOCS`:
/// an allowlist cannot be talked into writing elsewhere, and "sanitize the path" is a guess
/// about what the OS does with `..`, a symlink, an ADS or a UNC prefix.
fn hermes_skill_dirs(home: &Path) -> Vec<(String, String, PathBuf)> {
    let root = home.join("skills");
    let mut out: Vec<(String, String, PathBuf)> = Vec::new();
    let Ok(cats) = std::fs::read_dir(&root) else {
        return out;
    };
    let mut categories = cats
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
            if out.len() >= MAX_SKILLS {
                return out;
            }
            out.push((
                sk.file_name().to_string_lossy().into_owned(),
                category.clone(),
                sk.path().join("SKILL.md"),
            ));
        }
    }
    out
}

/// Hermes lays skills out as `skills/<category>/<name>/SKILL.md`.
///
/// `disabled` is the EFFECTIVE set for this session -- the user's own global list unioned
/// with anything this session has switched off. Both halves matter: showing only the
/// session's would draw a globally disabled skill as active.
fn hermes_skills(
    home: &Path,
    disabled: &std::collections::HashSet<String>,
) -> Option<ProfileSection> {
    let root = home.join("skills");
    let items: Vec<ProfileItem> = hermes_skill_dirs(home)
        .into_iter()
        .map(|(dir_name, category, skill_md)| {
            let text = read_capped_to(&skill_md, SKILL_PREVIEW_BYTES);
            let (name, desc) = text
                .as_deref()
                .map(parse_skill_frontmatter)
                .unwrap_or((None, None));
            ProfileItem {
                name: name.unwrap_or_else(|| dir_name.clone()),
                detail: match desc {
                    Some(d) => format!("{category} · {d}"),
                    None => category,
                },
                body: text,
                enabled: Some(!disabled.contains(&dir_name)),
                key: Some(dir_name),
            }
        })
        .collect();
    (!items.is_empty()).then(|| ProfileSection {
        id: "skills".into(),
        title: "Skills".into(),
        items,
        source: root.to_string_lossy().into_owned(),
    })
}

/// The user's OWN globally disabled skills, out of their `config.yaml`.
///
/// Conduit never writes this key in the user's file -- a session switching a skill off is
/// session-scoped, and lives in the managed overlay. But it must READ it, because the
/// overlay replaces the list rather than unioning it (measured: a list is a leaf, so an
/// overlay `skills.disabled` silently RE-ENABLES everything the user turned off globally).
/// `hermes::managed_config_yaml` is handed the union for exactly that reason.
pub fn hermes_disabled_skills(home: &Path) -> std::collections::HashSet<String> {
    let Ok(text) = std::fs::read_to_string(home.join("config.yaml")) else {
        return Default::default();
    };
    parse_disabled_skills(&text)
}

/// `skills.disabled` out of a Hermes config.yaml.
///
/// Mirrors `skills_config._normalize_skill_names`: YAML null is empty, and a bare scalar is
/// ONE name rather than its characters -- a subtlety their own code carries a bug reference
/// for (#13026). An unparseable file yields nothing rather than erroring: a bad config must
/// cost the toggle state, never the panel.
pub fn parse_disabled_skills(config_yaml: &str) -> std::collections::HashSet<String> {
    let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(config_yaml) else {
        return Default::default();
    };
    let Some(d) = v.get("skills").and_then(|s| s.get("disabled")) else {
        return Default::default();
    };
    match d {
        serde_yaml::Value::String(one) => [one.trim().to_string()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect(),
        serde_yaml::Value::Sequence(seq) => seq
            .iter()
            .filter_map(|x| x.as_str())
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect(),
        _ => Default::default(),
    }
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
            Some(ProfileItem::inert(name, detail, None))
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

/// Rewrite one of an agent's memory documents.
///
/// **The filename is checked against `MEMORY_DOCS`, not sanitized.** An allowlist is the
/// only safe shape here: the name arrives from the frontend, and any "clean the path"
/// approach is a guess about what the OS will do with `..`, a symlink, an alternate data
/// stream or a UNC prefix. Three known names, compared exactly, cannot be talked into
/// writing somewhere else.
///
/// This is the one place Conduit WRITES a file the agent owns, and it is deliberate: the
/// panel shows what the agent has inferred about you, and a wrong inference you cannot
/// correct is worse than one you cannot see. A truncated preview is never written back --
/// the caller must have loaded the whole document, which is why `MEMORY_PREVIEW_BYTES` is
/// generous enough that truncation is rare and the UI refuses to save when it happened.
#[tauri::command]
pub async fn write_agent_memory(
    session_id: String,
    file: String,
    body: String,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<(), String> {
    if !MEMORY_DOCS.iter().any(|(name, _)| *name == file) {
        return Err(format!("{file} is not an editable memory document"));
    }
    if store.session_agent(&session_id) != AgentId::Hermes {
        return Err("this agent has no editable memory".into());
    }
    let account_dir = store.session_account_config_dir(&session_id);
    tauri::async_runtime::spawn_blocking(move || {
        let home = account_dir
            .as_deref()
            .and_then(crate::agent::hermes_home_dir)
            .or_else(hermes_default_home)
            .ok_or("no Hermes home to write to")?;
        std::fs::write(home.join(&file), body).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("write task failed: {e}"))?
}

/// Rewrite one skill's `SKILL.md`.
///
/// **The skill is located by ENUMERATION, never by joining `key` onto a path.**
/// `hermes_skill_dirs` walks the skills tree and the requested key is compared against the
/// directory names it found; a key that matches nothing is refused. That is the same shape
/// as `MEMORY_DOCS` above and for the same reason -- the name arrives from the frontend, and
/// "sanitize the path" is a guess about what the OS will do with `..`, a symlink, an
/// alternate data stream or a UNC prefix. Here the path is one Conduit produced, so there is
/// nothing to sanitize.
///
/// A truncated preview is never written back: the UI refuses to save one, and
/// `SKILL_PREVIEW_BYTES` is generous enough that truncation is rare.
#[tauri::command]
pub async fn write_agent_skill(
    session_id: String,
    key: String,
    body: String,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<(), String> {
    if store.session_agent(&session_id) != AgentId::Hermes {
        return Err("this agent has no editable skills".into());
    }
    let account_dir = store.session_account_config_dir(&session_id);
    tauri::async_runtime::spawn_blocking(move || {
        let home = account_dir
            .as_deref()
            .and_then(crate::agent::hermes_home_dir)
            .or_else(hermes_default_home)
            .ok_or("no Hermes home to write to")?;
        let target = hermes_skill_dirs(&home)
            .into_iter()
            .find(|(dir_name, _, _)| *dir_name == key)
            .map(|(_, _, skill_md)| skill_md)
            .ok_or_else(|| format!("no skill named {key}"))?;
        std::fs::write(target, body).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("write task failed: {e}"))?
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
                        hermes_skills(&home, &hermes_disabled_skills(&home)),
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
    fn reads_the_users_globally_disabled_skills() {
        // The ordinary shape.
        let d = parse_disabled_skills("skills:\n  disabled:\n    - alpha\n    - beta\n");
        assert_eq!(d.len(), 2);
        assert!(d.contains("alpha") && d.contains("beta"));

        // A BARE SCALAR is one name, not its characters. Hermes' own normalizer carries a
        // bug reference for exactly this (#13026); splitting it would disable nothing and
        // silently report a dozen single-letter skills as off.
        let one = parse_disabled_skills("skills:\n  disabled: alpha\n");
        assert_eq!(one.len(), 1);
        assert!(one.contains("alpha"));

        // YAML null, a missing key, a missing section, and an unparseable file are all
        // "nothing disabled" -- a bad config must cost the toggle state, never the panel.
        for src in [
            "skills:\n  disabled:\n",
            "skills: {}\n",
            "other: 1\n",
            "::: not yaml :::\n",
            "",
        ] {
            assert!(parse_disabled_skills(src).is_empty(), "{src:?}");
        }
    }

    #[test]
    fn hermes_requires_its_own_skill() {
        // Mirrors `agent.skill_utils.ESSENTIAL_SKILLS`. `save_disabled_skills` drops these
        // SILENTLY, so a switch offered for one would flip, save, and come back on with no
        // error anywhere -- the panel locks them instead.
        assert!(ESSENTIAL_SKILLS.contains(&"hermes-agent"));
    }

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
