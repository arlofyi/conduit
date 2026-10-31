//! One mirrored TCP connection: a phone's WebSocket on one side, a local web app's socket on
//! the other, raw bytes in binary frames both ways (port mirroring).
//!
//! The bridge authenticates the socket and validates the port BEFORE handing it here (see
//! `bridge.rs`'s `tunnel` handling and `local_ports.rs`); this module only moves bytes and
//! decides when the pipe is dead. Tunnelled bytes are never logged.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use tungstenite::{Message, WebSocket};

/// Read size from the local app; also the largest binary frame a tunnel sends.
const CHUNK: usize = 64 * 1024;
/// Chunks buffered between the app reader and the socket. A full queue blocks the reader,
/// which stops reading the app: backpressure all the way down, never an unbounded buffer.
const QUEUE: usize = 32;
/// Frames sent per loop pass, so a fast download cannot starve the read side.
const SEND_PER_PASS: usize = 32;
/// How long one WebSocket read waits. Short, because the same thread also drains the app
/// side; idle tunnels (browser keep-alives) cost one wake per poll.
const WS_POLL: Duration = Duration::from_millis(10);

/// The relay's timing, injected so tests need not wait the production minutes.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// a write to either side that stalls this long ends the tunnel
    pub write_stall: Duration,
    pub ping_every: Duration,
    /// nothing at all read from the phone for this long = the phone is gone
    pub stale_after: Duration,
}

/// Why a relay ended, for tests and the caller's bookkeeping. Never carries data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    /// the local app closed its side (or its read failed)
    App,
    /// the phone closed, or the socket failed
    Phone,
    /// `stop` was set (revoke, access off, mirroring off)
    Stopped,
    /// the phone went silent past `stale_after`
    Stale,
}

/// Relay until either side ends or `stop` is set. Both sockets are shut down on return.
pub fn relay(
    mut ws: WebSocket<TcpStream>,
    app: TcpStream,
    stop: &AtomicBool,
    timing: Timing,
) -> End {
    let end = pump(&mut ws, &app, stop, timing);
    let _ = app.shutdown(std::net::Shutdown::Both);
    let _ = ws.close(None);
    let _ = ws.flush();
    end
}

fn pump(ws: &mut WebSocket<TcpStream>, app: &TcpStream, stop: &AtomicBool, t: Timing) -> End {
    let _ = app.set_nodelay(true);
    if app.set_write_timeout(Some(t.write_stall)).is_err()
        || ws.get_ref().set_read_timeout(Some(WS_POLL)).is_err()
        || ws.get_ref().set_write_timeout(Some(t.write_stall)).is_err()
    {
        return End::Phone;
    }
    let Ok(mut reader) = app.try_clone() else {
        return End::App;
    };
    let mut writer = app;
    // None = the app closed (or its read failed).
    let (tx, rx) = sync_channel::<Option<Vec<u8>>>(QUEUE);
    thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
                Ok(n) => {
                    if tx.send(Some(buf[..n].to_vec())).is_err() {
                        return; // relay gone; the shutdown will end our read too
                    }
                }
            }
        }
    });

    let mut last_heard = Instant::now();
    let mut last_ping = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            return End::Stopped;
        }
        match ws.read() {
            Ok(Message::Binary(bytes)) => {
                last_heard = Instant::now();
                if writer.write_all(&bytes).is_err() {
                    return End::App;
                }
            }
            Ok(Message::Close(_)) => return End::Phone,
            // Text has no meaning once the pipe is open; ping/pong just prove life.
            Ok(_) => last_heard = Instant::now(),
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return End::Phone,
        }

        for _ in 0..SEND_PER_PASS {
            match rx.try_recv() {
                Ok(Some(chunk)) => {
                    // Any failed send ends the tunnel: a half-written frame must never be
                    // retried into the stream (the bridge's `send_failure_is_fatal` rule).
                    if ws.send(Message::Binary(chunk)).is_err() {
                        return End::Phone;
                    }
                }
                Ok(None) | Err(TryRecvError::Disconnected) => return End::App,
                Err(TryRecvError::Empty) => break,
            }
        }

        let now = Instant::now();
        if now.duration_since(last_heard) >= t.stale_after {
            return End::Stale;
        }
        if now.duration_since(last_ping) >= t.ping_every {
            last_ping = now;
            if ws.send(Message::Ping(Vec::new())).is_err() {
                return End::Phone;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Arc;
    use tungstenite::{accept, client, Message};

    const T: Timing = Timing {
        write_stall: Duration::from_secs(5),
        ping_every: Duration::from_millis(100),
        stale_after: Duration::from_secs(5),
    };

    /// A local "web app": echoes each read back upper-cased, then closes after `bye`.
    fn echo_app() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 1024];
            loop {
                let n = match s.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                let up = buf[..n].to_ascii_uppercase();
                s.write_all(&up).unwrap();
                if up.ends_with(b"BYE") {
                    return; // closes
                }
            }
        });
        port
    }

    /// (phone-side client socket, relay thread result) for a tunnel to `app_port`.
    fn tunnel(
        app_port: u16,
        stop: Arc<AtomicBool>,
        timing: Timing,
    ) -> (WebSocket<TcpStream>, thread::JoinHandle<End>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let ws = accept(s).unwrap();
            let app = TcpStream::connect(("127.0.0.1", app_port)).unwrap();
            relay(ws, app, &stop, timing)
        });
        let s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let (ws, _) = client(format!("ws://{addr}/"), s).unwrap();
        (ws, server)
    }

    fn read_binary(ws: &mut WebSocket<TcpStream>) -> Option<Vec<u8>> {
        loop {
            match ws.read() {
                Ok(Message::Binary(b)) => return Some(b),
                Ok(Message::Close(_)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
    }

    #[test]
    fn bytes_flow_both_ways_and_an_app_close_ends_the_tunnel() {
        let (mut ws, server) = tunnel(echo_app(), Arc::new(AtomicBool::new(false)), T);
        ws.send(Message::Binary(b"get /".to_vec())).unwrap();
        assert_eq!(read_binary(&mut ws).as_deref(), Some(&b"GET /"[..]));
        ws.send(Message::Binary(b"bye".to_vec())).unwrap();
        assert_eq!(read_binary(&mut ws).as_deref(), Some(&b"BYE"[..]));
        assert_eq!(
            read_binary(&mut ws),
            None,
            "the app closed, so the phone is closed"
        );
        assert_eq!(server.join().unwrap(), End::App);
    }

    #[test]
    fn a_phone_close_ends_the_tunnel() {
        let (mut ws, server) = tunnel(echo_app(), Arc::new(AtomicBool::new(false)), T);
        ws.close(None).unwrap();
        let _ = ws.flush();
        assert_eq!(server.join().unwrap(), End::Phone);
    }

    #[test]
    fn stop_ends_the_tunnel_at_once() {
        let stop = Arc::new(AtomicBool::new(false));
        let (_ws, server) = tunnel(echo_app(), stop.clone(), T);
        thread::sleep(Duration::from_millis(50));
        stop.store(true, Ordering::SeqCst);
        assert_eq!(server.join().unwrap(), End::Stopped);
    }

    #[test]
    fn a_silent_phone_is_dropped_as_stale() {
        let quick = Timing {
            stale_after: Duration::from_millis(150),
            ping_every: Duration::from_secs(60),
            ..T
        };
        // The client never reads, so it never answers a ping: nothing is heard.
        let (_ws, server) = tunnel(echo_app(), Arc::new(AtomicBool::new(false)), quick);
        assert_eq!(server.join().unwrap(), End::Stale);
    }
}
