//! Files a phone hands to a session (photos, camera shots, documents).
//!
//! A file arrives as `upload` frames on the authenticated bridge socket and is written into
//! the SESSION's own directory, under [`UPLOAD_DIR`]. Inside the session directory the agent
//! reads it with no permission prompt; the folder carries its own `.gitignore` (`*`) so it
//! never appears in `git status` and is never committed. The phone then sends the returned
//! relative path in its message as `@<path>`, which Claude Code resolves as a file attachment
//! (measured on 2.1.316: an image referenced this way was described correctly).
//!
//! **Chunked.** A file travels as numbered chunks of at most [`CHUNK_MAX_B64`] base64
//! characters, each acked (`uploadProgress`) before the phone sends the next. One frame per
//! file was measured against two limits it could not meet: the desktop drops a remote phone
//! it has not heard from in 35 s (`STALE_AFTER`), and a whole frame counts only once it has
//! fully arrived, so a 10 MB photo on a slow uplink looked like a dead phone; and Android's
//! WebSocket (OkHttp) closes the socket once 16 MiB is queued to send. A frame with no `seq`
//! is a whole file, which keeps the first, unchunked phone build working.
//!
//! **The folder is never trusted.** It lives in a checkout, and a repo can commit
//! `.conduit-uploads` as a symlink or junction to anywhere. So the folder must be a real
//! directory (not a link) directly inside a session directory that exists, and pruning only
//! ever removes names this module wrote (`<secs>-<8 hex>-…`). The phone's file name is never
//! used as a path either. Design: `docs/superpowers/specs/2026-10-31-mobile-attachments-design.md`.

use base64::Engine;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Folder inside the session directory that holds uploads.
pub const UPLOAD_DIR: &str = ".conduit-uploads";
/// Largest decoded file.
pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
/// Largest base64 chunk (a multiple of 4, so every chunk decodes on its own). 512 KiB of
/// text is ~4 s at 1 Mbit/s: far inside `STALE_AFTER` on the slowest uplink worth supporting.
pub const CHUNK_MAX_B64: usize = 512 * 1024;
/// Files one connection may have half-sent at once (the phone sends one at a time).
const IN_FLIGHT_MAX: usize = 3;
/// A half-sent file with no chunk for this long is abandoned.
const IN_FLIGHT_IDLE: Duration = Duration::from_secs(120);
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
    OutOfOrder,
    Busy,
    NoFolder,
    UnsafeFolder,
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
            Self::OutOfOrder => f.write_str("The file arrived out of order. Try again."),
            Self::Busy => f.write_str("Too many files at once. Try again in a moment."),
            Self::NoFolder => f.write_str("The session's folder isn't ready yet."),
            Self::UnsafeFolder => f.write_str(
                "This session's .conduit-uploads isn't a plain folder, so Conduit won't write there.",
            ),
            Self::Write(e) => write!(f, "Couldn't save the file: {e}"),
        }
    }
}

/// Decode one base64 piece, refusing anything that would take the file past
/// [`MAX_UPLOAD_BYTES`] BEFORE allocating it. `already` is what earlier chunks decoded to.
fn decode_piece(data: &str, already: usize) -> Result<Vec<u8>, UploadError> {
    // 4 base64 chars carry 3 bytes; checking the encoded length first bounds the allocation.
    if already + data.len() / 4 * 3 > MAX_UPLOAD_BYTES + 3 {
        return Err(UploadError::TooLarge);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| UploadError::NotBase64)?;
    if already + bytes.len() > MAX_UPLOAD_BYTES {
        return Err(UploadError::TooLarge);
    }
    Ok(bytes)
}

/// A whole-file body: decode with the same bounds. (Tests; the bridge goes through `Assembler`.)
#[cfg(test)]
pub fn decode_body(data: &str) -> Result<Vec<u8>, UploadError> {
    let bytes = decode_piece(data, 0)?;
    if bytes.is_empty() {
        return Err(UploadError::Empty);
    }
    Ok(bytes)
}

/// One file being received in chunks.
struct Partial {
    session_id: String,
    name: String,
    next_seq: u32,
    bytes: Vec<u8>,
    touched: Instant,
}

/// A finished file, ready to write.
#[derive(Debug, PartialEq, Eq)]
pub struct Complete {
    pub session_id: String,
    pub name: String,
    pub bytes: Vec<u8>,
}

/// Per-connection reassembly of chunked uploads. Pure apart from the clock.
#[derive(Default)]
pub struct Assembler {
    open: HashMap<String, Partial>,
}

impl Assembler {
    /// Take one chunk. `Ok(None)` = more to come (ack it); `Ok(Some)` = the file is whole.
    /// Any error drops what was received for that request.
    pub fn push(
        &mut self,
        request_id: &str,
        session_id: &str,
        name: &str,
        seq: u32,
        done: bool,
        data: &str,
    ) -> Result<Option<Complete>, UploadError> {
        let now = Instant::now();
        self.open
            .retain(|_, p| now.duration_since(p.touched) < IN_FLIGHT_IDLE);
        if data.len() > CHUNK_MAX_B64 + 4 {
            self.open.remove(request_id);
            return Err(UploadError::TooLarge);
        }
        if seq == 0 {
            if !self.open.contains_key(request_id) && self.open.len() >= IN_FLIGHT_MAX {
                return Err(UploadError::Busy);
            }
            self.open.insert(
                request_id.to_string(),
                Partial {
                    session_id: session_id.to_string(),
                    name: name.to_string(),
                    next_seq: 0,
                    bytes: Vec::new(),
                    touched: now,
                },
            );
        }
        let Some(p) = self.open.get_mut(request_id) else {
            return Err(UploadError::OutOfOrder);
        };
        // A chunk must continue the SAME file, in order.
        if p.next_seq != seq || p.session_id != session_id {
            self.open.remove(request_id);
            return Err(UploadError::OutOfOrder);
        }
        let piece = match decode_piece(data, p.bytes.len()) {
            Ok(b) => b,
            Err(e) => {
                self.open.remove(request_id);
                return Err(e);
            }
        };
        p.bytes.extend_from_slice(&piece);
        p.next_seq += 1;
        p.touched = now;
        if !done {
            return Ok(None);
        }
        let p = self.open.remove(request_id).expect("present above");
        if p.bytes.is_empty() {
            return Err(UploadError::Empty);
        }
        Ok(Some(Complete {
            session_id: p.session_id,
            name: p.name,
            bytes: p.bytes,
        }))
    }
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

/// True for a name [`stored_name`] produced: digits, `-`, 8 lowercase hex, `-`. The only
/// files pruning may ever remove.
fn is_ours(name: &str) -> bool {
    let Some((secs, rest)) = name.split_once('-') else {
        return false;
    };
    let Some((tag, _)) = rest.split_once('-') else {
        return false;
    };
    !secs.is_empty()
        && secs.bytes().all(|b| b.is_ascii_digit())
        && tag.len() == 8
        && tag
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The path the phone puts in its message: relative to the session directory, forward
/// slashes on every OS (Claude's `@` mention and every agent read it the same way).
pub fn message_path(file: &str) -> String {
    format!("{UPLOAD_DIR}/{file}")
}

/// True when `p` is a symlink, or on Windows any reparse point (a junction is not a
/// symlink to `is_symlink`, but it redirects all the same).
fn is_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// The upload folder, created if absent, refused unless it is a real directory directly
/// inside an existing session directory. Never creates the session directory itself: a
/// worktree that is not there yet (or was deleted) must not be conjured into a plain folder,
/// which would make `git worktree add` fail and the panels adopt a non-git directory.
fn ensure_dir(session_dir: &Path) -> Result<PathBuf, UploadError> {
    match std::fs::symlink_metadata(session_dir) {
        Ok(m) if m.is_dir() => {}
        _ => return Err(UploadError::NoFolder),
    }
    let dir = session_dir.join(UPLOAD_DIR);
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if is_link(&m) || !m.is_dir() => return Err(UploadError::UnsafeFolder),
        Ok(_) => {}
        // Only the last component: `create_dir`, never `create_dir_all`.
        Err(_) => std::fs::create_dir(&dir).map_err(|e| UploadError::Write(e.to_string()))?,
    }
    let ignore = dir.join(".gitignore");
    if std::fs::symlink_metadata(&ignore).is_err() {
        std::fs::write(
            &ignore,
            "# Files sent from the Conduit phone app. Never committed.\n*\n",
        )
        .map_err(|e| UploadError::Write(e.to_string()))?;
    }
    Ok(dir)
}

/// Remove OUR uploads older than [`KEEP_FOR`]. Best effort; anything else is left alone.
fn prune(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        if !e.file_name().to_str().is_some_and(is_ours) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(e.path()) else {
            continue;
        };
        if !meta.is_file() || is_link(&meta) {
            continue;
        }
        let old = meta
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > KEEP_FOR);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Write one finished upload into `session_dir`. Returns the path for the message.
pub fn save_bytes(session_dir: &Path, name: &str, bytes: &[u8]) -> Result<String, UploadError> {
    if bytes.is_empty() {
        return Err(UploadError::Empty);
    }
    let dir = ensure_dir(session_dir)?;
    let now = SystemTime::now();
    prune(&dir, now);
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let file = stored_name(name, secs, &tag[..8]);
    // `create_new`: never follow or replace something already at that name.
    use std::io::Write;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(&file))
        .and_then(|mut f| f.write_all(bytes))
        .map_err(|e| UploadError::Write(e.to_string()))?;
    Ok(message_path(&file))
}

/// Decode a whole-file body and write it. (Tests; the bridge goes through `Assembler`.)
#[cfg(test)]
pub fn save(session_dir: &Path, name: &str, data: &str) -> Result<String, UploadError> {
    save_bytes(session_dir, name, &decode_body(data)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    fn temp() -> PathBuf {
        let root = std::env::temp_dir().join(format!("conduit-upl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

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
    fn only_our_names_are_prunable() {
        assert!(is_ours("1730000000-0a1b2c3d-shot.png"));
        assert!(is_ours(&stored_name("x.png", 99, "deadbeef")));
        assert!(!is_ours("notes.md"));
        assert!(!is_ours("1730000000-ZZZZZZZZ-x"));
        assert!(!is_ours("abc-0a1b2c3d-x"));
        assert!(!is_ours(".gitignore"));
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
    fn chunks_reassemble_in_order_and_refuse_anything_else() {
        let body: Vec<u8> = (0..3000u32).map(|i| (i % 251) as u8).collect();
        let b64 = STANDARD.encode(&body);
        let parts: Vec<&str> = b64
            .as_bytes()
            .chunks(1000)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        let mut a = Assembler::default();
        for (i, part) in parts.iter().enumerate() {
            let last = i + 1 == parts.len();
            let r = a.push("r1", "s", "a.png", i as u32, last, part).unwrap();
            if last {
                assert_eq!(r.unwrap().bytes, body);
            } else {
                assert!(r.is_none());
            }
        }
        // Out of order, a different session mid-file, and a chunk with no start all fail.
        let mut a = Assembler::default();
        a.push("r2", "s", "a", 0, false, "aGk=").unwrap();
        assert_eq!(
            a.push("r2", "s", "a", 2, true, "aGk="),
            Err(UploadError::OutOfOrder)
        );
        a.push("r3", "s", "a", 0, false, "aGk=").unwrap();
        assert_eq!(
            a.push("r3", "other", "a", 1, true, "aGk="),
            Err(UploadError::OutOfOrder)
        );
        assert_eq!(
            a.push("nope", "s", "a", 1, true, "aGk="),
            Err(UploadError::OutOfOrder)
        );
        // An unchunked frame is seq 0 + done.
        let whole = a.push("r4", "s", "a", 0, true, "aGk=").unwrap().unwrap();
        assert_eq!(whole.bytes, b"hi");
    }

    #[test]
    fn chunks_are_bounded() {
        let mut a = Assembler::default();
        let too_big = "A".repeat(CHUNK_MAX_B64 + 8);
        assert_eq!(
            a.push("r", "s", "a", 0, false, &too_big),
            Err(UploadError::TooLarge)
        );
        // The running total is capped, not just each chunk.
        let chunk = "A".repeat(CHUNK_MAX_B64);
        let mut seq = 0;
        let err = loop {
            match a.push("t", "s", "a", seq, false, &chunk) {
                Ok(_) => seq += 1,
                Err(e) => break e,
            }
        };
        assert_eq!(err, UploadError::TooLarge);
        // A connection may only hold a few half-sent files.
        let mut a = Assembler::default();
        for i in 0..IN_FLIGHT_MAX {
            a.push(&format!("f{i}"), "s", "a", 0, false, "aGk=")
                .unwrap();
        }
        assert_eq!(
            a.push("more", "s", "a", 0, false, "aGk="),
            Err(UploadError::Busy)
        );
    }

    #[test]
    fn save_writes_inside_a_self_ignoring_folder() {
        let root = temp();
        let rel = save(&root, "../shot.png", &STANDARD.encode(b"png-bytes")).unwrap();
        assert!(
            rel.starts_with(".conduit-uploads/") && rel.ends_with("-shot.png"),
            "{rel}"
        );
        assert_eq!(std::fs::read(root.join(&rel)).unwrap(), b"png-bytes");
        let ignore = std::fs::read_to_string(root.join(UPLOAD_DIR).join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l == "*"));
        let top: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(top, vec![std::ffi::OsString::from(UPLOAD_DIR)]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_session_folder_is_never_created() {
        let root = temp();
        let missing = root.join("worktree-not-yet");
        assert_eq!(
            save_bytes(&missing, "a.png", b"x"),
            Err(UploadError::NoFolder)
        );
        assert!(!missing.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_where_the_folder_should_be_is_refused() {
        let root = temp();
        std::fs::write(root.join(UPLOAD_DIR), b"not a dir").unwrap();
        assert_eq!(
            save_bytes(&root, "a.png", b"x"),
            Err(UploadError::UnsafeFolder)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_folder_is_refused_and_its_target_untouched() {
        let root = temp();
        let elsewhere = temp();
        std::fs::write(elsewhere.join("precious.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join(UPLOAD_DIR)).unwrap();
        assert_eq!(
            save_bytes(&root, "a.png", b"x"),
            Err(UploadError::UnsafeFolder)
        );
        assert!(elsewhere.join("precious.txt").exists());
        assert!(!elsewhere.join(".gitignore").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[cfg(windows)]
    #[test]
    fn a_junctioned_folder_is_refused_and_its_target_untouched() {
        let root = temp();
        let elsewhere = temp();
        std::fs::write(elsewhere.join("precious.txt"), b"keep").unwrap();
        // A junction needs no privilege, unlike a symlink: the realistic attack on Windows.
        let link = root.join(UPLOAD_DIR);
        let st = std::process::Command::new("cmd")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&elsewhere)
            .output()
            .unwrap();
        assert!(st.status.success(), "{st:?}");
        assert_eq!(
            save_bytes(&root, "a.png", b"x"),
            Err(UploadError::UnsafeFolder)
        );
        assert!(elsewhere.join("precious.txt").exists());
        assert!(!elsewhere.join(".gitignore").exists());
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn prune_removes_only_our_old_files() {
        let root = temp();
        let dir = ensure_dir(&root).unwrap();
        std::fs::write(dir.join("1700000000-0a1b2c3d-old.png"), b"x").unwrap();
        std::fs::write(dir.join("someone-elses.md"), b"x").unwrap();
        prune(&dir, SystemTime::now() + KEEP_FOR + Duration::from_secs(60));
        assert!(!dir.join("1700000000-0a1b2c3d-old.png").exists());
        assert!(
            dir.join("someone-elses.md").exists(),
            "never ours, never pruned"
        );
        assert!(dir.join(".gitignore").exists());
        std::fs::write(dir.join("1700000000-0a1b2c3d-fresh.png"), b"x").unwrap();
        prune(&dir, SystemTime::now());
        assert!(dir.join("1700000000-0a1b2c3d-fresh.png").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
