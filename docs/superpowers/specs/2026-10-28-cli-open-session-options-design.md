# `conduit` command: session options

Status: draft for approval, 2026-10-28. Requested by Orbit's "Fix" hand-off (see `~/ooozzy/orbit/docs/superpowers/specs/2026-10-28-waiting-dig-fix-design.md`), but useful on its own.

## Intent

`conduit <path> --agent <id>` opens a project and starts a session. Other tools (Orbit first) want to start a session that is already pointed at a task: in its own worktree, with a name, and with a first prompt. Conduit can already do each of those from its own UI (`useWorktree`, session names, `takePendingPrompt` feeding `initial_prompt`); the command just cannot ask for them.

## Change

```
conduit <path> [--agent <id>] [--worktree <slug>] [--name <text>] [--prompt-file <file>]
```

- `--worktree <slug>`: the new session uses a worktree with exactly this slug (`claude --worktree <slug>`, so `<repo>/.claude/worktrees/<slug>`), instead of the name-plus-uid slug `worktree.rs::slug` makes for UI sessions. The caller picks the slug so it knows the folder and branch. Rust validates it: lowercase ASCII alnum and single hyphens, 1 to 60 chars, else 400. Ignored, with a stderr note, when `<path>` is not a git work tree.
- `--name <text>`: the session's name. Trimmed, capped at 80 chars.
- `--prompt-file <file>`: the file's contents become the agent's first prompt. Read by the Rust handler, not passed through the shell: the shim sends the absolute path; Rust requires a regular file, caps it at 64 KB (rejects larger with 400), and reads it as UTF-8.
- `--worktree`, `--name` and `--prompt-file` all require `--agent` (they describe a new session); without it the shim exits 2 with usage.

Wire: `OpenRequest` gains `worktree: Option<String>` (the slug), `name: Option<String>`, `prompt_file: Option<String>`. After reading, the payload emitted to the frontend carries `prompt: Option<String>` instead of the path. `applyCliOpenPayload` passes `name`, `useWorktree: true` and the explicit slug to `addSession` (which gains an optional `worktreeSlug` that overrides its derived one) and registers the prompt as the new session's pending prompt.

Shim marker becomes `conduit-cli-shim-v2` (both `sh` and `cmd` variants gain the flags). `remove` must still recognise v1 so it can replace an old shim. Settings already offers reinstall; it should show "Update" when the installed shim is v1.

## Non-goals

- A URL scheme. The token-authenticated `/open` route is the only entry point, which keeps web pages out.
- A confirmation dialog. Only a local process that can read the owner-only token file can call `/open`; the session runs with the agent's normal permission prompts. (Orbit's call, open to change.)
- Passing prompt text on the command line or in the URL.

## Tests

- `parse_open`: new fields optional; old v1 bodies still parse.
- Prompt file: missing, directory, over 64 KB, non-UTF-8 each reject with 400 and never fire the sink.
- Shim: `--name`/`--worktree`/`--prompt-file` without `--agent` exits 2; JSON escaping of name and path with quotes and backslashes.
- `cli_shim` `remove` accepts v1 and v2 markers and still refuses a file with neither.
- Frontend: a payload with `worktree`, `name`, `prompt` produces a session with those set and the prompt consumed exactly once.
