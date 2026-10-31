//! A phone's view of a session's files: list, read, edit and download, confined to the
//! session's own directory (its worktree once it exists, else the project root).
//!
//! Every path arrives from the phone as a RELATIVE path with `/` separators, and is never
//! joined onto the root as a string. [`resolve`] validates it one component at a time and
//! walks it from the root with `symlink_metadata`, refusing any link or junction on the way,
//! so nothing a phone sends can name a file outside the root -- not `..`, not an absolute
//! path, not a drive letter, an NTFS alternate stream (`name:stream`), a reserved device
//! name, or a link that points elsewhere. A final canonicalize + `strip_prefix` is a second,
//! independent check.
//!
//! Hidden from phones entirely: `.git` (and anything inside it), the upload folder, and the
//! editor's own temp files. Secrets (`.env`, keys, credential files) are LISTED, marked
//! `sensitive`, opened or downloaded only with an explicit `confirm`, and never written.
//! File contents are never logged.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Entries returned for one directory; the rest are counted as `truncated`.
pub const LIST_CAP: usize = 2000;
/// Text sent to the phone for viewing/editing. Larger text files are a read-only preview.
pub const READ_CAP: usize = 1024 * 1024;
/// The largest file a phone may download.
pub const DOWNLOAD_CAP: u64 = 50 * 1024 * 1024;
/// Raw bytes per download chunk (base64 makes it ~512 KiB on the wire, the upload size).
pub const CHUNK_RAW: usize = 384 * 1024;

/// Names never shown to, or reachable from, a phone.
const HIDDEN: &[&str] = &[".git", crate::uploads::UPLOAD_DIR];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsError {
    /// The path is malformed, hidden, a link, or escapes the root. One message for all, so
    /// the reply is not an oracle for what exists outside the root.
    BadPath,
    NotFound,
    /// A secret file read without `confirm`.
    NeedsConfirm,
    /// A write the phone may not make (secret, binary, too large, not a file).
    ReadOnly,
    /// The file changed on disk since the phone read it.
    Conflict,
    TooLarge,
    Io(String),
}

impl FsError {
    pub fn message(&self) -> String {
        match self {
            Self::BadPath => "not available".into(),
            Self::NotFound => "not found".into(),
            Self::NeedsConfirm => "confirm".into(),
            Self::ReadOnly => "read-only".into(),
            Self::Conflict => "conflict".into(),
            Self::TooLarge => "too large".into(),
            Self::Io(e) => e.clone(),
        }
    }
}

/// True if a name is one Windows reserves for a device (`CON`, `NUL`, `COM1`, `LPT9.txt`...).
fn reserved_windows_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// One path component as a phone may send it.
fn valid_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg != "."
        && seg != ".."
        && !seg.contains(['\\', ':', '\0'])
        && !seg.ends_with(['.', ' '])
        && !reserved_windows_name(seg)
        && !HIDDEN.contains(&seg)
        && !is_editor_temp(seg)
}

/// The desktop editor's atomic-write temp (`.<name>.conduit-tmp-<pid>-<nanos>`).
fn is_editor_temp(name: &str) -> bool {
    name.starts_with('.') && name.contains(".conduit-tmp-")
}

/// Split a phone path into validated segments. `""` and `"/"` are the root itself.
pub fn segments(rel: &str) -> Result<Vec<&str>, FsError> {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return Ok(Vec::new());
    }
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.len() > 64 || !segs.iter().all(|s| valid_segment(s)) {
        return Err(FsError::BadPath);
    }
    Ok(segs)
}

/// A secret: listed and marked, opened only with `confirm`, never written from a phone.
pub fn is_sensitive(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n.starts_with(".env") {
        return !matches!(
            n.as_str(),
            ".env.example" | ".env.sample" | ".env.template" | ".env.dist"
        );
    }
    const EXACT: &[&str] = &[
        ".npmrc",
        ".netrc",
        ".pypirc",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        "credentials",
        "credentials.json",
        "secrets.json",
        "service-account.json",
        ".htpasswd",
    ];
    const EXT: &[&str] = &[
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".jks",
        ".keystore",
        ".p8",
        ".kdbx",
    ];
    EXACT.contains(&n.as_str())
        || EXT.iter().any(|e| n.ends_with(e))
        || n.starts_with("id_rsa")
        || n.starts_with("id_ed25519")
}

/// The root a phone browses, confirmed to be a real directory (never a link). A worktree
/// that does not exist yet has no files to show, so it is `NotFound` -- never "the project
/// root instead", which would show the phone a different checkout than the agent's.
pub fn root_of(dir: &str) -> Result<PathBuf, FsError> {
    let p = PathBuf::from(dir);
    match fs::symlink_metadata(&p) {
        Ok(m) if m.is_dir() && !crate::uploads::is_link(&m) => Ok(p),
        Ok(_) => Err(FsError::BadPath),
        Err(_) => Err(FsError::NotFound),
    }
}

/// Resolve a phone path under `root`, walking it one component at a time and refusing any
/// link on the way. Returns the path and its (non-followed) metadata.
pub fn resolve(root: &Path, rel: &str) -> Result<(PathBuf, fs::Metadata), FsError> {
    let segs = segments(rel)?;
    let mut path = root.to_path_buf();
    let mut meta = fs::symlink_metadata(&path).map_err(|_| FsError::NotFound)?;
    for seg in segs {
        if !meta.is_dir() {
            return Err(FsError::NotFound);
        }
        path.push(seg);
        // Belt and braces: a segment that `Path` reads as anything but a plain name (a
        // prefix, a root) must never reach the filesystem.
        if !matches!(path.components().next_back(), Some(Component::Normal(_))) {
            return Err(FsError::BadPath);
        }
        meta = fs::symlink_metadata(&path).map_err(|_| FsError::NotFound)?;
        if crate::uploads::is_link(&meta) {
            return Err(FsError::BadPath);
        }
    }
    // Independent second check: the real location is still inside the real root.
    let (Ok(real_root), Ok(real)) = (fs::canonicalize(root), fs::canonicalize(&path)) else {
        return Err(FsError::NotFound);
    };
    if real.strip_prefix(&real_root).is_err() {
        return Err(FsError::BadPath);
    }
    Ok((path, meta))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    pub mtime_ms: f64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub link: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sensitive: bool,
}

/// A directory listing: folders first, then files, by name. Links are shown (`link: true`)
/// but can never be opened. Hidden names are left out.
pub fn list(root: &Path, rel: &str) -> Result<(Vec<Entry>, usize), FsError> {
    let (dir, meta) = resolve(root, rel)?;
    if !meta.is_dir() {
        return Err(FsError::NotFound);
    }
    let rd = fs::read_dir(&dir).map_err(|e| FsError::Io(e.to_string()))?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if HIDDEN.contains(&name.as_str()) || is_editor_temp(&name) {
            continue;
        }
        let Ok(m) = fs::symlink_metadata(e.path()) else {
            continue;
        };
        let link = crate::uploads::is_link(&m);
        out.push(Entry {
            sensitive: !m.is_dir() && is_sensitive(&name),
            dir: m.is_dir() && !link,
            size: if m.is_dir() { 0 } else { m.len() },
            mtime_ms: crate::fsops::mtime_ms_of(&m),
            link,
            name,
        });
    }
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let truncated = out.len().saturating_sub(LIST_CAP);
    out.truncate(LIST_CAP);
    Ok((out, truncated))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    pub content: String,
    pub binary: bool,
    pub truncated: bool,
    pub read_only: bool,
    pub size: u64,
    pub mtime_ms: f64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sensitive: bool,
}

fn a_file(root: &Path, rel: &str) -> Result<(PathBuf, fs::Metadata, String), FsError> {
    let (path, meta) = resolve(root, rel)?;
    if !meta.is_file() {
        return Err(FsError::NotFound);
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok((path, meta, name))
}

/// Read a file as text for the phone's viewer/editor. Over [`READ_CAP`] it is a truncated,
/// read-only preview; binary and non-UTF-8 are read-only (the desktop editor's rules).
pub fn read(root: &Path, rel: &str, confirm: bool) -> Result<Text, FsError> {
    let (path, meta, name) = a_file(root, rel)?;
    let sensitive = is_sensitive(&name);
    if sensitive && !confirm {
        return Err(FsError::NeedsConfirm);
    }
    let mut data = Vec::new();
    File::open(&path)
        .and_then(|f| f.take(READ_CAP as u64 + 1).read_to_end(&mut data))
        .map_err(|e| FsError::Io(e.to_string()))?;
    let size = meta.len();
    let mtime_ms = crate::fsops::mtime_ms_of(&meta);
    if data.len() > READ_CAP {
        data.truncate(READ_CAP);
        let binary = data[..data.len().min(8192)].contains(&0);
        return Ok(Text {
            content: if binary {
                String::new()
            } else {
                String::from_utf8_lossy(&data).into_owned()
            },
            binary,
            truncated: true,
            read_only: true,
            size,
            mtime_ms,
            sensitive,
        });
    }
    let c = crate::fsops::classify(&data, size);
    Ok(Text {
        content: if c.binary { String::new() } else { c.content },
        binary: c.binary,
        truncated: c.truncated,
        read_only: c.read_only || sensitive,
        size,
        mtime_ms,
        sensitive,
    })
}

/// Save an edit from the phone. Only an existing, editable text file that has NOT changed
/// since the phone read it (`base_*` is the stat the phone was given) -- so an edit on the
/// phone never silently overwrites one made on the computer. Never a secret.
pub fn write(
    root: &Path,
    rel: &str,
    content: &str,
    base_mtime_ms: f64,
    base_size: u64,
) -> Result<crate::fsops::FileStat, FsError> {
    let (path, meta, name) = a_file(root, rel)?;
    if is_sensitive(&name) || content.len() > READ_CAP {
        return Err(FsError::ReadOnly);
    }
    if meta.len() != base_size || (crate::fsops::mtime_ms_of(&meta) - base_mtime_ms).abs() > 0.001 {
        return Err(FsError::Conflict);
    }
    // The file on disk must itself be editable text (not binary / non-UTF-8 / oversized).
    let current = read(root, rel, false)?;
    if current.read_only {
        return Err(FsError::ReadOnly);
    }
    crate::fsops::write_file(&path.to_string_lossy(), content).map_err(FsError::Io)
}

/// An open download: the file is opened ONCE, so a file replaced mid-download cannot change
/// what the phone receives.
pub struct Download {
    file: std::io::Take<File>,
    pub size: u64,
    pub name: String,
    pub seq: u32,
}

/// Open a file for download (see [`Download`]).
pub fn open_download(root: &Path, rel: &str, confirm: bool) -> Result<Download, FsError> {
    let (path, _, name) = a_file(root, rel)?;
    if is_sensitive(&name) && !confirm {
        return Err(FsError::NeedsConfirm);
    }
    let file = File::open(&path).map_err(|e| FsError::Io(e.to_string()))?;
    let size = file
        .metadata()
        .map_err(|e| FsError::Io(e.to_string()))?
        .len();
    if size > DOWNLOAD_CAP {
        return Err(FsError::TooLarge);
    }
    Ok(Download {
        file: file.take(size),
        size,
        name,
        seq: 0,
    })
}

impl Download {
    /// The next chunk, or an empty Vec at the end.
    pub fn next_chunk(&mut self) -> Result<Vec<u8>, FsError> {
        let mut buf = vec![0u8; CHUNK_RAW];
        let mut n = 0;
        while n < CHUNK_RAW {
            match self.file.read(&mut buf[n..]) {
                Ok(0) => break,
                Ok(k) => n += k,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(FsError::Io(e.to_string())),
            }
        }
        buf.truncate(n);
        self.seq += 1;
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "conduit-phone-fs-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn segments_refuse_everything_but_plain_relative_names() {
        assert_eq!(segments("").unwrap(), Vec::<&str>::new());
        assert_eq!(segments("/src/main.rs/").unwrap(), vec!["src", "main.rs"]);
        for bad in [
            "../x",
            "a/../../b",
            "a/./b",
            "a//b",
            "C:/Windows",
            "c:",
            "file.txt:secret",
            "a\\..\\b",
            "nul",
            "CON.txt",
            "lpt1",
            "x.",
            "x ",
            ".git/config",
            "sub/.git",
            ".conduit-uploads/a.png",
            ".main.rs.conduit-tmp-1-2",
            "a\0b",
        ] {
            assert_eq!(segments(bad), Err(FsError::BadPath), "{bad:?}");
        }
        // Not reserved: a name that merely starts like one.
        assert!(segments("console.log").is_ok());
        assert!(segments("com10").is_ok());
        assert!(segments("com0").is_ok());
    }

    #[test]
    fn secrets_are_recognized_and_examples_are_not() {
        for s in [
            ".env",
            ".env.local",
            ".ENV.production",
            "server.pem",
            "tls.key",
            "id_rsa",
            "id_ed25519.pub",
            "credentials.json",
            ".npmrc",
            "store.p12",
        ] {
            assert!(is_sensitive(s), "{s}");
        }
        for s in [
            ".env.example",
            ".env.sample",
            "keyboard.ts",
            "README.md",
            "env.ts",
        ] {
            assert!(!is_sensitive(s), "{s}");
        }
    }

    #[test]
    fn lists_hide_git_and_mark_secrets_and_sort_folders_first() {
        let root = tmp("list");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        fs::write(root.join(".env"), "SECRET=1").unwrap();
        fs::write(root.join(".a.txt.conduit-tmp-1-2"), "").unwrap();
        let (entries, truncated) = list(&root, "").unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", ".env", "b.txt"]);
        assert!(entries[0].dir);
        assert!(entries[1].sensitive);
        assert_eq!(truncated, 0);
        assert_eq!(list(&root, ".git"), Err(FsError::BadPath));
        assert_eq!(list(&root, "b.txt"), Err(FsError::NotFound));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_link_inside_the_root_is_listed_but_never_followed() {
        let root = tmp("link");
        let outside = tmp("outside");
        fs::write(outside.join("secret.txt"), "x").unwrap();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, root.join("out")).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, root.join("out")).is_ok();
        if made {
            let (entries, _) = list(&root, "").unwrap();
            assert!(entries.iter().any(|e| e.name == "out" && e.link && !e.dir));
            assert_eq!(list(&root, "out"), Err(FsError::BadPath));
            assert_eq!(read(&root, "out/secret.txt", true), Err(FsError::BadPath));
        }
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn reads_text_refuses_secrets_without_confirm_and_previews_binaries() {
        let root = tmp("read");
        fs::write(root.join("a.txt"), "hello").unwrap();
        fs::write(root.join(".env"), "K=1").unwrap();
        fs::write(root.join("b.bin"), [0u8, 1, 2]).unwrap();
        let t = read(&root, "a.txt", false).unwrap();
        assert_eq!(t.content, "hello");
        assert!(!t.read_only);
        assert_eq!(read(&root, ".env", false), Err(FsError::NeedsConfirm));
        let s = read(&root, ".env", true).unwrap();
        assert!(s.sensitive && s.read_only);
        let b = read(&root, "b.bin", false).unwrap();
        assert!(b.binary && b.read_only && b.content.is_empty());
        let big = "x".repeat(READ_CAP + 10);
        fs::write(root.join("big.txt"), &big).unwrap();
        let t = read(&root, "big.txt", false).unwrap();
        assert!(t.truncated && t.read_only);
        assert_eq!(t.content.len(), READ_CAP);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_write_needs_the_stat_the_phone_read_and_never_touches_secrets() {
        let root = tmp("write");
        fs::write(root.join("a.txt"), "one").unwrap();
        fs::write(root.join(".env"), "K=1").unwrap();
        let t = read(&root, "a.txt", false).unwrap();
        // Stale base: someone else changed it.
        assert_eq!(
            write(&root, "a.txt", "two", t.mtime_ms, t.size + 1),
            Err(FsError::Conflict)
        );
        let stat = write(&root, "a.txt", "two", t.mtime_ms, t.size).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "two");
        assert_eq!(stat.size, 3);
        let e = read(&root, ".env", true).unwrap();
        assert_eq!(
            write(&root, ".env", "K=2", e.mtime_ms, e.size),
            Err(FsError::ReadOnly)
        );
        // Never creates a file.
        assert_eq!(write(&root, "new.txt", "x", 0.0, 0), Err(FsError::NotFound));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_download_streams_the_file_it_opened_in_chunks() {
        let root = tmp("dl");
        let data: Vec<u8> = (0..(CHUNK_RAW * 2 + 5)).map(|i| (i % 251) as u8).collect();
        fs::write(root.join("f.bin"), &data).unwrap();
        let mut d = open_download(&root, "f.bin", false).unwrap();
        assert_eq!(d.size, data.len() as u64);
        let mut got = Vec::new();
        loop {
            let c = d.next_chunk().unwrap();
            if c.is_empty() {
                break;
            }
            got.extend(c);
        }
        assert_eq!(got, data);
        assert_eq!(
            open_download(&root, "missing", false).err(),
            Some(FsError::NotFound)
        );
        fs::write(root.join("k.pem"), "x").unwrap();
        assert_eq!(
            open_download(&root, "k.pem", false).err(),
            Some(FsError::NeedsConfirm)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_root_must_be_a_real_directory() {
        let root = tmp("root");
        assert!(root_of(&root.to_string_lossy()).is_ok());
        assert_eq!(
            root_of(&root.join("nope").to_string_lossy()),
            Err(FsError::NotFound)
        );
        fs::write(root.join("f"), "").unwrap();
        assert_eq!(
            root_of(&root.join("f").to_string_lossy()),
            Err(FsError::BadPath)
        );
        let _ = fs::remove_dir_all(&root);
    }
}
