//! Files a phone hands to a session (photos, camera shots, documents).
//!
//! A file arrives as one `upload` frame on the authenticated bridge socket and is written
//! into the SESSION's own directory, under [`UPLOAD_DIR`]. Inside the session directory the
//! agent reads it with no permission prompt; the folder carries its own `.gitignore` (`*`)
//! so it never appears in `git status` and is never committed. The phone then sends the
//! returned relative path in its message as `@<path>`, which Claude Code resolves as a file
//! attachment (measured on 2.1.316: an image referenced this way was described correctly).
//!
//! The phone's file name is never used as a path: the stored name is built here
//! (`<secs>-<8 hex>-<stem>.<ext>`) from a sanitized stem, and the directory is the one
//! Conduit resolved for the session. Design:
//! `docs/superpowers/specs/2026-10-31-mobile-attachments-design.md`.

use base64::Engine;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Folder inside the session directory that holds uploads.
pub const UPLOAD_DIR: &str = ".conduit-uploads";
/// Largest decoded file. The socket's frame limit is tungstenite's 16 MiB and base64 adds a
/// third, so this is the largest that fits one frame with headroom.
pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
/// Uploads older than this are pruned from the folder on the next upload.
const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 3600);
/// Longest stem kept from the phone's name.
const STEM_MAX: usize = 40;
/// Longest extension kept.
const EXT_MAX: usize = 8;

/// Why an upload was refused. The `Display` text is shown on the phone.
#[derive(Debug, PartialEq, Eq)]
pub enum UploadError {
    NotBase64,
    Empty,
    TooLarge,
    Write(String),
}

impl std::fmt::Display for UploadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotBase64 => f.write_str("The file arrived damaged."),
            Self::Empty => f.write_str("The file is empty."),
            Self::TooLarge => write!(
                f,
                "Files over {} MB can't be sent from the phone.",
                MAX_UPLOAD_BYTES / (1024 * 1024)
            ),
            Self::Write(e) => write!(f, "Couldn't save the file: {e}"),
        }
    }
}

/// Decode a base64 body, refusing anything that would decode past [`MAX_UPLOAD_BYTES`]
/// BEFORE allocating it.
pub fn decode_body(data: &str) -> Result<Vec<u8>, UploadError> {
    // 4 base64 chars carry 3 bytes; checking the encoded length first bounds the allocation.
    if data.len() / 4 * 3 > MAX_UPLOAD_BYTES + 3 {
        return Err(UploadError::TooLarge);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| UploadError::NotBase64)?;
    if bytes.is_empty() {
        return Err(UploadError::Empty);
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(UploadError::TooLarge);
    }
    Ok(bytes)
}

/// Keep only `[A-Za-z0-9_-]`, collapsing everything else to `-`, trimmed and capped.
fn clean(s: &str, max: usize) -> String {
    let mut out = String::new();
    for c in s.chars() {
        let c = if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            c
        } else {
            '-'
        };
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    let out = out.trim_matches('-');
    out.chars().take(max).collect()
}

/// The stored file name for a phone's `name`: `<secs>-<tag>-<stem>.<ext>`. Pure; the
/// caller supplies the time and the random tag.
pub fn stored_name(name: &str, secs: u64, tag: &str) -> String {
    // Only the final path component: a name like "../../x" or "C:\\a\\b.png" is a name,
    // never a path.
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (&base[..i], &base[i + 1..]),
        _ => (base, ""),
    };
    let stem = clean(stem, STEM_MAX);
    let stem = if stem.is_empty() {
        "file".to_string()
    } else {
        stem
    };
    let ext = clean(ext, EXT_MAX).to_ascii_lowercase();
    if ext.is_empty() {
        format!("{secs}-{tag}-{stem}")
    } else {
        format!("{secs}-{tag}-{stem}.{ext}")
    }
}

/// The path the phone puts in its message: relative to the session directory, forward
/// slashes on every OS (Claude's `@` mention and every agent read it the same way).
pub fn message_path(file: &str) -> String {
    format!("{UPLOAD_DIR}/{file}")
}

/// Create the upload folder with its self-ignoring `.gitignore`.
fn ensure_dir(session_dir: &Path) -> std::io::Result<PathBuf> {
    let dir = session_dir.join(UPLOAD_DIR);
    std::fs::create_dir_all(&dir)?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(
            &ignore,
            "# Files sent from the Conduit phone app. Never committed.\n*\n",
        )?;
    }
    Ok(dir)
}

/// Remove uploads older than [`KEEP_FOR`]. Best effort; `.gitignore` is kept.
fn prune(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        if e.file_name() == ".gitignore" {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > KEEP_FOR);
        if old && e.file_type().is_ok_and(|t| t.is_file()) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Decode and write one upload into `session_dir`. Returns the path for the message.
pub fn save(session_dir: &Path, name: &str, data: &str) -> Result<String, UploadError> {
    let bytes = decode_body(data)?;
    let dir = ensure_dir(session_dir).map_err(|e| UploadError::Write(e.to_string()))?;
    let now = SystemTime::now();
    prune(&dir, now);
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let file = stored_name(name, secs, &tag[..8]);
    std::fs::write(dir.join(&file), bytes).map_err(|e| UploadError::Write(e.to_string()))?;
    Ok(message_path(&file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    #[test]
    fn a_phone_name_is_never_a_path() {
        assert_eq!(stored_name("IMG_0042.HEIC", 7, "ab"), "7-ab-IMG_0042.heic");
        assert_eq!(stored_name("../../etc/passwd", 7, "ab"), "7-ab-passwd");
        assert_eq!(
            stored_name(r"C:\Users\x\evil.png", 7, "ab"),
            "7-ab-evil.png"
        );
        assert_eq!(
            stored_name("my photo (1).jpg", 7, "ab"),
            "7-ab-my-photo-1.jpg"
        );
        assert_eq!(stored_name("Café menü.pdf", 7, "ab"), "7-ab-Caf-men.pdf");
        assert_eq!(stored_name(".hidden", 7, "ab"), "7-ab-hidden");
        assert_eq!(stored_name("", 7, "ab"), "7-ab-file");
        assert_eq!(stored_name("..", 7, "ab"), "7-ab-file");
        assert_eq!(stored_name("noext", 7, "ab"), "7-ab-noext");
        assert_eq!(
            stored_name("a.verylongextension", 7, "ab"),
            "7-ab-a.verylong"
        );
        let long = "x".repeat(200);
        assert_eq!(
            stored_name(&format!("{long}.png"), 7, "ab").len(),
            "7-ab-".len() + 40 + 4
        );
    }

    #[test]
    fn the_message_path_uses_forward_slashes() {
        assert_eq!(message_path("1-a-b.png"), ".conduit-uploads/1-a-b.png");
    }

    #[test]
    fn decoding_is_bounded_before_allocating() {
        assert_eq!(decode_body(&STANDARD.encode(b"hi")), Ok(b"hi".to_vec()));
        assert_eq!(decode_body(""), Err(UploadError::Empty));
        assert_eq!(decode_body("not base64!!"), Err(UploadError::NotBase64));
        let big = "A".repeat((MAX_UPLOAD_BYTES / 3 + 2) * 4);
        assert_eq!(decode_body(&big), Err(UploadError::TooLarge));
        let exact = STANDARD.encode(vec![0u8; MAX_UPLOAD_BYTES]);
        assert!(decode_body(&exact).is_ok());
    }

    #[test]
    fn save_writes_inside_a_self_ignoring_folder() {
        let root = std::env::temp_dir().join(format!("conduit-upl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let rel = save(&root, "../shot.png", &STANDARD.encode(b"png-bytes")).unwrap();
        assert!(
            rel.starts_with(".conduit-uploads/") && rel.ends_with("-shot.png"),
            "{rel}"
        );
        assert_eq!(std::fs::read(root.join(&rel)).unwrap(), b"png-bytes");
        let ignore = std::fs::read_to_string(root.join(UPLOAD_DIR).join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l == "*"));
        // nothing escaped the folder
        let top: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(top, vec![std::ffi::OsString::from(UPLOAD_DIR)]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_keeps_the_gitignore_and_recent_files() {
        let root = std::env::temp_dir().join(format!("conduit-upl-{}", uuid::Uuid::new_v4()));
        let dir = ensure_dir(&root).unwrap();
        std::fs::write(dir.join("new.png"), b"x").unwrap();
        prune(&dir, SystemTime::now() + KEEP_FOR + Duration::from_secs(60));
        assert!(dir.join(".gitignore").exists());
        assert!(!dir.join("new.png").exists());
        std::fs::write(dir.join("fresh.png"), b"x").unwrap();
        prune(&dir, SystemTime::now());
        assert!(dir.join("fresh.png").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
