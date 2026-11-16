//! Who may type into a terminal, and when.
//!
//! A session's PTY has one input stream and several writers: the person at the keyboard
//! (or their phone), and machines -- `fleet_send`, the Conductor's worker news. A machine
//! write pastes text and presses Enter. If the person is mid-sentence in that terminal,
//! the two are merged into one message and submitted together.
//!
//! `Gate` watches the bytes a person types and answers one question for a machine writer:
//! how much longer must you hold? It is pure -- it takes the clock as an argument -- so
//! every rule here is tested without a PTY.
//!
//! The limits are the ones Herdr's core uses (its `input.rs`); the implementation is ours.

use std::time::{Duration, Instant};

/// Gap between a person's submit and a machine paste, so the program sees them apart.
pub const PASTE_GAP: Duration = Duration::from_millis(200);
/// How long a person must have stopped pressing keys before a machine write goes in.
const QUIET_MS: u64 = 3_000;
/// How long a machine write waits on an unfinished draft, counted from the last key.
const DRAFT_MS: u64 = 60_000;

fn env_ms(var: &str, default: u64) -> Duration {
    Duration::from_millis(
        std::env::var(var)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default),
    )
}

/// The quiet period (`CONDUIT_INPUT_QUIET_MS` overrides it, for tests).
pub fn quiet() -> Duration {
    env_ms("CONDUIT_INPUT_QUIET_MS", QUIET_MS)
}

/// The draft limit (`CONDUIT_INPUT_DRAFT_MS` overrides it, for tests).
pub fn draft_limit() -> Duration {
    env_ms("CONDUIT_INPUT_DRAFT_MS", DRAFT_MS)
}

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
/// A sequence longer than this is not one a keyboard sends; give up on it.
const MAX_SEQUENCE: usize = 256;

/// What one person has typed into one terminal, as far as it matters to a machine writer.
#[derive(Default, Debug)]
pub struct Gate {
    /// When the person last pressed a key. Terminal replies do not move it.
    last_human: Option<Instant>,
    /// Characters sitting unsent in the composer.
    draft: usize,
    /// The last key submitted or cleared the draft.
    draft_ended: bool,
    /// Inside a bracketed paste.
    pasting: bool,
    /// An escape sequence still arriving.
    sequence: Vec<u8>,
}

impl Gate {
    /// Characters the person has typed and not yet sent.
    #[cfg(test)]
    pub fn draft(&self) -> usize {
        self.draft
    }

    /// Bytes on the person's input path (`pty_write`, a phone's `input`).
    ///
    /// That path also carries the terminal's own answers -- cursor reports, focus events,
    /// mouse reports -- which the frontend sends through the same command. Those are parsed
    /// and ignored: a pane gaining focus must not look like typing.
    pub fn human(&mut self, bytes: &[u8], now: Instant) {
        // A lone ESC left over from the previous write was the Esc key, not the start of a
        // sequence: a keyboard sequence arrives in one write.
        if self.sequence == [0x1b] {
            self.sequence.clear();
            self.touch(now);
        }
        for &b in bytes {
            if self.byte(b) {
                self.touch(now);
            }
        }
    }

    fn touch(&mut self, now: Instant) {
        self.last_human = Some(now);
    }

    /// Feeds one byte; true when it was the person doing something.
    fn byte(&mut self, b: u8) -> bool {
        if self.pasting {
            return self.paste_byte(b);
        }
        if !self.sequence.is_empty() {
            self.sequence.push(b);
            return self.sequence_step();
        }
        match b {
            0x1b => {
                self.sequence.push(b);
                false
            }
            // Enter, Ctrl-C, Ctrl-U: the draft was sent or thrown away.
            b'\r' | 0x03 | 0x15 => {
                self.end_draft();
                true
            }
            0x08 | 0x7f => {
                self.draft = self.draft.saturating_sub(1);
                self.draft_ended = false;
                true
            }
            // Other control keys (Tab, Ctrl-J for a newline) are typing but add no character
            // we can count.
            0x00..=0x1f => {
                self.draft_ended = false;
                true
            }
            // ASCII, or the first byte of a UTF-8 character.
            _ if b < 0x80 || b & 0xc0 != 0x80 => {
                self.add(1);
                true
            }
            // A UTF-8 continuation byte: part of a character already counted.
            _ => false,
        }
    }

    fn add(&mut self, n: usize) {
        self.draft = self.draft.saturating_add(n);
        self.draft_ended = false;
    }

    fn end_draft(&mut self) {
        self.draft = 0;
        self.draft_ended = true;
    }

    /// Inside a bracketed paste every character is draft text; only the end marker is not.
    fn paste_byte(&mut self, b: u8) -> bool {
        if b == 0x1b || !self.sequence.is_empty() {
            self.sequence.push(b);
            if self.sequence == PASTE_END {
                self.pasting = false;
                self.sequence.clear();
            } else if !PASTE_END.starts_with(&self.sequence) {
                // Not the end marker after all. `paste_and_submit` strips ESC from what it
                // pastes, so this is rare; count what we swallowed and carry on.
                let restart = b == 0x1b;
                let swallowed = self.sequence.iter().filter(|c| **c & 0xc0 != 0x80).count()
                    - usize::from(restart);
                self.add(swallowed);
                self.sequence.clear();
                if restart {
                    self.sequence.push(b);
                }
            }
        } else if b & 0xc0 != 0x80 {
            self.add(1);
        }
        true
    }

    /// One more byte of an escape sequence is in `self.sequence`. True when the sequence
    /// just completed and was a key the person pressed.
    fn sequence_step(&mut self) -> bool {
        let seq = &self.sequence;
        let last = *seq.last().unwrap_or(&0);
        let complete = match seq.as_slice() {
            [0x1b] => false,
            // Esc Esc: the first was the Esc key; the second starts over.
            [0x1b, 0x1b] => {
                self.sequence.truncate(1);
                self.draft_ended = false;
                return true;
            }
            [0x1b, b'[' | b'O'] => false,
            // X10 mouse: three coordinate bytes follow.
            [0x1b, b'[', b'M', ..] => seq.len() >= 6,
            [0x1b, b'[', ..] => (0x40..=0x7e).contains(&last),
            // SS3: one final byte (application-mode arrows, F1-F4).
            [0x1b, b'O', _] => true,
            // OSC, DCS, APC, PM: a string up to BEL or ST. The terminal's own answers.
            [0x1b, b']' | b'P' | b'_' | b'^', ..] => last == 0x07 || seq.ends_with(b"\x1b\\"),
            // Alt+key.
            _ => true,
        };
        if !complete {
            if self.sequence.len() >= MAX_SEQUENCE {
                self.sequence.clear();
            }
            return false;
        }
        let seq = std::mem::take(&mut self.sequence);
        self.finish_sequence(&seq)
    }

    fn finish_sequence(&mut self, seq: &[u8]) -> bool {
        if seq == PASTE_START {
            self.pasting = true;
            self.draft_ended = false;
            return true;
        }
        match seq {
            // String sequences are replies from the terminal, never keys.
            [0x1b, b']' | b'P' | b'_' | b'^', ..] => false,
            [0x1b, b'[', b'M', ..] => false,
            [0x1b, b'[', body @ .., last] => match last {
                // Cursor position, device attributes, focus in/out, SGR mouse, window
                // reports, mode reports, status reports: the terminal answering.
                b'R' | b'c' | b'I' | b'O' | b'M' | b'm' | b't' | b'y' | b'n' => false,
                // Kitty keyboard protocol: `CSI code ; modifiers u`.
                b'u' => {
                    self.csi_u(body);
                    true
                }
                _ => {
                    self.draft_ended = false;
                    true
                }
            },
            _ => {
                self.draft_ended = false;
                true
            }
        }
    }

    /// `code[:alt…] ; modifiers[:event]` -- the key the person pressed, spelled out.
    fn csi_u(&mut self, body: &[u8]) {
        let Ok(body) = std::str::from_utf8(body) else {
            return;
        };
        let mut params = body.split(';');
        let code = params
            .next()
            .and_then(|p| p.split(':').next())
            .and_then(|p| p.parse::<u32>().ok());
        let mut mods = params.next().unwrap_or("").split(':');
        let modifiers = mods
            .next()
            .filter(|s| !s.is_empty())
            .map_or(Some(1), |s| s.parse::<u32>().ok());
        // A key release types nothing.
        if mods.next() == Some("3") {
            return;
        }
        let (Some(code), Some(modifiers)) = (code, modifiers) else {
            return;
        };
        // Modifiers are 1 + a bitmask: 1 shift, 2 alt, 4 ctrl.
        let bits = modifiers.saturating_sub(1);
        let ctrl = bits & 4 != 0;
        let plain = bits & !1 == 0; // nothing but shift
        match code {
            13 if bits == 0 => self.end_draft(),
            // Ctrl-C, Ctrl-U.
            99 | 117 if ctrl => self.end_draft(),
            8 | 127 if plain => {
                self.draft = self.draft.saturating_sub(1);
                self.draft_ended = false;
            }
            // A printable character; the private-use block is function keys.
            32..=0x10ffff
                if plain
                    && char::from_u32(code).is_some_and(|c| !c.is_control())
                    && !(57344..=63743).contains(&code) =>
            {
                self.add(1)
            }
            _ => self.draft_ended = false,
        }
    }

    /// How much longer a machine write must hold before it may go in.
    pub fn wait(&self, now: Instant, quiet: Duration, draft_limit: Duration) -> Duration {
        let Some(at) = self.last_human else {
            return Duration::ZERO;
        };
        let since = now.saturating_duration_since(at);
        if self.draft_ended {
            return PASTE_GAP.saturating_sub(since);
        }
        let hold = if self.draft > 0 {
            quiet.max(draft_limit)
        } else {
            quiet
        };
        hold.saturating_sub(since)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const Q: Duration = Duration::from_secs(3);
    const D: Duration = Duration::from_secs(60);

    fn typed(bytes: &[u8]) -> (Gate, Instant) {
        let now = Instant::now();
        let mut g = Gate::default();
        g.human(bytes, now);
        (g, now)
    }

    #[test]
    fn nothing_typed_means_no_wait() {
        let g = Gate::default();
        assert_eq!(g.wait(Instant::now(), Q, D), Duration::ZERO);
    }

    #[test]
    fn plain_text_is_a_draft_and_holds_for_the_draft_limit() {
        let (g, now) = typed(b"fix the");
        assert_eq!(g.draft(), 7);
        assert_eq!(g.wait(now, Q, D), D);
        assert_eq!(
            g.wait(now + Duration::from_secs(59), Q, D),
            Duration::from_secs(1)
        );
        assert_eq!(g.wait(now + Duration::from_secs(61), Q, D), Duration::ZERO);
    }

    #[test]
    fn enter_ends_the_draft_and_leaves_only_the_paste_gap() {
        let (g, now) = typed(b"ship it\r");
        assert_eq!(g.draft(), 0);
        assert_eq!(g.wait(now, Q, D), PASTE_GAP);
        assert_eq!(g.wait(now + PASTE_GAP, Q, D), Duration::ZERO);
    }

    #[test]
    fn ctrl_c_and_ctrl_u_clear_the_draft() {
        for key in [0x03u8, 0x15] {
            let (g, now) = typed(&[b'a', b'b', key]);
            assert_eq!(g.draft(), 0, "key {key:#x}");
            assert_eq!(g.wait(now, Q, D), PASTE_GAP);
        }
    }

    #[test]
    fn backspace_removes_one_and_an_emptied_draft_waits_only_for_quiet() {
        let (g, now) = typed(b"ab\x7f\x7f");
        assert_eq!(g.draft(), 0);
        assert_eq!(g.wait(now, Q, D), Q);
        // Backspace at an empty composer does not underflow.
        let (g, _) = typed(b"\x7f\x7f");
        assert_eq!(g.draft(), 0);
    }

    #[test]
    fn a_utf8_character_counts_once() {
        let (g, _) = typed("héllo ✓".as_bytes());
        assert_eq!(g.draft(), 7);
    }

    #[test]
    fn a_bracketed_paste_is_draft_text() {
        let (g, now) = typed(b"\x1b[200~line one\nline two\x1b[201~");
        assert_eq!(g.draft(), 17);
        assert_eq!(g.wait(now, Q, D), D);
        // ...and Enter after it sends it.
        let (g, _) = typed(b"\x1b[200~hello\x1b[201~\r");
        assert_eq!(g.draft(), 0);
    }

    #[test]
    fn an_escape_inside_a_paste_that_is_not_the_end_marker_is_counted() {
        let (g, _) = typed(b"\x1b[200~a\x1b[2b\x1b[201~");
        // a, ESC, [, 2, b
        assert_eq!(g.draft(), 5);
    }

    #[test]
    fn arrow_keys_are_typing_but_add_no_draft() {
        let (g, now) = typed(b"\x1b[A\x1b[B\x1bOC");
        assert_eq!(g.draft(), 0);
        assert_eq!(g.wait(now, Q, D), Q);
    }

    #[test]
    fn terminal_replies_are_not_typing() {
        // Cursor position, device attributes, focus in, focus out, SGR mouse press and
        // release, X10 mouse, a mode report, an OSC colour answer, a DCS answer.
        let replies: &[&[u8]] = &[
            b"\x1b[12;40R",
            b"\x1b[?62;4c",
            b"\x1b[I",
            b"\x1b[O",
            b"\x1b[<0;10;5M",
            b"\x1b[<0;10;5m",
            b"\x1b[M !!",
            b"\x1b[?2026;2$y",
            b"\x1b]11;rgb:0000/0000/0000\x07",
            b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            b"\x1bP1$r0m\x1b\\",
        ];
        for reply in replies {
            let (g, now) = typed(reply);
            assert_eq!(
                g.wait(now, Q, D),
                Duration::ZERO,
                "{:?} was read as typing",
                String::from_utf8_lossy(reply)
            );
            assert_eq!(g.draft(), 0);
        }
    }

    #[test]
    fn a_reply_does_not_reset_the_clock_of_real_typing() {
        let now = Instant::now();
        let mut g = Gate::default();
        g.human(b"hi", now);
        g.human(b"\x1b[I", now + Duration::from_secs(30));
        assert_eq!(
            g.wait(now + Duration::from_secs(30), Q, D),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn the_esc_key_alone_is_typing() {
        let now = Instant::now();
        let mut g = Gate::default();
        g.human(b"\x1b", now);
        // Nothing can be said until the next write shows it was not a sequence.
        g.human(b"a", now + Duration::from_millis(500));
        assert_eq!(g.draft(), 1);
    }

    #[test]
    fn csi_u_keys_are_understood() {
        // Enter
        let (g, now) = typed(b"ab\x1b[13u");
        assert_eq!(g.draft(), 0);
        assert_eq!(g.wait(now, Q, D), PASTE_GAP);
        // Shift+Enter is a newline in the draft, not a submit.
        let (g, now) = typed(b"ab\x1b[13;2u");
        assert_eq!(g.draft(), 2);
        assert_eq!(g.wait(now, Q, D), D);
        // Ctrl-C
        let (g, _) = typed(b"ab\x1b[99;5u");
        assert_eq!(g.draft(), 0);
        // A printable key, then its release (which types nothing).
        let (g, _) = typed(b"\x1b[97u\x1b[97;1:3u");
        assert_eq!(g.draft(), 1);
        // Backspace
        let (g, _) = typed(b"ab\x1b[127u");
        assert_eq!(g.draft(), 1);
    }

    #[test]
    fn typing_after_a_submit_is_a_new_draft() {
        let (g, now) = typed(b"one\rtwo");
        assert_eq!(g.draft(), 3);
        assert_eq!(g.wait(now, Q, D), D);
    }

    #[test]
    fn a_runaway_sequence_is_dropped_not_kept_forever() {
        let mut bytes = b"\x1b]".to_vec();
        bytes.extend(std::iter::repeat_n(b'x', 1000));
        let (mut g, now) = typed(&bytes);
        g.human(b"ok", now);
        // Whatever was swallowed, the gate is counting characters again.
        assert!(g.draft() >= 2);
    }
}
