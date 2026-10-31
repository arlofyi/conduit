# Mobile attachments (photos, camera, files)

Date: 2026-10-31. Status: implemented on `feat/android-mobile`.

## Problem

The phone can only type. A user away from the desk cannot hand an agent a screenshot of a
bug, a photo of a whiteboard or a PDF -- the things that are most often ON the phone. The
composer's "+" opened stop/compact/clear (steering), which is where every chat app puts
"attach", so the button promised one thing and did another.

## Decision

1. **"+" attaches; steering moves to its own button** (a "tune" circle in the chat header,
   beside Stop while a turn runs).
2. **The file travels over the existing bridge socket** as numbered `upload` chunks
   (`{type, sessionId, requestId, name, data: base64, seq, done}`, at most 512 KiB of base64
   each), each acked with `uploadProgress` before the next is sent, the last with
   `{type: "uploadResult", requestId, ok, path | error}`; files go one at a time. One frame
   per file failed review: the desktop drops a remote phone it has not heard from in 35 s and
   a frame only counts once it has fully arrived, and Android's WebSocket closes once 16 MiB
   is queued. No second channel, no HTTP route: the socket is already authenticated, already
   refuses private sessions (`session_scope`), and already bounded.
3. **The desktop writes it into the session's own directory**, under
   `.conduit-uploads/`, which carries its own `.gitignore` (`*`) so it never shows up in
   `git status` and is never committed. Inside the session directory the agent can read it
   with no permission prompt (outside it, Claude's Read asks every time).
4. **The message references it as `@.conduit-uploads/<file>`.** Measured against Claude Code
   2.1.316: `claude -p "What colour is the image @.conduit-uploads/sq.png"` answered "Red"
   with no prompt. Other agents read the same relative path as text and open it themselves.
   References go FIRST in the message and are followed by a space, so Claude's `@`
   autocomplete is closed again before the Enter that submits.

## Bounds

- **10 MiB decoded per file**, checked on the phone before the file is even read, and on the
  desktop before each chunk is decoded.
- **Photos are re-encoded on the phone** (longest edge 2048 px, JPEG 0.8): a 12 MP photo
  goes from ~5 MB to ~400 KB, which is the difference between instant and a minute on
  cellular, and the agent gains nothing from the extra pixels.
- **30 uploads per 10 minutes per phone** (`fleet::rate_limited`, same as spawns).
- **Names are never trusted.** The stored name is `<unix secs>-<8 hex>-<sanitized stem>.<ext>`;
  the stem keeps `[A-Za-z0-9._-]` only and is capped, and the path is built by Conduit,
  never joined from the phone's string -- the same rule as the skill editor.
- **Files older than 7 days are pruned** from that folder on each upload -- only names
  Conduit wrote (`<secs>-<8 hex>-…`), never anything else a repo keeps there.
- **The folder is never trusted.** A repo can commit `.conduit-uploads` as a symlink or a
  Windows junction; it must be a real directory, created with `create_dir` (last component
  only) inside a session directory that already exists, so an upload can neither write
  through a link nor conjure a worktree that is not there yet.

## Not done

- Pasting an image straight into Claude's TUI as `[Image #1]` (needs the clipboard on the
  desktop, which a phone cannot drive).
- A progress bar for large files (chunks are acked, so it is possible; the chip shows a
  spinner for now).
