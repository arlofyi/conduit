//! Per-session files Conduit writes into its data dir, and the cleanup that keeps them
//! from piling up.
//!
//! Every spawn writes some of these (the Windows spawn script, the Conductor persona and
//! MCP config, a session's MCP allowlist config), and nothing deleted them: one machine
//! had 155 spawn scripts for 79 sessions. Each is regenerated on the session's next spawn,
//! so removing one whose session is gone loses nothing.
//!
//! The scrollback snapshots have their own sweep (`scrollback::sweep`); the Hermes overlay
//! directory is removed by `hermes::remove_managed_config`.

use std::collections::HashSet;
use std::fs;

/// `(prefix, suffix)` of every per-session file name. The id is what lies between.
const PATTERNS: [(&str, &str); 4] = [
    ("spawn-", ".cmd"),
    ("conductor-persona-", ".txt"),
    ("conductor-mcp-", ".json"),
    ("session-mcp-", ".json"),
];

/// The session id a data-dir file belongs to, or None if it is not a per-session file.
pub fn session_of(file_name: &str) -> Option<&str> {
    PATTERNS.iter().find_map(|(prefix, suffix)| {
        let id = file_name.strip_prefix(prefix)?.strip_suffix(suffix)?;
        (!id.is_empty()).then_some(id)
    })
}

/// The per-session file names in `names` whose session is not in `live`.
pub fn orphans<'a>(names: impl IntoIterator<Item = &'a str>, live: &HashSet<&str>) -> Vec<&'a str> {
    names
        .into_iter()
        .filter(|name| session_of(name).is_some_and(|id| !live.contains(id)))
        .collect()
}

/// Remove the per-session files of sessions that no longer exist.
///
/// Does nothing when `live` is empty: an empty store is also what an unreadable state.json
/// looks like, and a sweep must never act on that guess (the same rule the orphan sweep
/// documents in CLAUDE.md).
pub fn sweep(live: &[String]) {
    if live.is_empty() {
        return;
    }
    let dir = crate::store::data_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    let live: HashSet<&str> = live.iter().map(String::as_str).collect();
    for name in orphans(names.iter().map(String::as_str), &live) {
        let _ = fs::remove_file(dir.join(name));
    }
}

/// Remove one session's per-session files. Called when the session is destroyed.
pub fn remove_for(session_id: &str) {
    let dir = crate::store::data_dir();
    for (prefix, suffix) in PATTERNS {
        let _ = fs::remove_file(dir.join(format!("{prefix}{session_id}{suffix}")));
    }
}

/// Windows: delete the stray `NUL` files Conduit's old hook command left in project trees.
///
/// Claude ran that command through Git Bash, where `>NUL` creates a FILE called `NUL` (it
/// holds the hook server's `ok`) in whatever directory the agent was in. Only files that
/// are exactly that -- named NUL, holding nothing or `ok` -- are removed; anything else
/// with the name is somebody's data and is left alone. Returns how many were removed.
///
/// `NUL` is a reserved device name, so the file can only be read or deleted through a
/// verbatim (`\\?\`) path; a plain path opens the null device instead.
#[cfg(windows)]
pub fn remove_stray_nul_files(roots: &[String]) -> usize {
    use std::path::{Path, PathBuf};
    const SKIP: [&str; 4] = ["node_modules", ".git", "target", "$RECYCLE.BIN"];
    const MAX_DEPTH: usize = 12;

    fn verbatim(path: &Path) -> PathBuf {
        let s = path.to_string_lossy().replace('/', "\\");
        if s.starts_with(r"\\?\") {
            PathBuf::from(s)
        } else {
            PathBuf::from(format!(r"\\?\{s}"))
        }
    }

    let mut removed = 0;
    let mut pending: Vec<(PathBuf, usize)> = roots
        .iter()
        .filter(|r| Path::new(r.as_str()).is_absolute())
        .map(|r| (verbatim(Path::new(r)), 0))
        .collect();
    while let Some((dir, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_DEPTH && !SKIP.contains(&name.as_ref()) {
                    pending.push((entry.path(), depth + 1));
                }
            } else if kind.is_file() && name.eq_ignore_ascii_case("NUL") {
                let path = entry.path();
                let is_stray = fs::metadata(&path).is_ok_and(|m| m.len() <= 16)
                    && fs::read(&path).is_ok_and(|b| is_hook_reply(&b));
                if is_stray && fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    removed
}

/// What the old hook command wrote into a stray NUL file: nothing, or the server's `ok`.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_hook_reply(bytes: &[u8]) -> bool {
    let s = String::from_utf8_lossy(bytes);
    let s = s.trim();
    s.is_empty() || s == "ok"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_session_names_map_to_their_session() {
        assert_eq!(session_of("spawn-abc-123.cmd"), Some("abc-123"));
        assert_eq!(session_of("conductor-persona-s1.txt"), Some("s1"));
        assert_eq!(session_of("conductor-mcp-s1.json"), Some("s1"));
        assert_eq!(session_of("session-mcp-s1.json"), Some("s1"));
    }

    #[test]
    fn shared_files_are_never_per_session() {
        for name in [
            "state.json",
            "state.json.bak",
            "conduit-hook.cmd",
            "conduit-ask.cmd",
            "conduit-hooks.json",
            "spawn-.cmd",
            "spawn-x.txt",
            "telemetry_client_id",
        ] {
            assert_eq!(session_of(name), None, "{name}");
        }
    }

    #[test]
    fn only_the_hook_reply_counts_as_a_stray_nul_file() {
        assert!(is_hook_reply(b"ok"));
        assert!(is_hook_reply(b""));
        assert!(is_hook_reply(b"ok\r\n"));
        assert!(!is_hook_reply(b"something else"));
    }

    #[cfg(windows)]
    #[test]
    fn stray_nul_files_are_removed_and_real_ones_kept() {
        let root = std::env::temp_dir().join(format!("conduit-nul-sweep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("sub").join("node_modules")).unwrap();
        let v = |p: std::path::PathBuf| {
            std::path::PathBuf::from(format!(r"\\?\{}", p.to_string_lossy()))
        };
        fs::write(v(root.join("NUL")), "ok").unwrap();
        fs::write(v(root.join("sub").join("NUL")), "").unwrap();
        fs::write(v(root.join("sub").join("node_modules").join("NUL")), "ok").unwrap();
        fs::write(v(root.join("keep")), "x").unwrap();
        let removed = remove_stray_nul_files(&[root.to_string_lossy().into_owned()]);
        assert_eq!(removed, 2, "node_modules is skipped");
        assert!(!v(root.join("NUL")).exists());
        assert!(v(root.join("sub").join("node_modules").join("NUL")).exists());
        let _ = fs::remove_dir_all(v(root));
    }

    #[test]
    fn only_files_of_unknown_sessions_are_orphans() {
        let live: HashSet<&str> = ["keep"].into_iter().collect();
        let names = [
            "spawn-keep.cmd",
            "spawn-gone.cmd",
            "conductor-persona-gone.txt",
            "state.json",
        ];
        assert_eq!(
            orphans(names, &live),
            vec!["spawn-gone.cmd", "conductor-persona-gone.txt"]
        );
    }
}
