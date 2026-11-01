package expo.modules.bgwatch

import android.content.Context
import java.io.File

/**
 * The background services' diagnostics log: `cacheDir/conduit-logs/native.log` (+ `native.1.log`,
 * 256 KB each), next to the app's own `app.log` (data/diagnostics.ts). Written by [BgWatchService]
 * and, through this same object (modules/port-mirror depends on this module), PortMirrorService,
 * so one lock orders both. The CACHE dir on purpose: Android Auto Backup skips it, so the log
 * never leaves the phone that way. Nothing here is sent anywhere; the app reads it for "Share log".
 *
 * Never throws: a full disk drops a line, it never takes a service down.
 */
object NativeLog {
  private const val DIR = "conduit-logs"
  private const val BASE = "native"
  private const val MAX_BYTES = 256L * 1024
  private const val KEEP = 2

  @Volatile private var dir: File? = null
  @Volatile private var handlerInstalled = false
  private val lock = Any()

  /** Remember where to write (any Context; the application's is kept) and hook uncaught
   * exceptions once per process, chaining whatever handler was there (React Native's crash path
   * runs exactly as before -- the line is written first). */
  fun init(ctx: Context) {
    if (dir == null) {
      runCatching { dir = File(ctx.applicationContext.cacheDir, DIR) }
    }
    if (handlerInstalled) return
    synchronized(lock) {
      if (handlerInstalled) return
      handlerInstalled = true
      val prev = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, t ->
        runCatching { write("error", "native", "uncaught", "thread ${thread.name} -- ${NativeLogRules.describe(t, 8)}") }
        prev?.uncaughtException(thread, t)
      }
    }
  }

  fun info(source: String, event: String, detail: String? = null) = write("info", source, event, detail)

  fun warn(source: String, event: String, t: Throwable? = null, detail: String? = null) =
    write("warn", source, event, join(t?.let { NativeLogRules.describe(it) }, detail))

  fun error(source: String, event: String, t: Throwable? = null, detail: String? = null) =
    write("error", source, event, join(t?.let { NativeLogRules.describe(it, 6) }, detail))

  private fun join(a: String?, b: String?): String? = listOfNotNull(a, b).joinToString(" -- ").ifEmpty { null }

  private fun write(level: String, source: String, event: String, detail: String?) {
    val d = dir ?: return
    runCatching {
      val line = NativeLogRules.line(System.currentTimeMillis(), level, source, event, detail)
      val bytes = line.toByteArray(Charsets.UTF_8)
      synchronized(lock) {
        if (!d.exists()) d.mkdirs()
        val names = NativeLogRules.rotatedNames(BASE, KEEP)
        val live = File(d, names[0])
        if (NativeLogRules.shouldRotate(if (live.exists()) live.length() else 0L, bytes.size.toLong(), MAX_BYTES)) {
          File(d, names.last()).delete()
          for (i in names.size - 1 downTo 1) File(d, names[i - 1]).renameTo(File(d, names[i]))
        }
        File(d, names[0]).appendBytes(bytes)
      }
    }
  }

  /** Oldest first; "" when nothing was logged. */
  fun read(): String {
    val d = dir ?: return ""
    return runCatching {
      synchronized(lock) {
        NativeLogRules.rotatedNames(BASE, KEEP).reversed().joinToString("") { n ->
          val f = File(d, n)
          if (f.exists()) f.readText(Charsets.UTF_8) else ""
        }
      }
    }.getOrDefault("")
  }

  fun clear(): Boolean {
    val d = dir ?: return false
    return runCatching {
      synchronized(lock) { NativeLogRules.rotatedNames(BASE, KEEP).forEach { File(d, it).delete() } }
      true
    }.getOrDefault(false)
  }

  fun path(): String = dir?.absolutePath ?: ""
}
