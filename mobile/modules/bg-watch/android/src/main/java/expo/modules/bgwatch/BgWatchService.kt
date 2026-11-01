package expo.modules.bgwatch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject

/**
 * Foreground service that runs only while the app is in the background with a Notify switch
 * on: one [Link] to the computer, [WatchRules] deciding what to show, and the notifications.
 * Its own ongoing notification sits on a minimum-importance channel (no sound, no status-bar
 * icon) so it stays out of the way.
 *
 * Not sticky: the token is in memory only, so a service the system restarted on its own would
 * have nothing to connect with. Every notification it posted goes when it stops -- back in the
 * app, the in-app cards say the same thing.
 */
class BgWatchService : Service() {
  private val main = Handler(Looper.getMainLooper())
  private var link: Link? = null
  private var applied: WatchConfig? = null
  private var rules: WatchRules? = null
  private val posted = HashMap<String, String>()
  private var netCallback: ConnectivityManager.NetworkCallback? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    // A previous process may have left notifications nobody can cancel any more.
    cancelAllOurs(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val cfg = BgWatchState.config
    // startForeground first, always: a service started with startForegroundService that stops
    // without calling it crashes the app.
    goForeground(cfg)
    if (cfg == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    BgWatchState.service = this
    BgWatchState.running = true
    BgWatchState.reason = null
    apply(cfg)
    watchNetwork()
    return START_NOT_STICKY
  }

  /** Bring the service in line with [cfg]: a new endpoint or token starts a new link and new
   * rules; a prefs change only re-decides what is showing. Main thread. */
  fun apply(cfg: WatchConfig) {
    main.post {
      if (!cfg.sameEndpoint(applied)) {
        link?.close()
        val (seen, signals) = WatchRules.baselineOf(cfg.baseline)
        rules = WatchRules(seen, signals)
        BgWatchState.updatePhase("connecting")
        link = Link(main, cfg, ::onFrame, ::fatal).also { it.start() }
      }
      applied = cfg
      ongoing(cfg)
      render()
    }
  }

  private fun onFrame(o: JSONObject) {
    val r = rules ?: return
    when (o.optString("type")) {
      "projects" -> r.onProjects(WatchRules.sessionsOf(o))
      "pending" -> r.onSnapshot(WatchRules.itemsOf(o.optJSONArray("asks")) + WatchRules.itemsOf(o.optJSONArray("permissions")))
      "pendingAdded" -> o.optJSONObject("item")?.let { WatchRules.itemOf(it) }?.let { r.onAdded(it) }
      "resolved" -> o.optString("id").takeIf { it.isNotEmpty() }?.let { r.onResolved(it) }
      "rootChats" -> r.onChats(WatchRules.chatTitlesOf(o))
      "rootChatEvent" -> {
        val chatId = o.optString("chatId").takeIf { it.isNotEmpty() } ?: return
        val result = if (o.isNull("result")) null else o.optString("result")
        r.onChatEvent(o.optString("event"), chatId, result, o.optBoolean("isError", false))
      }
      else -> return
    }
    render()
  }

  /** watch.ts diffNotifications: post what is new or changed, cancel what is no longer wanted. */
  private fun render() {
    val cfg = applied ?: return
    val r = rules ?: return
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    ensureChannels(nm)
    val desired = r.desired(cfg.prefs)
    val keep = HashSet<String>()
    for (n in desired) {
      keep.add(n.key)
      if (posted[n.key] == n.signature) continue
      posted[n.key] = n.signature
      runCatching { nm.notify(TAG_PREFIX + n.key, ITEM_ID, build(n)) }
    }
    for (k in posted.keys.filter { it !in keep }) {
      posted.remove(k)
      runCatching { nm.cancel(TAG_PREFIX + k, ITEM_ID) }
    }
  }

  private fun build(n: WatchNotification): Notification {
    val needs = n.channel == "needs"
    val open = openIntent(n.target, n.key)
    val public = NotificationCompat.Builder(this, if (needs) CHANNEL_NEEDS else CHANNEL_FINISHED)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(WatchRules.APP_TITLE)
      .setContentText(if (needs) WatchRules.PUBLIC_NEEDS else WatchRules.PUBLIC_FINISHED)
      .build()
    return NotificationCompat.Builder(this, if (needs) CHANNEL_NEEDS else CHANNEL_FINISHED)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(n.title)
      .setContentText(n.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(n.body))
      .setSubText(n.subtitle)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(if (needs) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
      // a command or question is not for the lock screen unless the reader allows that
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(public)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setContentIntent(open)
      .build()
  }

  /** The app's launch intent; with a target, the chat it should open (read back by the module). */
  private fun openIntent(target: Target?, key: String): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (target != null) {
      launch.putExtra(EXTRA_SESSION, target.sessionId)
      launch.putExtra(EXTRA_PROJECT, target.projectId)
      launch.putExtra(EXTRA_NAME, target.name)
      launch.putExtra(EXTRA_BRANCH, target.branch ?: "")
    }
    // one request code per notification, so each keeps its own extras
    return PendingIntent.getActivity(this, key.hashCode(), launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun fatal(reason: String) {
    BgWatchState.reason = reason
    BgWatchState.config = null
    stopSelf()
  }

  private fun watchNetwork() {
    if (netCallback != null) return
    val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        main.post { link?.networkBack() }
      }
    }
    if (runCatching { cm.registerDefaultNetworkCallback(cb) }.isSuccess) netCallback = cb
  }

  override fun onDestroy() {
    main.removeCallbacksAndMessages(null)
    link?.close()
    link = null
    rules = null
    applied = null
    posted.clear()
    netCallback?.let { cb ->
      runCatching { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(cb) }
    }
    netCallback = null
    cancelAllOurs(this)
    if (BgWatchState.service === this) BgWatchState.service = null
    BgWatchState.running = false
    BgWatchState.updatePhase("stopped")
    BgWatchState.changed()
    super.onDestroy()
  }

  private fun goForeground(cfg: WatchConfig?) {
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    ServiceCompat.startForeground(this, ONGOING_ID, ongoingNotification(cfg), type)
  }

  private fun ongoing(cfg: WatchConfig) {
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    runCatching { nm.notify(ONGOING_ID, ongoingNotification(cfg)) }
  }

  private fun ongoingNotification(cfg: WatchConfig?): Notification {
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    ensureChannels(nm)
    val from = cfg?.computer?.takeIf { it.isNotBlank() } ?: "your computer"
    return NotificationCompat.Builder(this, CHANNEL_WATCH)
      .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
      .setContentTitle("Watching for agents on $from")
      .setContentText("You'll be notified when one needs you")
      .setOngoing(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(openIntent(null, "ongoing"))
      .build()
  }

  private fun ensureChannels(nm: NotificationManager) {
    if (Build.VERSION.SDK_INT < 26) return
    if (nm.getNotificationChannel(CHANNEL_NEEDS) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_NEEDS, "Agent needs you", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "A session asks a question or needs a permission"
        },
      )
    }
    if (nm.getNotificationChannel(CHANNEL_FINISHED) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_FINISHED, "Agent finished", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "A session or chat finished its turn"
        },
      )
    }
    // 0.50.0-4 made it at default importance, which OriginOS files silently in the shade.
    if (nm.getNotificationChannel(OLD_CHANNEL_FINISHED) != null) runCatching { nm.deleteNotificationChannel(OLD_CHANNEL_FINISHED) }
    if (nm.getNotificationChannel(CHANNEL_WATCH) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_WATCH, "Background connection", NotificationManager.IMPORTANCE_MIN).apply {
          description = "Shown while Conduit stays connected in the background to notify you"
          setShowBadge(false)
        },
      )
    }
  }

  companion object {
    const val EXTRA_SESSION = "expo.modules.bgwatch.SESSION"
    const val EXTRA_PROJECT = "expo.modules.bgwatch.PROJECT"
    const val EXTRA_NAME = "expo.modules.bgwatch.NAME"
    const val EXTRA_BRANCH = "expo.modules.bgwatch.BRANCH"
    private const val CHANNEL_NEEDS = "agent_needs_you"
    // A channel's importance is fixed once created, so the heads-up version needs a new id.
    private const val CHANNEL_FINISHED = "agent_finished_alert"
    private const val OLD_CHANNEL_FINISHED = "agent_finished"
    private const val CHANNEL_WATCH = "bg_watch"
    private const val TAG_PREFIX = "bgwatch:"
    private const val ITEM_ID = 1
    private const val ONGOING_ID = 0x4257

    /** Take down every notification this watcher posted (any process). */
    fun cancelAllOurs(ctx: Context) {
      val nm = ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager
      runCatching {
        for (sbn in nm.activeNotifications) {
          if (sbn.tag?.startsWith(TAG_PREFIX) == true) nm.cancel(sbn.tag, sbn.id)
        }
      }
    }
  }
}
