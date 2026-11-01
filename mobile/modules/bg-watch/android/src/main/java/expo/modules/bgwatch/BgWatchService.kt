package expo.modules.bgwatch

import android.app.AlarmManager
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
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
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
  /** what the group summary last said (null: not posted) */
  private var summarySig: String? = null
  private var netCallback: ConnectivityManager.NetworkCallback? = null
  /** the time-driven re-check (a finish settling, a lost link becoming news): WatchRules.nextWakeAt */
  private val wake = Runnable {
    rules?.onTick(now())
    render()
  }
  /** the link's phase changes reach the rules (unreachable alert) */
  private val phaseListener: () -> Unit = {
    main.post {
      rules?.let { r ->
        r.onLink(BgWatchState.phase, now())
        render()
      }
    }
  }
  private var listening = false
  /** when the backstop alarm is set for (elapsedRealtime ms); null: none set */
  private var alarmAt: Long? = null
  /** the last VPN state the rules were told (networkChanged skips a repeat) */
  private var lastTunnel: Boolean? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    NativeLog.init(this)
    // A previous process may have left notifications nobody can cancel any more.
    cancelAllOurs(this)
    (getSystemService(NOTIFICATION_SERVICE) as? NotificationManager)?.let { ensureChannels(it) }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val cfg = BgWatchState.config
    // startForeground first, always: a service started with startForegroundService that stops
    // without calling it crashes the app.
    try {
      goForeground(cfg)
    } catch (e: Exception) {
      // e.g. ForegroundServiceStartNotAllowedException: logged, then the same failure as before
      NativeLog.error("bgwatch", "foreground.refused", e)
      throw e
    }
    val stopAsked = intent?.action == ACTION_STOP
    if (stopAsked || cfg == null) {
      // The ongoing notification's Stop: JS reads reason "stopped" (as PortMirror reports it).
      if (stopAsked) BgWatchState.reason = REASON_STOPPED
      BgWatchState.config = null
      stopSelf()
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_WAKE) {
      // The backstop alarm: the Handler's clock stood still while the CPU slept, so do now
      // what its wake (and the link's redial) would have done.
      alarmAt = null // it has fired: the next render sets a fresh one if one is still due
      rules?.let { r ->
        r.onTick(now())
        render()
        link?.nudge()
        return START_NOT_STICKY
      }
    }
    BgWatchState.service = this
    BgWatchState.running = true
    BgWatchState.reason = null
    apply(cfg)
    watchNetwork()
    if (!listening) {
      BgWatchState.addListener(phaseListener)
      listening = true
    }
    return START_NOT_STICKY
  }

  /** Bring the service in line with [cfg]: a new endpoint or token starts a new link and new
   * rules; a prefs change only re-decides what is showing. Main thread. */
  fun apply(cfg: WatchConfig) {
    main.post {
      if (!cfg.sameEndpoint(applied)) {
        link?.close()
        val (seen, signals) = WatchRules.baselineOf(cfg.baseline, now())
        val tunnel = tunnelUp()
        lastTunnel = tunnel
        rules = WatchRules(seen, signals).also { it.onNetwork(tunnel) }
        BgWatchState.updatePhase("connecting")
        link = Link(main, cfg, ::onFrame, ::fatal).also { it.start() }
        // the phase may already have been "connecting" (no change event): the clock starts now
        rules?.onLink(BgWatchState.phase, now())
      }
      applied = cfg
      ongoing(cfg)
      render()
    }
  }

  private fun onFrame(o: JSONObject) {
    val r = rules ?: return
    when (o.optString("type")) {
      "projects" -> r.onProjects(WatchRules.sessionsOf(o), now())
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

  /** Wall-clock ms for the rules. Elapsed-realtime based, so a clock change cannot fire or stall a settle. */
  private fun now(): Long = SystemClock.elapsedRealtime()

  /** Tailscale on Android is a VPN: with none up, an unreachable computer is expected, not news. */
  private fun tunnelUp(): Boolean {
    val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
    return runCatching {
      @Suppress("DEPRECATION")
      cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }
    }.getOrDefault(true)
  }

  /** Re-check when the rules next need time to pass; one pending wake at a time.
   * The Handler's delay counts uptime, which stands still while the CPU sleeps (screen off), so
   * an inexact alarm backs it up: it lands at most a few minutes late (Doze batches it), wakes
   * the CPU, and arrives as ACTION_WAKE. No wakelock and no exact-alarm permission. */
  private fun scheduleWake(r: WatchRules) {
    main.removeCallbacks(wake)
    val at = r.nextWakeAt()
    if (at == null) {
      cancelAlarm()
      return
    }
    main.postDelayed(wake, (at - now()).coerceAtLeast(0) + WAKE_SLACK_MS)
    setAlarm(at + ALARM_SLACK_MS)
  }

  private fun wakeIntent(): PendingIntent = PendingIntent.getService(
    this,
    2,
    Intent(this, BgWatchService::class.java).setAction(ACTION_WAKE),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
  )

  /** Replace the backstop alarm (the same PendingIntent, so one at a time); unchanged: left alone. */
  private fun setAlarm(at: Long) {
    if (alarmAt == at) return
    val am = getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    runCatching { am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, wakeIntent()) }
      .onSuccess { alarmAt = at }
      .onFailure { NativeLog.warn("bgwatch", "alarm.failed", it) }
  }

  private fun cancelAlarm() {
    if (alarmAt == null) return
    alarmAt = null
    val am = getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    runCatching { am.cancel(wakeIntent()) }
  }

  /** watch.ts diffNotifications: post what is new or changed, cancel what is no longer wanted.
   * An unchanged notification is never re-posted (signature), and a changed one updates in
   * place with setOnlyAlertOnce, so only a NEW notification makes a sound. */
  private fun render() {
    val cfg = applied ?: return
    val r = rules ?: return
    scheduleWake(r)
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    val desired = r.desired(cfg.prefs)
    val group = groupKey(cfg)
    val keep = HashSet<String>()
    // The summary goes up BEFORE a child posted with it, so the children never sit ungrouped.
    renderSummary(nm, cfg, group, desired)
    for (n in desired) {
      keep.add(n.key)
      if (posted[n.key] == n.signature) continue
      posted[n.key] = n.signature
      runCatching { nm.notify(TAG_PREFIX + n.key, ITEM_ID, build(n, group)) }
        .onFailure { NativeLog.warn("bgwatch", "notify.failed", it, n.channel) }
    }
    for (k in posted.keys.filter { it !in keep }) {
      posted.remove(k)
      runCatching { nm.cancel(TAG_PREFIX + k, ITEM_ID) }
    }
  }

  /** One group per computer, so a fleet stacks into one entry in the shade instead of flooding it. */
  private fun groupKey(cfg: WatchConfig): String =
    GROUP_PREFIX + (cfg.computer.takeIf { it.isNotBlank() } ?: cfg.addresses.firstOrNull() ?: "")

  /** The group's summary: up while any agent notification is, re-posted only when its text changes.
   * It never alerts by itself (GROUP_ALERT_CHILDREN): the child that arrived does. */
  private fun renderSummary(nm: NotificationManager, cfg: WatchConfig, group: String, desired: List<WatchNotification>) {
    if (desired.isEmpty()) {
      if (summarySig != null) {
        summarySig = null
        runCatching { nm.cancel(SUMMARY_TAG, ITEM_ID) }
      }
      return
    }
    val needs = desired.count { it.channel == "needs" }
    val done = desired.count { it.channel == "finished" }
    val other = desired.size - needs - done
    val text = listOfNotNull(
      if (needs > 0) (if (needs == 1) "1 needs you" else "$needs need you") else null,
      if (done > 0) "$done finished" else null,
      if (other > 0) (if (other == 1) "1 update" else "$other updates") else null,
    ).joinToString(" · ")
    val from = cfg.computer.takeIf { it.isNotBlank() } ?: "your computer"
    val channel = if (needs > 0) CHANNEL_NEEDS else if (done > 0) CHANNEL_FINISHED else CHANNEL_STATUS
    val sig = listOf(group, channel, from, text).toString()
    if (sig == summarySig) return
    summarySig = sig
    val public = NotificationCompat.Builder(this, channel)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(WatchRules.APP_TITLE)
      .setContentText(if (needs > 0) WatchRules.PUBLIC_NEEDS else if (done > 0) WatchRules.PUBLIC_FINISHED else WatchRules.PUBLIC_STATUS)
      .build()
    val summary = NotificationCompat.Builder(this, channel)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(WatchRules.APP_TITLE)
      .setContentText(text)
      .setSubText(from)
      .setGroup(group)
      .setGroupSummary(true)
      .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(public)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setContentIntent(openIntent(null, "summary"))
      .build()
    runCatching { nm.notify(SUMMARY_TAG, ITEM_ID, summary) }
  }

  private fun build(n: WatchNotification, group: String): Notification {
    val needs = n.channel == "needs"
    val channel = when (n.channel) {
      "needs" -> CHANNEL_NEEDS
      "status" -> CHANNEL_STATUS
      else -> CHANNEL_FINISHED
    }
    val open = openIntent(n.target, n.key)
    val public = NotificationCompat.Builder(this, channel)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(WatchRules.APP_TITLE)
      .setContentText(
        when (n.channel) {
          "needs" -> WatchRules.PUBLIC_NEEDS
          "status" -> WatchRules.PUBLIC_STATUS
          else -> WatchRules.PUBLIC_FINISHED
        },
      )
      .build()
    return NotificationCompat.Builder(this, channel)
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
      .setGroup(group)
      .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
      .setContentIntent(open)
      .build()
  }

  /** The app's launch intent; with a target, the chat it should open (read back by the module). */
  private fun openIntent(target: Target?, key: String): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (target != null) {
      launch.putExtra(EXTRA_NONCE, BgWatchState.openNonce)
      launch.putExtra(EXTRA_SESSION, target.sessionId)
      launch.putExtra(EXTRA_PROJECT, target.projectId)
      launch.putExtra(EXTRA_NAME, target.name)
      launch.putExtra(EXTRA_BRANCH, target.branch ?: "")
    }
    // one request code per notification, so each keeps its own extras
    return PendingIntent.getActivity(this, key.hashCode(), launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun fatal(reason: String) {
    NativeLog.warn("bgwatch", "link.fatal", detail = reason)
    BgWatchState.reason = reason
    BgWatchState.config = null
    stopSelf()
  }

  private fun watchNetwork() {
    if (netCallback != null) return
    val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        main.post {
          link?.networkBack()
          networkChanged()
        }
      }

      override fun onLost(network: Network) {
        main.post { networkChanged() }
      }

      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        main.post { networkChanged() }
      }
    }
    if (runCatching { cm.registerDefaultNetworkCallback(cb) }.isSuccess) netCallback = cb
  }

  /** A VPN coming or going decides whether "can't reach your computer" is news. The callback
   * fires on every capability change (signal strength too), so an unchanged VPN state is skipped. */
  private fun networkChanged() {
    val r = rules ?: return
    val tunnel = tunnelUp()
    if (tunnel == lastTunnel) return
    lastTunnel = tunnel
    r.onNetwork(tunnel)
    render()
  }

  override fun onDestroy() {
    main.removeCallbacksAndMessages(null)
    cancelAlarm()
    lastTunnel = null
    if (listening) {
      BgWatchState.removeListener(phaseListener)
      listening = false
    }
    link?.close()
    link = null
    rules = null
    applied = null
    posted.clear()
    summarySig = null
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
    val from = cfg?.computer?.takeIf { it.isNotBlank() } ?: "your computer"
    val needsOn = cfg == null || cfg.prefs.question || cfg.prefs.permission || cfg.prefs.failed
    val finishedOn = cfg?.prefs?.finished == true || cfg?.prefs?.stopped == true
    val text = when {
      needsOn && finishedOn -> "You'll be notified when one needs you or finishes"
      finishedOn -> "You'll be notified when one finishes or stops"
      !needsOn && cfg?.prefs?.unreachable == true -> "You'll be notified if your computer goes out of reach"
      else -> "You'll be notified when one needs you"
    }
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, BgWatchService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Builder(this, CHANNEL_WATCH)
      .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
      .setContentTitle("Watching for agents on $from")
      .setContentText(text)
      .setOngoing(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(openIntent(null, "ongoing"))
      .addAction(0, "Stop", stop)
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
    if (nm.getNotificationChannel(CHANNEL_STATUS) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_STATUS, "Sessions stopped, computer unreachable", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "A running session was stopped, or your computer has been out of reach for a while"
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
    const val EXTRA_NONCE = "expo.modules.bgwatch.NONCE"
    const val ACTION_STOP = "expo.modules.bgwatch.STOP"
    /** the backstop alarm (scheduleWake) */
    const val ACTION_WAKE = "expo.modules.bgwatch.WAKE"
    /** BgWatchState.reason after the ongoing notification's Stop */
    const val REASON_STOPPED = "stopped"
    private const val CHANNEL_NEEDS = "agent_needs_you"
    // A channel's importance is fixed once created, so the heads-up version needs a new id.
    private const val CHANNEL_FINISHED = "agent_finished_alert"
    private const val OLD_CHANNEL_FINISHED = "agent_finished"
    private const val CHANNEL_STATUS = "agent_status"
    /** a wake lands just after its deadline, never just before */
    private const val WAKE_SLACK_MS = 50L
    /** the alarm is only a backstop: it lands after the Handler's wake would have, when awake */
    private const val ALARM_SLACK_MS = 1_000L
    private const val CHANNEL_WATCH = "bg_watch"
    private const val TAG_PREFIX = "bgwatch:"
    // under TAG_PREFIX, so cancelAllOurs takes the summary down too
    private const val SUMMARY_TAG = TAG_PREFIX + "summary"
    private const val GROUP_PREFIX = "expo.modules.bgwatch.group:"
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
