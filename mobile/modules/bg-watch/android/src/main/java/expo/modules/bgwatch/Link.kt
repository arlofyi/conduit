package expo.modules.bgwatch

import android.os.Handler
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * The watcher's one socket, as the app's own BridgeClient does it (bridge/connection.ts):
 * `hello` -> `auth` -> `authOk`, then `list` so the computer pushes the projects view on every
 * change, and its `pending` / `pendingAdded` / `resolved` pushes. Every callback is moved onto
 * [main], so the state below is single-threaded. Reconnects back off 1 s -> 60 s and walk the
 * address list; a network coming back redials at once.
 *
 * Authenticated as this phone, the socket counts as a phone that can answer: the computer holds
 * questions and permissions for it (bridge.rs `holder_for`) instead of handing them to the
 * terminal. The computer's 15 s pings are answered by OkHttp; 35 s of silence drops us there.
 *
 * The token is sent in the `auth` frame only; it is never logged.
 */
internal class Link(
  private val main: Handler,
  private val cfg: WatchConfig,
  private val onFrame: (JSONObject) -> Unit,
  /** a terminal refusal: "unauthorized" or "protocol" */
  private val onFatal: (String) -> Unit,
) {
  private var ws: WebSocket? = null
  private var gen = 0
  private var index = 0
  private var backoffMs = BACKOFF_START_MS
  private var authed = false
  private var closed = false
  private val redial = Runnable { connect() }

  fun start() = connect()

  fun close() {
    closed = true
    main.removeCallbacks(redial)
    gen += 1
    runCatching { ws?.close(1000, null) }
    ws = null
  }

  /** The network came back (or changed): a link that is not up redials now. */
  fun networkBack() {
    if (closed || authed) return
    main.removeCallbacks(redial)
    backoffMs = BACKOFF_START_MS
    connect()
  }

  private fun connect() {
    if (closed) return
    main.removeCallbacks(redial)
    gen += 1
    val my = gen
    authed = false
    runCatching { ws?.cancel() }
    BgWatchState.updatePhase(if (BgWatchState.phase == "watching" || BgWatchState.phase == "stopped") "connecting" else BgWatchState.phase)
    val url = cfg.addresses[index % cfg.addresses.size]
    val listener = object : WebSocketListener() {
      override fun onMessage(webSocket: WebSocket, text: String) {
        main.post { if (my == gen) message(webSocket, text) }
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        main.post { if (my == gen) dropped() }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        main.post { if (my == gen) dropped() }
      }
    }
    ws = try {
      BgWatchState.http.newWebSocket(Request.Builder().url(url).build(), listener)
    } catch (_: Exception) {
      dropped()
      return
    }
    // A host that never answers (a dead tailnet route) must not hold the list.
    main.postDelayed({ if (my == gen && !authed) dropped() }, HANDSHAKE_MS)
  }

  private fun message(webSocket: WebSocket, text: String) {
    val o = runCatching { JSONObject(text) }.getOrNull() ?: return
    when (o.optString("type")) {
      "hello" -> {
        if (o.optInt("protocolVersion", -1) != PROTOCOL_VERSION) {
          onFatal("protocol")
          return
        }
        webSocket.send(JSONObject().put("type", "auth").put("token", cfg.token).toString())
      }
      "authOk" -> {
        authed = true
        backoffMs = BACKOFF_START_MS
        webSocket.send("""{"type":"list"}""")
        BgWatchState.updatePhase("watching")
      }
      "error" -> when {
        authed -> {}
        o.optString("message") == "unauthorized" -> onFatal("unauthorized")
        // refused before the token was checked (rate limit, access off): retry, same address
        o.optString("message") == "unavailable" -> {
          index -= 1
          dropped()
        }
      }
      else -> if (authed) onFrame(o)
    }
  }

  private fun dropped() {
    if (closed) return
    gen += 1
    runCatching { ws?.cancel() }
    ws = null
    // Never got in on this address: try the next one. A link that was up retries where it was.
    if (!authed) index += 1
    authed = false
    BgWatchState.updatePhase("retrying")
    main.removeCallbacks(redial)
    main.postDelayed(redial, backoffMs)
    backoffMs = (backoffMs * 2).coerceAtMost(BACKOFF_MAX_MS)
  }

  private companion object {
    const val PROTOCOL_VERSION = 1
    const val BACKOFF_START_MS = 1_000L
    const val BACKOFF_MAX_MS = 60_000L
    const val HANDSHAKE_MS = 10_000L
  }
}
