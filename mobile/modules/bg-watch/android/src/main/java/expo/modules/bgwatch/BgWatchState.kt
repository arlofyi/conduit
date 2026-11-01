package expo.modules.bgwatch

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

/** What the watcher connects with and announces. The token lives here in memory only: never
 * written to disk, logged, or put in an Intent. */
data class WatchConfig(
  val addresses: List<String>,
  val token: String,
  val computer: String,
  val prefs: WatchPrefs,
  val baseline: String,
) {
  /** a change here needs a new socket; a prefs change does not */
  fun sameEndpoint(o: WatchConfig?): Boolean = o != null && o.addresses == addresses && o.token == token
}

/** A tapped notification's chat, as JS reads it (`takeOpenTarget`). */
data class OpenTarget(val sessionId: String, val projectId: String, val name: String, val branch: String?) {
  fun toMap(): Map<String, Any?> = mapOf("sessionId" to sessionId, "projectId" to projectId, "name" to name, "branch" to branch)
}

/** Process-wide state shared by the module (JS side) and the service. */
object BgWatchState {
  @Volatile var config: WatchConfig? = null
  @Volatile var running: Boolean = false
  /** "connecting" | "watching" | "retrying" | "stopped" */
  @Volatile var phase: String = "stopped"
    private set
  /** why the service last stopped by itself ("unauthorized", "protocol") */
  @Volatile var reason: String? = null
  @Volatile var service: BgWatchService? = null
  @Volatile var openTarget: OpenTarget? = null

  private val listeners = CopyOnWriteArrayList<() -> Unit>()

  /** No read timeout: a quiet socket is normal. The computer pings every 15 s (OkHttp answers
   * those by itself); this ping notices a dead link from our side. */
  val http: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .pingInterval(30, TimeUnit.SECONDS)
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .writeTimeout(10, TimeUnit.SECONDS)
      .build()
  }

  fun snapshot(): Map<String, Any?> = mapOf("running" to running, "phase" to phase, "reason" to reason)

  fun updatePhase(p: String) {
    if (phase == p) return
    phase = p
    changed()
  }

  fun addListener(l: () -> Unit) {
    listeners.add(l)
  }

  fun removeListener(l: () -> Unit) {
    listeners.remove(l)
  }

  fun changed() {
    for (l in listeners) runCatching { l() }
  }
}
