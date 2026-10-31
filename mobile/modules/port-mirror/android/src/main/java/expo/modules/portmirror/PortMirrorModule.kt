package expo.modules.portmirror

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class PortRecord : Record {
  @Field var remote: Int = 0
  @Field var local: Int = 0
}

class StartOptions : Record {
  @Field var url: String = ""
  @Field var token: String = ""
  @Field var computer: String = ""
  @Field var ports: List<PortRecord> = emptyList()
}

private class InvalidOptions(message: String) : CodedException("ERR_PORT_MIRROR_OPTIONS", message, null)

/**
 * JS face of the mirror: `start` (also how the port set is updated), `stop`, `status`, and an
 * `onStatus` event whenever a listener comes up, fails, or the service stops.
 */
class PortMirrorModule : Module() {
  private val onChange: () -> Unit = {
    runCatching { sendEvent(EVENT, MirrorState.snapshot()) }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("PortMirror")
    Events(EVENT)

    OnCreate { MirrorState.addListener(onChange) }
    OnDestroy { MirrorState.removeListener(onChange) }

    AsyncFunction("start") { o: StartOptions ->
      if (!o.url.startsWith("ws://") && !o.url.startsWith("wss://")) throw InvalidOptions("url must be ws:// or wss://")
      if (o.token.isEmpty()) throw InvalidOptions("token is required")
      val ports = o.ports.map { PortMap(it.remote, it.local) }
      if (ports.any { it.remote !in 1..65535 || it.local !in 1024..65535 }) throw InvalidOptions("port out of range")
      if (ports.map { it.local }.toSet().size != ports.size) throw InvalidOptions("two ports share a local port")
      val cfg = MirrorConfig(o.url, o.token, o.computer, ports)
      MirrorState.config = cfg
      val live = MirrorState.service
      if (live != null && MirrorState.running) {
        // Already running: apply in place. A second startForegroundService from the
        // background (the port list changing while Chrome is in front) is refused on 12+.
        live.apply(cfg)
      } else {
        ContextCompat.startForegroundService(context, Intent(context, PortMirrorService::class.java))
      }
      true
    }

    AsyncFunction("stop") {
      MirrorState.config = null
      MirrorState.stoppedReason = "stopped"
      context.stopService(Intent(context, PortMirrorService::class.java))
      true
    }

    Function("status") { MirrorState.snapshot() }
  }

  private companion object {
    const val EVENT = "onStatus"
  }
}
