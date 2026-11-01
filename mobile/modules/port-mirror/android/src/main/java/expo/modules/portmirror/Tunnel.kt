package expo.modules.portmirror

import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import expo.modules.bgwatch.NativeLog
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

/**
 * One local TCP connection (the browser's) carried over one bridge WebSocket.
 *
 * Handshake: the bridge says `hello`, we send `{type:"tunnel", token, port}`, it answers
 * `tunnelOk` and from then on binary frames both ways are the raw TCP bytes. Nothing is read
 * from the local socket before `tunnelOk`; the kernel buffers the browser's request meanwhile.
 *
 * Backpressure: computer -> browser bytes are written on OkHttp's reader thread, so a slow
 * browser slows the socket down; browser -> computer bytes wait while OkHttp's send queue is
 * over [MAX_QUEUE] (OkHttp closes a socket whose queue passes 16 MiB).
 *
 * Neither the token nor any payload byte is ever logged.
 */
internal class Tunnel(
  private val socket: Socket,
  private val remote: Int,
  private val cfg: MirrorConfig,
  private val onEnd: (Tunnel) -> Unit,
  private val onUnauthorized: () -> Unit,
) : WebSocketListener() {
  private val closed = AtomicBoolean(false)
  private val decided = CountDownLatch(1)
  @Volatile private var accepted = false
  @Volatile private var ws: WebSocket? = null

  fun start() {
    ws = MirrorState.http.newWebSocket(Request.Builder().url(cfg.url).build(), this)
    thread(name = "port-mirror-$remote", isDaemon = true) {
      try {
        pump()
      } catch (t: Throwable) {
        // thread root: pump() handles I/O itself, so this is a bug -- log it, end this tunnel only
        NativeLog.error("mirror", "tunnel.crashed", t, "port $remote")
        close()
      }
    }
  }

  private fun pump() {
    try {
      if (!decided.await(OK_TIMEOUT_S, TimeUnit.SECONDS) || !accepted) return
      val input = socket.getInputStream()
      val buf = ByteArray(CHUNK)
      while (!closed.get()) {
        val n = input.read(buf)
        if (n < 0) break
        if (n == 0) continue
        val w = ws ?: break
        while (w.queueSize() > MAX_QUEUE && !closed.get()) Thread.sleep(5)
        if (!w.send(buf.toByteString(0, n))) break
      }
    } catch (_: Exception) {
      // the browser or the link went away; close() below ends both sides
    } finally {
      close()
    }
  }

  override fun onOpen(webSocket: WebSocket, response: Response) {
    val frame = JSONObject().put("type", "tunnel").put("token", cfg.token).put("port", remote)
    webSocket.send(frame.toString())
  }

  override fun onMessage(webSocket: WebSocket, text: String) {
    val o = runCatching { JSONObject(text) }.getOrNull() ?: return
    when (o.optString("type")) {
      "tunnelOk" -> {
        accepted = true
        decided.countDown()
      }
      "error" -> {
        if (o.optString("message") == "unauthorized") onUnauthorized()
        close()
      }
      // "hello" and anything newer: nothing to do
    }
  }

  override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
    if (!accepted || closed.get()) return
    try {
      socket.getOutputStream().write(bytes.toByteArray())
    } catch (_: Exception) {
      close()
    }
  }

  override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = close()

  override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = close()

  override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
    // Before tunnelOk this is the bridge being unreachable; afterwards it is an ordinary end.
    if (!accepted && !closed.get()) NativeLog.warn("mirror", "tunnel.failed", t, "port $remote")
    close()
  }

  fun close() {
    if (!closed.compareAndSet(false, true)) return
    decided.countDown()
    // A normal close is queued AFTER any bytes still waiting to go, so a response the browser
    // finished sending is not cut short.
    runCatching { ws?.close(1000, null) }
    runCatching { socket.close() }
    onEnd(this)
  }

  private companion object {
    const val CHUNK = 64 * 1024
    const val MAX_QUEUE = 1L shl 20
    const val OK_TIMEOUT_S = 15L
  }
}
