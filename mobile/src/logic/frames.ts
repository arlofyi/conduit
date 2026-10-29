/**
 * Which bridge frames belong to the chat that is open, and which `error` answers belong to a
 * spawn. The socket streams one session at a time, but a frame can still be in flight from the
 * chat the reader just left; the Mac tags `chat`/`history`/`status` with `sessionId` so the
 * phone can drop those. Older desktops send no tag, and their frames are accepted as before.
 */

/** The Mac's refusal for a silo'd or local-only session (bridge_view.rs `private_session_error`). */
export const PRIVATE_SESSION = "private session";

/** What the chat shows when the Mac refuses a private session. */
export const PRIVATE_SESSION_TEXT = "Private session — open it on your Mac";

/** Should a session-scoped frame reach the open chat? Untagged frames (older Macs) always do. */
export function acceptsFrame(frameSessionId: unknown, open: string | null): boolean {
  if (frameSessionId === undefined || frameSessionId === null) return true;
  return frameSessionId === open;
}

/** Is this `error` the Mac refusing the chat that is open? A refusal tagged with another
 * session is a late answer about a chat the reader already left; untagged (older Macs)
 * still counts, as before. */
export function refusesOpenChat(message: string, frameSessionId: unknown, open: string | null): boolean {
  return message === PRIVATE_SESSION && open !== null && acceptsFrame(frameSessionId, open);
}

/** The session a frame is about: its own tag when present, else whatever this socket streams. */
export function frameSession(frameSessionId: unknown, streaming: string | null): string | null {
  return typeof frameSessionId === "string" ? frameSessionId : streaming;
}

/** Every `error` message `spawn_reply` (src-tauri/src/bridge.rs) can answer a spawn with. */
export const SPAWN_ERRORS: readonly string[] = [
  "unknown agent",
  "unknown project",
  "worktree requested but project is not a git repo",
  "could not create session",
  "too many new chats — try again later",
];

/** Is this `error` the answer to a pending spawn? Any other error (a refused attach, a
 * private session) is about something else and must not fail the new-chat sheet. */
export function isSpawnError(message: string): boolean {
  return SPAWN_ERRORS.includes(message);
}

/** The sheet's sentence for a spawn error. */
export function spawnErrorText(message: string): string {
  switch (message) {
    case "unknown agent":
      return "Your Mac doesn't know that agent.";
    case "unknown project":
      return "That project is no longer on your Mac.";
    case "too many new chats — try again later":
      return "Too many new chats from this phone — try again later.";
    default:
      return "Your Mac couldn't start the chat.";
  }
}
