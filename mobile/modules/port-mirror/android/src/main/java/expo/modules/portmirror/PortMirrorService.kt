package expo.modules.portmirror

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import expo.modules.bgwatch.NativeLog
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * Foreground service: one loopback-only listener per mirrored port, each accepted connection
 * becoming a [Tunnel] to the computer's bridge. Foreground so Chrome can use the mirror while
 * Conduit is in the background; the ongoing notification is also the reminder that the
 * phone's loopback is carrying the computer's apps.
 *
 * Not sticky: the token is in memory only, so a service the system restarted on its own would
 * have nothing to mirror with.
 */
class PortMirrorService : Service() {
  private val listeners = HashMap<Int, PortListener>()
  private val tunnels: MutableSet<Tunnel> = ConcurrentHashMap.newKeySet()
  private var applied: MirrorConfig? = null
  private val main = Handler(Looper.getMainLooper())

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    NativeLog.init(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val cfg = MirrorState.config
    // startForeground first, always: a service started with startForegroundService that stops
    // without calling it crashes the app.
    try {
      goForeground(cfg)
    } catch (e: Exception) {
      NativeLog.error("mirror", "foreground.refused", e)
      throw e
    }
    val stopAsked = intent?.action == ACTION_STOP
    if (stopAsked || cfg == null) {
      if (stopAsked) MirrorState.stoppedReason = "stopped"
      MirrorState.config = null
      stopSelf()
      return START_NOT_STICKY
    }
    MirrorState.service = this
    MirrorState.running = true
    MirrorState.stoppedReason = null
    apply(cfg)
    return START_NOT_STICKY
  }

  /**
   * Bring the listeners in line with [cfg]. A changed endpoint or token restarts every
   * listener (its tunnels would dial the old one); otherwise only added, removed or remapped
   * ports change, and the tunnels already open keep running.
   */
  @Synchronized
  fun apply(cfg: MirrorConfig) {
    val prev = applied
    val endpointChanged = prev == null || prev.url != cfg.url || prev.token != cfg.token
    val want = cfg.ports.associateBy { it.remote }
    val drop = listeners.keys.filter { r -> endpointChanged || want[r]?.local != listeners[r]?.map?.local }
    // Close AND wait for the old listeners: a replacement on the same local port would
    // otherwise race the old accept thread (still binding, or not yet closed) and fail "in use".
    val old = drop.mapNotNull { listeners.remove(it) }
    old.forEach { it.close() }
    old.forEach { it.join(JOIN_MS) }
    for (r in drop) MirrorState.removeStatus(r)
    for ((r, m) in want) {
      if (r !in listeners) listeners[r] = PortListener(m, cfg).also { it.start() }
    }
    applied = cfg
    notifyForeground(cfg)
  }

  override fun onDestroy() {
    synchronized(this) {
      listeners.values.forEach { it.close() }
      listeners.clear()
      applied = null
    }
    tunnels.toList().forEach { it.close() }
    if (MirrorState.service === this) MirrorState.service = null
    MirrorState.running = false
    MirrorState.clearStatuses()
    super.onDestroy()
  }

  /** The computer refused the token (revoked, or mirroring turned off there): stop everything
   * rather than retry it on every browser connection. */
  private fun unauthorized() {
    NativeLog.warn("mirror", "tunnel.unauthorized")
    MirrorState.stoppedReason = "unauthorized"
    MirrorState.config = null
    main.post { stopSelf() }
  }

  private inner class PortListener(val map: PortMap, private val cfg: MirrorConfig) {
    @Volatile private var server: ServerSocket? = null
    @Volatile private var stopped = false
    @Volatile private var worker: Thread? = null

    fun start() {
      worker = thread(name = "port-mirror-accept-${map.local}", isDaemon = true) {
        // Thread root: a bug here ends this one listener (logged), never the whole app.
        try {
          run()
        } catch (t: Throwable) {
          NativeLog.error("mirror", "listener.crashed", t, "port ${map.local}")
          if (!stopped) MirrorState.setStatus(PortStatus(map.remote, map.local, false, "failed"))
          runCatching { server?.close() }
        }
      }
    }

    /** Loopback ONLY: never the phone's Wi-Fi or cellular address. */
    private fun bind(): ServerSocket {
      val s = ServerSocket()
      try {
        s.reuseAddress = true
        s.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), map.local), 64)
      } catch (e: Exception) {
        runCatching { s.close() }
        throw e
      }
      return s
    }

    private fun run() {
      val s = try {
        bind()
      } catch (_: Exception) {
        // One retry: a listener we just replaced (or another app's) may be releasing the port.
        if (!stopped) runCatching { Thread.sleep(BIND_RETRY_MS) }
        try {
          if (stopped) return
          bind()
        } catch (e: Exception) {
          // A replaced listener must not overwrite its successor's status.
          if (!stopped) {
            NativeLog.warn("mirror", "bind.failed", e, "port ${map.local}")
            MirrorState.setStatus(PortStatus(map.remote, map.local, false, "in use"))
          }
          return
        }
      }
      if (stopped) {
        runCatching { s.close() }
        return
      }
      server = s
      MirrorState.setStatus(PortStatus(map.remote, map.local, true, null))
      while (!stopped) {
        val sock: Socket = try {
          s.accept()
        } catch (_: Exception) {
          break
        }
        runCatching { sock.tcpNoDelay = true }
        val t = Tunnel(sock, map.remote, cfg, { tunnels.remove(it) }, { unauthorized() })
        tunnels.add(t)
        t.start()
      }
      runCatching { s.close() }
    }

    fun close() {
      stopped = true
      runCatching { server?.close() }
    }

    /** Wait (bounded) for the accept thread to end, so its port is free and it writes no status. */
    fun join(ms: Long) {
      val w = worker ?: return
      if (w === Thread.currentThread()) return
      runCatching { w.join(ms) }
    }
  }

  private fun goForeground(cfg: MirrorConfig?) {
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(cfg), type)
  }

  private fun notifyForeground(cfg: MirrorConfig) {
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    runCatching { nm.notify(NOTIFICATION_ID, notification(cfg)) }
  }

  private fun notification(cfg: MirrorConfig?): Notification {
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Local web apps", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while your computer's web apps are mirrored to this phone"
          setShowBadge(false)
        },
      )
    }
    val n = cfg?.ports?.size ?: 0
    val from = cfg?.computer?.takeIf { it.isNotBlank() } ?: "your computer"
    val title = if (n == 1) "Mirroring 1 port from $from" else "Mirroring $n ports from $from"
    val text = cfg?.ports?.joinToString("  ") { "localhost:${it.local}" } ?: ""
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, PortMirrorService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(open)
      .addAction(0, "Stop", stop)
      .build()
  }

  companion object {
    const val ACTION_STOP = "expo.modules.portmirror.STOP"
    private const val CHANNEL_ID = "port_mirror"
    private const val NOTIFICATION_ID = 0x504d
    private const val JOIN_MS = 1_000L
    private const val BIND_RETRY_MS = 250L
  }
}
