//! Is an agent still doing something after its turn ended?
//!
//! The hook stream says when a TURN ends (`Stop` -> `done`), not when an agent has nothing
//! left to do. An agent that started a background shell -- a dev server, a test watcher,
//! a CI watch it will be woken by -- reports `done` and then waits. The idle auto-stop read
//! that as finished and retired the session, killing the very work it was waiting on.
//!
//! The process tree answers the question the hooks cannot: the agent's background work is a
//! SHELL running under it. Claude Code's Bash tool runs each command in a shell (bash on
//! macOS/Linux and in Git Bash on Windows; the PowerShell tool in powershell/pwsh), and a
//! background command's shell stays alive until the command does. MCP servers are spawned
//! directly (python, node, uv...), not through a shell, so they never count -- otherwise
//! every session with an MCP server would look busy forever.
//!
//! A shell counts only BELOW the agent (depth >= 2 from the session's root process): the
//! root itself is cmd.exe on Windows and the login shell on POSIX, and its direct child is
//! the agent. A hook (also run through a shell) is a few milliseconds long, so catching one
//! costs one skipped auto-stop tick at worst.

use std::collections::HashMap;

/// One row of the process table: (pid, parent pid, executable name).
pub type ProcRow = (u32, u32, String);

/// Shell executables whose presence under an agent means a command is still running.
const WORK_SHELLS: [&str; 8] = [
    "bash",
    "sh",
    "zsh",
    "fish",
    "dash",
    "pwsh",
    "powershell",
    "nu",
];

fn is_work_shell(name: &str) -> bool {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let base = base
        .strip_suffix(".exe")
        .unwrap_or(base)
        .to_ascii_lowercase();
    // `-bash` is how a login shell names itself in `ps`.
    let base = base.trim_start_matches('-');
    WORK_SHELLS.contains(&base)
}

/// Whether the tree under `root` holds a shell at depth >= 2 (below the agent).
pub fn has_background_work(procs: &[ProcRow], root: u32) -> bool {
    let mut children: HashMap<u32, Vec<&ProcRow>> = HashMap::new();
    for p in procs {
        if p.0 != p.1 {
            children.entry(p.1).or_default().push(p);
        }
    }
    let mut pending: Vec<(u32, usize)> = vec![(root, 0)];
    let mut seen = std::collections::HashSet::new();
    while let Some((pid, depth)) = pending.pop() {
        if !seen.insert(pid) {
            continue;
        }
        for child in children.get(&pid).into_iter().flatten() {
            let d = depth + 1;
            if d >= 2 && is_work_shell(&child.2) {
                return true;
            }
            pending.push((child.0, d));
        }
    }
    false
}

/// A snapshot of every process on the machine, or empty if it cannot be read (which makes
/// every session look idle -- the same answer as before this check existed).
pub fn process_table() -> Vec<ProcRow> {
    #[cfg(windows)]
    {
        windows_process_table()
    }
    #[cfg(not(windows))]
    {
        let Ok(out) = std::process::Command::new("ps")
            .args(["-A", "-o", "pid=,ppid=,comm="])
            .output()
        else {
            return Vec::new();
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| {
                let mut it = line.split_whitespace();
                let pid = it.next()?.parse().ok()?;
                let ppid = it.next()?.parse().ok()?;
                let name = it.collect::<Vec<_>>().join(" ");
                Some((pid, ppid, name))
            })
            .collect()
    }
}

/// Toolhelp snapshot through kernel32 directly: three functions do not justify a
/// `windows-sys` dependency (the lean-dependencies rule).
#[cfg(windows)]
fn windows_process_table() -> Vec<ProcRow> {
    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const INVALID_HANDLE_VALUE: isize = -1;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    let mut rows = Vec::new();
    // SAFETY: plain Win32 calls on a struct we own; `dw_size` is set before the first call
    // as the API requires, and the snapshot handle is closed on every path.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap == 0 {
            return rows;
        }
        let mut entry: ProcessEntry32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry);
        while ok != 0 {
            let len = entry
                .sz_exe_file
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.sz_exe_file.len());
            rows.push((
                entry.th32_process_id,
                entry.th32_parent_process_id,
                String::from_utf16_lossy(&entry.sz_exe_file[..len]),
            ));
            ok = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, name: &str) -> ProcRow {
        (pid, ppid, name.to_string())
    }

    /// cmd.exe (root) -> claude.exe -> {python MCP, bash background task}
    #[test]
    fn a_background_shell_under_the_agent_is_work() {
        let procs = vec![
            row(10, 1, "cmd.exe"),
            row(11, 10, "claude.exe"),
            row(12, 11, "python.exe"),
            row(13, 11, "bash.exe"),
        ];
        assert!(has_background_work(&procs, 10));
    }

    #[test]
    fn mcp_servers_alone_are_not_work() {
        let procs = vec![
            row(10, 1, "cmd.exe"),
            row(11, 10, "claude.exe"),
            row(12, 11, "python.exe"),
            row(13, 12, "python.exe"),
            row(14, 11, "node.exe"),
            row(15, 11, "conhost.exe"),
        ];
        assert!(!has_background_work(&procs, 10));
    }

    /// POSIX: login shell (root, depth 0) -> claude (1) -> zsh background (2).
    #[test]
    fn the_root_shell_itself_never_counts_but_one_below_the_agent_does() {
        let idle = vec![row(20, 1, "-zsh"), row(21, 20, "claude")];
        assert!(!has_background_work(&idle, 20));
        let busy = vec![
            row(20, 1, "-zsh"),
            row(21, 20, "claude"),
            row(22, 21, "/bin/zsh"),
        ];
        assert!(has_background_work(&busy, 20));
        let powershell = vec![
            row(10, 1, "cmd.exe"),
            row(11, 10, "claude.exe"),
            row(12, 11, "cmd.exe"),
            row(13, 12, "powershell.exe"),
        ];
        assert!(has_background_work(&powershell, 10));
    }

    #[test]
    fn a_cycle_from_pid_reuse_cannot_hang_the_walk() {
        let procs = vec![row(1, 2, "a"), row(2, 1, "b")];
        assert!(!has_background_work(&procs, 1));
    }
}
