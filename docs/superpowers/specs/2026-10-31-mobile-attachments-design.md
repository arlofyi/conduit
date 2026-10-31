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
2. **The file travels over the existing bridge socket** as one `upload` frame
   (`{type, sessionId, requestId, name, data: base64}`), acked with
   `{type: "uploadResult", requestId, ok, path | error}`. No second channel, no HTTP route:
   the socket is already authenticated, already refuses private sessions
   (`session_scope`), and already bounded.
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

- **10 MiB decoded per file.** The socket's frame limit is tungstenite's 16 MiB; base64 adds
  a third, so 10 MiB is the largest that fits in one frame with headroom. The phone checks
  first and says so, rather than letting the socket drop.
- **Photos are re-encoded on the phone** (longest edge 2048 px, JPEG 0.8): a 12 MP photo
  goes from ~5 MB to ~400 KB, which is the difference between instant and a minute on
  cellular, and the agent gains nothing from the extra pixels.
- **30 uploads per 10 minutes per phone** (`fleet::rate_limited`, same as spawns).
- **Names are never trusted.** The stored name is `<unix secs>-<8 hex>-<sanitized stem>.<ext>`;
  the stem keeps `[A-Za-z0-9._-]` only and is capped, and the path is built by Conduit,
  never joined from the phone's string -- the same rule as the skill editor.
- **Files older than 7 days are pruned** from that folder on each upload.

## Not done

- Pasting an image straight into Claude's TUI as `[Image #1]` (needs the clipboard on the
  desktop, which a phone cannot drive).
- Upload progress for large files (one frame; the chip shows a spinner).
