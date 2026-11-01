//! Local diagnostics: a rotating log file, a panic hook, and per-run counters.
//!
//! NOTHING here leaves the machine. Lines go to `<data_dir>/logs/conduit.log` (rotated at
//! [`MAX_LOG_BYTES`], [`KEEP_FILES`] files in all) and to stderr. The anonymous PostHog
//! ping in `telemetry.rs` is a separate, opt-out feature and shares no code with this.
//!
//! What must never be written: tokens, QR secrets, nonces, prompts/chat text, MCP env, file
//! contents. Callers are responsible for not passing those; [`redact`] is a best-effort
//! second line (key=value secrets, `Bearer x`, well-known token prefixes, long random runs,
//! the user's home directory), not a licence to log a payload.
//!
//! File writes happen only after [`init`] — which only `run()` calls — so unit tests that
//! exercise an error path never write into the developer's real data dir.

use std::collections::{HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Rotate the live file once it would grow past this.
pub const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
/// `conduit.log` + `conduit.1.log` + `conduit.2.log`.
pub const KEEP_FILES: usize = 3;
/// Errors/warnings kept in memory for Settings -> About.
const RECENT_CAP: usize = 50;
/// One ordinary log message, after redaction.
const MSG_CAP: usize = 4 * 1024;
/// A panic message plus its backtrace.
const PANIC_CAP: usize = 16 * 1024;
/// How often the stats line is written while running.
const STATS_EVERY: Duration = Duration::from_secs(60 * 60);

// Frontend reports: caps and rate limit.
const FE_KIND_CAP: usize = 32;
const FE_SOURCE_CAP: usize = 200;
const FE_MESSAGE_CAP: usize = 2 * 1024;
const FE_STACK_CAP: usize = 6 * 1024;
const FE_MAX_PER_WINDOW: usize = 20;
const FE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Error,
    Warn,
    Info,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
        }
    }
}

/// Per-run counters. In memory only; reset every launch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Counter {
    SessionsSpawned,
    SpawnFailures,
    PhoneConnections,
    PhoneAuthFailures,
    TunnelsOpened,
    Errors,
    Warnings,
    Panics,
    FrontendErrors,
    FrontendDropped,
}

const COUNTERS: [Counter; 10] = [
    Counter::SessionsSpawned,
    Counter::SpawnFailures,
    Counter::PhoneConnections,
    Counter::PhoneAuthFailures,
    Counter::TunnelsOpened,
    Counter::Errors,
    Counter::Warnings,
    Counter::Panics,
    Counter::FrontendErrors,
    Counter::FrontendDropped,
];

impl Counter {
    fn index(self) -> usize {
        self as usize
    }
    pub fn key(self) -> &'static str {
        match self {
            Counter::SessionsSpawned => "sessions_spawned",
            Counter::SpawnFailures => "spawn_failures",
            Counter::PhoneConnections => "phone_connections",
            Counter::PhoneAuthFailures => "phone_auth_failures",
            Counter::TunnelsOpened => "tunnels_opened",
            Counter::Errors => "errors",
            Counter::Warnings => "warnings",
            Counter::Panics => "panics",
            Counter::FrontendErrors => "frontend_errors",
            Counter::FrontendDropped => "frontend_dropped",
        }
    }
}

struct Diag {
    started: Instant,
    counters: [AtomicU64; COUNTERS.len()],
    recent: Mutex<VecDeque<String>>,
    writer: Mutex<Option<LogWriter>>,
    once: Mutex<HashSet<String>>,
    frontend: Mutex<RateLimiter>,
    home: Option<String>,
}

fn diag() -> &'static Diag {
    static DIAG: OnceLock<Diag> = OnceLock::new();
    DIAG.get_or_init(|| Diag {
        started: Instant::now(),
        counters: Default::default(),
        recent: Mutex::new(VecDeque::with_capacity(RECENT_CAP)),
        writer: Mutex::new(None),
        once: Mutex::new(HashSet::new()),
        frontend: Mutex::new(RateLimiter::new(FE_MAX_PER_WINDOW, FE_WINDOW)),
        home: dirs::home_dir().map(|p| p.to_string_lossy().into_owned()),
    })
}

/// The directory the log files live in.
pub fn log_dir() -> PathBuf {
    crate::store::data_dir().join("logs")
}

/// Start writing to the log file, install the panic hook, and start the hourly stats line.
/// Called once, first thing in `run()`.
pub fn init() {
    let d = diag();
    {
        let mut w = d.writer.lock().unwrap_or_else(|e| e.into_inner());
        if w.is_some() {
            return;
        }
        *w = Some(LogWriter::new(log_dir(), MAX_LOG_BYTES, KEEP_FILES));
    }
    install_panic_hook();
    info(
        "app",
        format!(
            "Conduit {} starting ({} {})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    );
    let _ = std::thread::Builder::new()
        .name("diag-stats".into())
        .spawn(|| loop {
            std::thread::sleep(STATS_EVERY);
            info("stats", stats_line());
        });
}

pub fn bump(c: Counter) {
    diag().counters[c.index()].fetch_add(1, Ordering::Relaxed);
}

fn count(c: Counter) -> u64 {
    diag().counters[c.index()].load(Ordering::Relaxed)
}

pub fn error(source: &str, msg: impl AsRef<str>) {
    log(Level::Error, source, msg.as_ref());
}

pub fn warn(source: &str, msg: impl AsRef<str>) {
    log(Level::Warn, source, msg.as_ref());
}

pub fn info(source: &str, msg: impl AsRef<str>) {
    log(Level::Info, source, msg.as_ref());
}

/// [`warn`], but only the first time `key` is seen this run -- for a failure a poll loop
/// would otherwise repeat every few seconds (a missing `netstat`, an unwritable dir).
pub fn warn_once(key: &str, source: &str, msg: impl AsRef<str>) {
    let first = diag()
        .once
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key.to_string());
    if first {
        warn(source, msg);
    }
}

fn log(level: Level, source: &str, msg: &str) {
    match level {
        Level::Error => bump(Counter::Errors),
        Level::Warn => bump(Counter::Warnings),
        Level::Info => {}
    }
    let d = diag();
    let line = format_line(
        now_utc(),
        level,
        source,
        &prepare(msg, d.home.as_deref(), MSG_CAP),
    );
    emit(d, level, &line, false);
}

/// Write one finished line everywhere it goes. `from_panic` uses `try_lock` so a panic
/// raised while this thread already holds a lock cannot deadlock the hook.
fn emit(d: &Diag, level: Level, line: &str, from_panic: bool) {
    eprintln!("{line}");
    if level != Level::Info {
        let mut recent = if from_panic {
            match d.recent.try_lock() {
                Ok(g) => Some(g),
                Err(std::sync::TryLockError::Poisoned(p)) => Some(p.into_inner()),
                Err(_) => None,
            }
        } else {
            Some(d.recent.lock().unwrap_or_else(|e| e.into_inner()))
        };
        if let Some(r) = recent.as_mut() {
            if r.len() == RECENT_CAP {
                r.pop_front();
            }
            r.push_back(truncate(line, 1024));
        }
    }
    let writer = if from_panic {
        match d.writer.try_lock() {
            Ok(g) => Some(g),
            Err(std::sync::TryLockError::Poisoned(p)) => Some(p.into_inner()),
            Err(_) => None,
        }
    } else {
        Some(d.writer.lock().unwrap_or_else(|e| e.into_inner()))
    };
    if let Some(mut w) = writer {
        if let Some(w) = w.as_mut() {
            let _ = w.write_line(line);
        }
    }
}

/// Redact, then cap. Pure.
fn prepare(msg: &str, home: Option<&str>, cap: usize) -> String {
    truncate(&redact_with_home(msg, home), cap)
}

/// `ts LEVEL [source] message`, continuation lines indented. Pure.
fn format_line(ts: String, level: Level, source: &str, msg: &str) -> String {
    let body = msg.trim_end().replace("\r\n", "\n").replace('\n', "\n    ");
    format!("{ts} {:<5} [{source}] {body}\n", level.as_str())
}

/// Cut `s` to at most `cap` bytes on a char boundary, saying how much was dropped.
fn truncate(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let mut end = cap;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[+{} bytes]", &s[..end], s.len() - end)
}

// ---- Log file + rotation --------------------------------------------------------------

struct LogWriter {
    dir: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: Option<File>,
    size: u64,
}

impl LogWriter {
    fn new(dir: PathBuf, max_bytes: u64, keep: usize) -> Self {
        LogWriter {
            dir,
            max_bytes,
            keep: keep.max(1),
            file: None,
            size: 0,
        }
    }

    fn live_path(&self) -> PathBuf {
        rotated_path(&self.dir, 0)
    }

    fn open(&mut self) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.live_path())?;
        self.size = f.metadata().map(|m| m.len()).unwrap_or(0);
        self.file = Some(f);
        Ok(())
    }

    fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        if self.file.is_none() {
            self.open()?;
        }
        let len = line.len() as u64;
        if self.size > 0 && self.size + len > self.max_bytes {
            self.file = None; // close before renaming (Windows refuses to rename an open file)
            rotate_files(&self.dir, self.keep)?;
            self.open()?;
        }
        if let Some(f) = self.file.as_mut() {
            f.write_all(line.as_bytes())?;
            self.size += len;
        }
        Ok(())
    }
}

/// `conduit.log` for 0, `conduit.<n>.log` otherwise.
fn rotated_path(dir: &Path, n: usize) -> PathBuf {
    if n == 0 {
        dir.join("conduit.log")
    } else {
        dir.join(format!("conduit.{n}.log"))
    }
}

/// Drop the oldest file and shift the rest up by one. The destination of every rename is
/// freed first, because a rename onto an existing file fails on Windows.
fn rotate_files(dir: &Path, keep: usize) -> std::io::Result<()> {
    if keep <= 1 {
        let _ = fs::remove_file(rotated_path(dir, 0));
        return Ok(());
    }
    let _ = fs::remove_file(rotated_path(dir, keep - 1));
    for n in (0..keep - 1).rev() {
        let from = rotated_path(dir, n);
        if from.exists() {
            fs::rename(&from, rotated_path(dir, n + 1))?;
        }
    }
    Ok(())
}

// ---- Redaction ------------------------------------------------------------------------

/// A key whose value is a secret. Matched case-insensitively anywhere in an identifier, so
/// `access_token`, `X-Api-Key` and `"clientSecret":` are all caught.
const SECRET_KEYS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "api_key",
    "apikey",
    "api-key",
    "authorization",
    "cookie",
    "nonce",
    "private_key",
    "credential",
];

/// Prefixes of well-known credential formats. A run starting with one is always redacted.
const TOKEN_PREFIXES: &[&str] = &[
    "sk-",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "AKIA",
    "phc_",
];

/// Best-effort secret scrubbing. Pure: `home` is passed in so it is testable.
fn redact_with_home(s: &str, home: Option<&str>) -> String {
    // Bearer first: `Authorization: Bearer x` would otherwise lose only the word "Bearer".
    let mut out = redact_bearer(s);
    out = redact_key_values(&out);
    out = redact_runs(&out);
    if let Some(h) = home.filter(|h| h.len() > 3) {
        out = out.replace(h, "~");
        let fwd = h.replace('\\', "/");
        if fwd != h {
            out = out.replace(&fwd, "~");
        }
    }
    out
}

const REDACTED: &str = "<redacted>";

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn ends_value(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '&' | ';' | '}' | ')' | ']')
}

/// `key=value`, `key: value`, `"key": "value"` -> value redacted.
fn redact_key_values(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let lower: Vec<char> = s.to_lowercase().chars().collect();
    // to_lowercase can change length for exotic chars; fall back to ASCII lowering then.
    let lower = if lower.len() == chars.len() {
        lower
    } else {
        chars.iter().map(|c| c.to_ascii_lowercase()).collect()
    };
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let hit = SECRET_KEYS.iter().find(|k| {
            let k: Vec<char> = k.chars().collect();
            lower.len() >= i + k.len() && lower[i..i + k.len()] == k[..]
        });
        let Some(key) = hit else {
            out.push(chars[i]);
            i += 1;
            continue;
        };
        // Consume the rest of the identifier the key sits in.
        let mut j = i + key.chars().count();
        while j < chars.len() && is_ident(chars[j]) {
            j += 1;
        }
        let ident_end = j;
        // Optional closing quote, whitespace, then a separator.
        if j < chars.len() && matches!(chars[j], '"' | '\'') {
            j += 1;
        }
        while j < chars.len() && chars[j] == ' ' {
            j += 1;
        }
        if j < chars.len() && matches!(chars[j], '=' | ':') {
            j += 1;
            while j < chars.len() && chars[j] == ' ' {
                j += 1;
            }
            if j < chars.len() && matches!(chars[j], '"' | '\'') {
                j += 1;
            }
            let v_start = j;
            while j < chars.len() && !ends_value(chars[j]) {
                j += 1;
            }
            if j > v_start {
                out.extend(&chars[i..v_start]);
                out.push_str(REDACTED);
                i = j;
                continue;
            }
        }
        out.extend(&chars[i..ident_end]);
        i = ident_end;
    }
    out
}

/// `Bearer <x>` / `Basic <x>` -> the credential redacted.
fn redact_bearer(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut words = s.split_inclusive(char::is_whitespace).peekable();
    while let Some(w) = words.next() {
        out.push_str(w);
        let bare = w.trim_end();
        if (bare.eq_ignore_ascii_case("bearer") || bare.eq_ignore_ascii_case("basic"))
            && bare.len() != w.len()
        {
            if let Some(next) = words.peek() {
                let v = next.trim_end();
                if !v.is_empty() && v != REDACTED {
                    let tail = &next[v.len()..];
                    out.push_str(REDACTED);
                    out.push_str(tail);
                    words.next();
                }
            }
        }
    }
    out
}

fn run_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '=')
}

/// A run that looks like a credential: a known token prefix, or 32+ chars with a
/// `-`-separated segment of 20+ chars mixing letters and digits. UUIDs (segments of at
/// most 12) and ordinary words survive, so session ids stay readable.
fn looks_secret(run: &str) -> bool {
    if TOKEN_PREFIXES
        .iter()
        .any(|p| run.starts_with(p) && run.len() >= p.len() + 12)
    {
        return true;
    }
    if run.len() < 32 {
        return false;
    }
    run.split('-').any(|seg| {
        seg.len() >= 20
            && seg.chars().any(|c| c.is_ascii_digit())
            && seg.chars().any(|c| c.is_ascii_alphabetic())
    })
}

fn redact_runs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if !run.is_empty() {
            if looks_secret(run) {
                out.push_str(REDACTED);
            } else {
                out.push_str(run);
            }
            run.clear();
        }
    };
    for c in s.chars() {
        if run_char(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    // `<redacted>` itself is not a run char sequence, so it is never re-redacted.
    out
}

// ---- Time -----------------------------------------------------------------------------

fn now_utc() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format_utc(d.as_secs(), d.subsec_millis())
}

/// RFC 3339 UTC with milliseconds, from Unix seconds. Pure (no chrono dependency).
fn format_utc(secs: u64, millis: u32) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 -> (year, month, day). Howard Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn format_uptime(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if h > 0 {
        format!("{h}h{m:02}m{s:02}s")
    } else if m > 0 {
        format!("{m}m{s:02}s")
    } else {
        format!("{s}s")
    }
}

// ---- Stats ----------------------------------------------------------------------------

/// One line: uptime plus every counter. Written hourly, at shutdown, and before an update.
pub fn stats_line() -> String {
    let mut s = format!(
        "uptime={}",
        format_uptime(diag().started.elapsed().as_secs())
    );
    for c in COUNTERS {
        s.push_str(&format!(" {}={}", c.key(), count(c)));
    }
    s
}

/// Write the stats line now (shutdown / pre-update).
pub fn log_stats(reason: &str) {
    info("stats", format!("{reason}: {}", stats_line()));
}

// ---- Panic hook -----------------------------------------------------------------------

fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        bump(Counter::Panics);
        bump(Counter::Errors);
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".into());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let thread = std::thread::current();
        let thread = thread.name().unwrap_or("<unnamed>");
        let bt = std::backtrace::Backtrace::force_capture();
        let msg = format!("thread '{thread}' panicked at {location}: {payload}\nbacktrace:\n{bt}");
        let d = diag();
        let line = format_line(
            now_utc(),
            Level::Error,
            "panic",
            &prepare(&msg, d.home.as_deref(), PANIC_CAP),
        );
        emit(d, Level::Error, &line, true);
        default(info);
    }));
}

// ---- Rate limiter ---------------------------------------------------------------------

/// At most `max` events per sliding `window`. Time is passed in so it is testable.
struct RateLimiter {
    max: usize,
    window: Duration,
    hits: VecDeque<Instant>,
}

impl RateLimiter {
    fn new(max: usize, window: Duration) -> Self {
        RateLimiter {
            max,
            window,
            hits: VecDeque::new(),
        }
    }

    fn allow(&mut self, now: Instant) -> bool {
        while self
            .hits
            .front()
            .is_some_and(|t| now.duration_since(*t) >= self.window)
        {
            self.hits.pop_front();
        }
        if self.hits.len() >= self.max {
            return false;
        }
        self.hits.push_back(now);
        true
    }
}

// ---- Tauri commands -------------------------------------------------------------------

/// A frontend error: a React render crash, `window.onerror`, or an unhandled rejection.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FrontendError {
    pub kind: String,
    pub message: String,
    #[serde(default)]
    pub stack: Option<String>,
    /// Which boundary or handler caught it (e.g. `settings:mobile`, `window`).
    #[serde(default)]
    pub source: Option<String>,
}

/// One log entry from a frontend report, capped field by field. Pure.
fn frontend_entry(r: &FrontendError) -> String {
    let kind: String = r
        .kind
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(FE_KIND_CAP)
        .collect();
    let mut s = format!(
        "{} ({}): {}",
        if kind.is_empty() { "error" } else { &kind },
        truncate(r.source.as_deref().unwrap_or("ui"), FE_SOURCE_CAP),
        truncate(&r.message, FE_MESSAGE_CAP)
    );
    if let Some(st) = r.stack.as_deref().filter(|s| !s.trim().is_empty()) {
        s.push('\n');
        s.push_str(&truncate(st, FE_STACK_CAP));
    }
    s
}

/// Log a frontend error. Rate-limited (20/min); returns whether it was written.
#[tauri::command(async)]
pub fn log_frontend_error(report: FrontendError) -> bool {
    bump(Counter::FrontendErrors);
    let allowed = diag()
        .frontend
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .allow(Instant::now());
    if !allowed {
        bump(Counter::FrontendDropped);
        return false;
    }
    let d = diag();
    bump(Counter::Errors);
    let entry = prepare(&frontend_entry(&report), d.home.as_deref(), MSG_CAP * 2);
    let line = format_line(now_utc(), Level::Error, "ui", &entry);
    emit(d, Level::Error, &line, false);
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CounterView {
    pub key: &'static str,
    pub value: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsView {
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    pub log_dir: String,
    pub log_file: String,
    pub uptime_secs: u64,
    pub counters: Vec<CounterView>,
    pub summary: String,
    /// Most recent errors/warnings, newest last, already redacted.
    pub recent: Vec<String>,
    /// The redacted text "Copy diagnostics" puts on the clipboard.
    pub report: String,
}

/// Build the redacted plain-text report. Pure.
fn build_report(
    version: &str,
    os: &str,
    arch: &str,
    summary: &str,
    recent: &[String],
    home: Option<&str>,
) -> String {
    let mut s = format!("Conduit {version} ({os} {arch})\n{summary}\n");
    if recent.is_empty() {
        s.push_str("\nNo errors or warnings this run.\n");
    } else {
        s.push_str("\nRecent errors and warnings:\n");
        for l in recent {
            s.push_str(l.trim_end());
            s.push('\n');
        }
    }
    redact_with_home(&s, home)
}

#[tauri::command(async)]
pub fn diagnostics() -> DiagnosticsView {
    let d = diag();
    let recent: Vec<String> = {
        let r = d.recent.lock().unwrap_or_else(|e| e.into_inner());
        r.iter().rev().take(20).rev().cloned().collect()
    };
    let summary = stats_line();
    let dir = log_dir();
    DiagnosticsView {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        log_file: rotated_path(&dir, 0).to_string_lossy().into_owned(),
        log_dir: dir.to_string_lossy().into_owned(),
        uptime_secs: d.started.elapsed().as_secs(),
        counters: COUNTERS
            .iter()
            .map(|c| CounterView {
                key: c.key(),
                value: count(*c),
            })
            .collect(),
        report: build_report(
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            &summary,
            &recent,
            d.home.as_deref(),
        ),
        summary,
        recent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "conduit_diag_{tag}_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rotates_at_the_cap_and_keeps_only_n_files() {
        let dir = temp_dir("rotate");
        let mut w = LogWriter::new(dir.clone(), 100, 3);
        let line = format!("{}\n", "x".repeat(39)); // 40 bytes
        for _ in 0..20 {
            w.write_line(&line).unwrap();
        }
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["conduit.1.log", "conduit.2.log", "conduit.log"]);
        for n in &names {
            let len = fs::metadata(dir.join(n)).unwrap().len();
            assert!(len <= 100, "{n} is {len} bytes");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_moves_the_live_file_to_dot_one() {
        let dir = temp_dir("shift");
        let mut w = LogWriter::new(dir.clone(), 10, 3);
        w.write_line("first-line\n").unwrap();
        w.write_line("second\n").unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("conduit.1.log")).unwrap(),
            "first-line\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("conduit.log")).unwrap(),
            "second\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn appends_to_an_existing_log_across_restarts() {
        let dir = temp_dir("append");
        LogWriter::new(dir.clone(), 1000, 3)
            .write_line("a\n")
            .unwrap();
        LogWriter::new(dir.clone(), 1000, 3)
            .write_line("b\n")
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("conduit.log")).unwrap(),
            "a\nb\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn redacts_key_value_secrets() {
        let r = redact_with_home(
            r#"url=http://x/?token=abc123&x=1 "apiKey": "s3cr3t" password: hunter2 access_token=zz"#,
            None,
        );
        assert!(!r.contains("abc123"), "{r}");
        assert!(!r.contains("s3cr3t"), "{r}");
        assert!(!r.contains("hunter2"), "{r}");
        assert!(!r.contains("zz"), "{r}");
        assert!(r.contains("x=1"), "{r}");
        assert!(r.contains("token=<redacted>"), "{r}");
    }

    #[test]
    fn redacts_bearer_and_known_prefixes_and_long_runs() {
        let r = redact_with_home(
            "Authorization: Bearer eyJhbGciOi.xyz sk-ant-api03-AbCdEf123456789 ghp_abcdefghijklmnop1234 Kq8vT2mN5pR7wX9yZ1aB3cD4eF6gH8jL",
            None,
        );
        assert!(!r.contains("eyJhbGciOi"), "{r}");
        assert!(!r.contains("AbCdEf123456789"), "{r}");
        assert!(!r.contains("ghp_abc"), "{r}");
        assert!(!r.contains("Kq8vT2mN5pR7"), "{r}");
        let bare = redact_with_home("Bearer abc.def ok", None);
        assert_eq!(bare, "Bearer <redacted> ok");
    }

    #[test]
    fn keeps_uuids_paths_and_plain_words() {
        let s = "session 550e8400-e29b-41d4-a716-446655440000 spawn failed: spawn-550e8400-e29b-41d4-a716-446655440000.cmd not found (exit code 1) uptime=1h02m sessions_spawned=4";
        assert_eq!(redact_with_home(s, None), s);
    }

    #[test]
    fn replaces_the_home_dir_in_both_slash_styles() {
        let r = redact_with_home(
            r"C:\Users\alice\proj and C:/Users/alice/other",
            Some(r"C:\Users\alice"),
        );
        assert_eq!(r, r"~\proj and ~/other");
        assert_eq!(redact_with_home("/Users/bob/x", Some("/Users/bob")), "~/x");
    }

    #[test]
    fn redaction_never_panics_on_odd_input() {
        for s in [
            "",
            "token",
            "token=",
            "=:",
            "İstanbul token=ü",
            "Bearer",
            "key: \"",
            "ß".repeat(40).as_str(),
        ] {
            let _ = redact_with_home(s, Some("/h"));
        }
    }

    #[test]
    fn rate_limiter_allows_max_per_window_then_recovers() {
        let mut rl = RateLimiter::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(rl.allow(t0));
        assert!(rl.allow(t0));
        assert!(rl.allow(t0 + Duration::from_secs(1)));
        assert!(!rl.allow(t0 + Duration::from_secs(2)));
        assert!(rl.allow(t0 + Duration::from_secs(60)));
        assert!(rl.allow(t0 + Duration::from_secs(60)));
        assert!(!rl.allow(t0 + Duration::from_secs(60)));
    }

    #[test]
    fn truncate_cuts_on_a_char_boundary() {
        let s = "é".repeat(10); // 20 bytes
        let t = truncate(&s, 5);
        assert!(t.starts_with("éé"));
        assert!(t.contains("[+16 bytes]"), "{t}");
        assert_eq!(truncate("short", 10), "short");
    }

    #[test]
    fn line_format_indents_continuations() {
        let l = format_line("T".into(), Level::Warn, "bridge", "one\ntwo\n");
        assert_eq!(l, "T WARN  [bridge] one\n    two\n");
    }

    #[test]
    fn utc_formatting_matches_known_instants() {
        assert_eq!(format_utc(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_utc(1_700_000_000, 5), "2023-11-14T22:13:20.005Z");
        assert_eq!(format_utc(951_782_400, 0), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn uptime_is_human_readable() {
        assert_eq!(format_uptime(5), "5s");
        assert_eq!(format_uptime(65), "1m05s");
        assert_eq!(format_uptime(3723), "1h02m03s");
    }

    #[test]
    fn frontend_entries_are_capped_and_kind_is_sanitized() {
        let r = FrontendError {
            kind: "render\n<script>".into(),
            message: "m".repeat(10_000),
            stack: Some("s".repeat(50_000)),
            source: Some("settings:about".into()),
        };
        let e = frontend_entry(&r);
        assert!(
            e.starts_with("renderscript (settings:about): "),
            "{}",
            &e[..60]
        );
        assert!(e.len() < FE_MESSAGE_CAP + FE_STACK_CAP + 200);
    }

    #[test]
    fn stats_line_names_every_counter() {
        let s = stats_line();
        for c in COUNTERS {
            assert!(s.contains(&format!(" {}=", c.key())), "{s}");
        }
        assert!(s.starts_with("uptime="));
    }

    #[test]
    fn report_is_redacted() {
        let rep = build_report(
            "1.0.0",
            "windows",
            "x86_64",
            "uptime=1s",
            &["T ERROR [x] token=abc in /home/u/p".to_string()],
            Some("/home/u"),
        );
        assert!(rep.contains("token=<redacted>"), "{rep}");
        assert!(rep.contains("~/p"), "{rep}");
        assert!(rep.starts_with("Conduit 1.0.0 (windows x86_64)"));
    }
}
