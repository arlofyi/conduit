//! Holding a hook's HTTP request open while a human decides -- and noticing when the
//! hook's client has gone away, so the wait does not outlive the thing waiting.
//!
//! Claude Code kills a hook's process when the user interrupts the turn (Esc), and fires
//! no `Stop` for it, so the only sign is that the hook's `curl` hangs up. tiny_http gives a
//! handler no socket to peek at, so the probe is a WRITE: an HTTP/1.1 interim response
//! (`102 Processing`). curl reads and discards every 1xx before the final response and
//! prints only the final body (checked against curl 8.7.1: 6000 interim responses in a row,
//! stdout carried just the body, exit 0), so the hook's stdout is unchanged. Once the
//! client is gone, a probe draws a reset and the next one fails -- a dead client is seen
//! within two probes, i.e. about a second at [`PROBE_EVERY`].
//!
//! Used by `/ask`; meant to be reused by any other blocking hook route (the permission
//! request). A route that uses it writes its final response with
//! [`write_json_response`], because the request's writer has already carried probes.

use std::io::Write;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// How often a waiting route checks that its client is still there.
pub const PROBE_EVERY: Duration = Duration::from_millis(500);

/// An interim response: ignored by curl, fatal to write into a closed connection.
const PROBE: &[u8] = b"HTTP/1.1 102 Processing\r\n\r\n";

/// Has the client of this response stream gone away? Writes one interim response and
/// flushes it (tiny_http's writer is buffered); any error means nobody is reading.
pub fn client_gone(out: &mut dyn Write) -> bool {
    out.write_all(PROBE).and_then(|()| out.flush()).is_err()
}

/// How a wait ended.
#[derive(Debug)]
pub enum Waited<T> {
    Got(T),
    /// The ceiling passed, or the sender went away without answering.
    NoAnswer,
    /// The hook's client hung up: nobody will read an answer now.
    ClientGone,
}

/// Wait up to `ceiling` for an answer on `rx`, probing the client every [`PROBE_EVERY`].
pub fn wait_for_answer<T>(rx: &Receiver<T>, out: &mut dyn Write, ceiling: Duration) -> Waited<T> {
    wait_for_answer_every(rx, out, ceiling, PROBE_EVERY)
}

fn wait_for_answer_every<T>(
    rx: &Receiver<T>,
    out: &mut dyn Write,
    ceiling: Duration,
    every: Duration,
) -> Waited<T> {
    let end = Instant::now() + ceiling;
    loop {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Waited::NoAnswer;
        }
        match rx.recv_timeout(every.min(left)) {
            Ok(v) => return Waited::Got(v),
            Err(RecvTimeoutError::Disconnected) => return Waited::NoAnswer,
            Err(RecvTimeoutError::Timeout) => {
                if client_gone(out) {
                    return Waited::ClientGone;
                }
            }
        }
    }
}

/// The final `200` with a JSON body, written by hand onto a writer that may already have
/// carried probes. `Connection: close`, so curl does not wait on a kept-alive socket.
pub fn write_json_response(out: &mut dyn Write, body: &str) -> std::io::Result<()> {
    write!(
        out,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;

    /// (client, the server's side of the same connection).
    fn pair() -> (TcpStream, TcpStream) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let c = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (s, _) = l.accept().unwrap();
        (c, s)
    }

    #[test]
    fn a_closed_client_is_seen_and_an_idle_one_is_not() {
        let (idle, mut alive) = pair();
        for _ in 0..5 {
            assert!(!client_gone(&mut alive), "an idle client is still waiting");
        }
        drop(idle);

        let (closed, mut dead) = pair();
        drop(closed);
        // The first write after the close may still be accepted (it draws the RST).
        let gone = (0..20).any(|_| {
            let g = client_gone(&mut dead);
            if !g {
                std::thread::sleep(Duration::from_millis(25));
            }
            g
        });
        assert!(gone, "a closed client must be reported");
    }

    #[test]
    fn waiting_ends_on_an_answer_with_only_interim_responses_before_it() {
        let (mut c, mut s) = pair();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            tx.send(7).unwrap();
        });
        let every = Duration::from_millis(20);
        assert!(matches!(
            wait_for_answer_every(&rx, &mut s, Duration::from_secs(5), every),
            Waited::Got(7)
        ));
        write_json_response(&mut s, "{\"ok\":true}").unwrap();
        drop(s);
        let mut got = String::new();
        c.read_to_string(&mut got).unwrap();
        let (interim, last) = got.rsplit_once("HTTP/1.1 200 OK\r\n").unwrap();
        assert!(!interim.is_empty(), "probes went out while waiting");
        assert!(interim
            .split("\r\n\r\n")
            .filter(|p| !p.is_empty())
            .all(|p| p == "HTTP/1.1 102 Processing"));
        assert!(last.contains("Content-Length: 11\r\n"));
        assert!(last.ends_with("\r\n\r\n{\"ok\":true}"));
    }

    #[test]
    fn waiting_ends_when_the_client_goes_away() {
        let (c, mut s) = pair();
        let (_tx, rx) = mpsc::channel::<u8>();
        drop(c);
        let t = Instant::now();
        let every = Duration::from_millis(20);
        assert!(matches!(
            wait_for_answer_every(&rx, &mut s, Duration::from_secs(5), every),
            Waited::ClientGone
        ));
        assert!(t.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn waiting_gives_up_at_the_ceiling() {
        let (_c, mut s) = pair();
        let (_tx, rx) = mpsc::channel::<u8>();
        let every = Duration::from_millis(20);
        assert!(matches!(
            wait_for_answer_every(&rx, &mut s, Duration::from_millis(100), every),
            Waited::NoAnswer
        ));
    }

    /// The real path: tiny_http's own response writer (buffered) must surface the dead
    /// client too, not swallow the error in its buffer.
    #[test]
    fn tiny_http_writer_reports_a_vanished_client() {
        use std::io::Write as _;
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let mut c = TcpStream::connect(addr).unwrap();
        c.write_all(b"POST /ask HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap();
        let mut req = server.recv().unwrap();
        let mut body = String::new();
        req.as_reader().read_to_string(&mut body).unwrap();
        let mut out = req.into_writer();
        assert!(!client_gone(&mut *out));
        drop(c);
        let (_tx, rx) = mpsc::channel::<u8>();
        assert!(matches!(
            wait_for_answer_every(
                &rx,
                &mut *out,
                Duration::from_secs(5),
                Duration::from_millis(20)
            ),
            Waited::ClientGone
        ));
    }
}
