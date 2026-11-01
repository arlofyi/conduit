package expo.modules.bgwatch

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class StartOptions : Record {
  @Field var addresses: List<String> = emptyList()
  @Field var token: String = ""
  @Field var computer: String = ""
  @Field var notifyQuestion: Boolean = true
  @Field var notifyPermission: Boolean = true
  @Field var notifyFinished: Boolean = false
  @Field var baseline: String = "{}"
}

private class InvalidOptions(message: String) : CodedException("ERR_BG_WATCH_OPTIONS", message, null)

private class StartRefused(cause: Throwable) : CodedException("ERR_BG_WATCH_START", "the system refused to start the watcher", cause)

/**
 * JS face of the watcher (see index.ts): `start` (also how a running one is updated), `stop`,
 * `status` + `onStatus`, the tapped notification's chat (`takeOpenTarget` + `onOpen`), and the
 * permission / battery state Settings shows.
 */
class BgWatchModule : Module() {
  private val onChange: () -> Unit = {
    runCatching { sendEvent(EVENT_STATUS, BgWatchState.snapshot()) }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("BgWatch")
    Events(EVENT_STATUS, EVENT_OPEN)

    OnCreate { BgWatchState.addListener(onChange) }
    OnDestroy { BgWatchState.removeListener(onChange) }

    // A notification tapped while the app was running (MainActivity is singleTask).
    OnNewIntent { intent ->
      if (takeExtras(intent)) runCatching { sendEvent(EVENT_OPEN, emptyMap<String, Any?>()) }
    }

    AsyncFunction("start") { o: StartOptions ->
      val addresses = o.addresses.filter { it.startsWith("ws://") || it.startsWith("wss://") }
      if (addresses.isEmpty()) throw InvalidOptions("no ws:// address")
      if (o.token.isEmpty()) throw InvalidOptions("token is required")
      val cfg = WatchConfig(
        addresses,
        o.token,
        o.computer,
        WatchPrefs(o.notifyQuestion, o.notifyPermission, o.notifyFinished),
        o.baseline,
      )
      BgWatchState.config = cfg
      val live = BgWatchState.service
      if (live != null && BgWatchState.running) {
        live.apply(cfg)
      } else {
        BgWatchState.reason = null
        BgWatchState.updatePhase("connecting")
        try {
          ContextCompat.startForegroundService(context, Intent(context, BgWatchService::class.java))
        } catch (e: Exception) {
          // Android 12+: refused from the background (we were too late leaving the screen).
          BgWatchState.config = null
          BgWatchState.updatePhase("stopped")
          throw StartRefused(e)
        }
      }
      true
    }

    AsyncFunction("stop") {
      BgWatchState.config = null
      context.stopService(Intent(context, BgWatchService::class.java))
      // nothing running to take them down (e.g. left by a process the system killed)
      BgWatchService.cancelAllOurs(context)
      true
    }

    Function("status") { BgWatchState.snapshot() }

    Function("takeOpenTarget") {
      // A cold start from a notification: the extras are on the launch intent.
      appContext.currentActivity?.intent?.let { takeExtras(it) }
      val t = BgWatchState.openTarget
      BgWatchState.openTarget = null
      t?.toMap()
    }

    Function("notificationsEnabled") { NotificationManagerCompat.from(context).areNotificationsEnabled() }

    Function("batteryRestricted") {
      val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      pm != null && !pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    // The app's own info page: on OEM skins (vivo's OriginOS among them) that is where the
    // battery / background-activity switches live, and it needs no extra permission.
    Function("openBatterySettings") {
      openSettings(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")),
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
      )
    }

    Function("openNotificationSettings") {
      val notif = if (Build.VERSION.SDK_INT >= 26) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      } else {
        null
      }
      openSettings(notif, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }
  }

  private fun openSettings(vararg intents: Intent?): Boolean {
    for (i in intents) {
      if (i == null) continue
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      if (runCatching { context.startActivity(i) }.isSuccess) return true
    }
    return false
  }

  /** Move a notification's chat off [intent] into the state (once: the extras are removed). */
  private fun takeExtras(intent: Intent): Boolean {
    val sid = intent.getStringExtra(BgWatchService.EXTRA_SESSION) ?: return false
    val pid = intent.getStringExtra(BgWatchService.EXTRA_PROJECT) ?: ""
    val name = intent.getStringExtra(BgWatchService.EXTRA_NAME) ?: ""
    val branch = intent.getStringExtra(BgWatchService.EXTRA_BRANCH)?.ifEmpty { null }
    for (k in listOf(BgWatchService.EXTRA_SESSION, BgWatchService.EXTRA_PROJECT, BgWatchService.EXTRA_NAME, BgWatchService.EXTRA_BRANCH)) {
      intent.removeExtra(k)
    }
    if (sid.isEmpty()) return false
    BgWatchState.openTarget = OpenTarget(sid, pid, name, branch)
    return true
  }

  private companion object {
    const val EVENT_STATUS = "onStatus"
    const val EVENT_OPEN = "onOpen"
  }
}
