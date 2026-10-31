package expo.modules.portmirror

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

/** One mirrored port: the computer's port, and the phone loopback port it appears on. */
data class PortMap(val remote: Int, val local: Int)

/** What the service mirrors, and from where. The token lives here in memory only: it is never
 * written to disk, logged, or put in an Intent (Intents can be read back by the system). */
data class MirrorConfig(
  val url: String,
  val token: String,
  val computer: String,
  val ports: List<PortMap>,
)

data class PortStatus(val remote: Int, val local: Int, val listening: Boolean, val error: String?)

/**
 * Process-wide state shared by the module (JS side) and the service. The service is the only
 * writer of `running` and the statuses; the module only sets `config` and asks the service to
 * apply it.
 */
object MirrorState {
  @Volatile var config: MirrorConfig? = null
  @Volatile var running: Boolean = false
  /** Why the service last stopped by itself ("unauthorized" = the computer refused the token). */
  @Volatile var stoppedReason: String? = null
  /** The live service, so a config change is applied in place instead of re-starting it (a
   * start from the background is refused on Android 12+). */
  @Volatile var service: PortMirrorService? = null

  private val statuses = ConcurrentHashMap<Int, PortStatus>()
  private val listeners = CopyOnWriteArrayList<() -> Unit>()

  /** One client for every tunnel: a shared connection pool and dispatcher. No read timeout --
   * an idle tunnel (an HMR socket) is normal; the ping keeps the link honest instead. */
  val http: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .pingInterval(15, TimeUnit.SECONDS)
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .writeTimeout(10, TimeUnit.SECONDS)
      .build()
  }

  fun setStatus(s: PortStatus) {
    statuses[s.remote] = s
    changed()
  }

  fun removeStatus(remote: Int) {
    if (statuses.remove(remote) != null) changed()
  }

  fun clearStatuses() {
    statuses.clear()
    changed()
  }

  fun snapshot(): Map<String, Any?> = mapOf(
    "running" to running,
    "reason" to stoppedReason,
    "ports" to statuses.values.sortedBy { it.remote }.map {
      mapOf("remote" to it.remote, "local" to it.local, "listening" to it.listening, "error" to it.error)
    },
  )

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
