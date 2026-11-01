package expo.modules.bgwatch

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The pure half of [NativeLog]: a Kotlin port of mobile/src/logic/diagLog.ts `redact` /
 * `formatLine` / rotation, so a line from the background services reads (and is scrubbed)
 * exactly like one from the app. Change both together; NativeLogRulesTest mirrors diagLog.test.ts.
 *
 * Callers log event KINDS and exception messages only -- never the device token, a pairing
 * secret, a notification's text or a tunnelled byte. [redact] is the second line of defence.
 */
object NativeLogRules {
  const val MAX_DETAIL = 500
  const val REDACTED = "<redacted>"

  private const val KEYS = "token|secret|password|passwd|nonce|apikey|api_key|authorization|cookie"
  private val quotedKey = Regex(
    "([\"']?)([A-Za-z_]*(?:$KEYS)[A-Za-z_]*)\\1(\\s*[:=]\\s*)([\"'])(?:\\\\.|(?!\\4).)*\\4",
    RegexOption.IGNORE_CASE,
  )
  private val bareKey = Regex(
    "\\b([A-Za-z_]*(?:token|secret|password|passwd|nonce|apikey|api_key)[A-Za-z_]*)(\\s*[=:]\\s*)(?!<redacted>)([^\\s&\"',;)}\\]]+)",
    RegexOption.IGNORE_CASE,
  )
  private val bearer = Regex("\\b(Bearer|Basic)\\s+[^\\s\"',;]+", RegexOption.IGNORE_CASE)
  private val userUri = Regex("\\b(?:file|content|ph|assets-library)://[^\\s\"',;)]+", RegexOption.IGNORE_CASE)
  private val netUrl = Regex("\\b(wss?|https?)://(?:[^\\s/@\"']*@)?([^\\s/?#\"',;)]+)[^\\s\"',;)]*", RegexOption.IGNORE_CASE)
  private val absPath = Regex("(?<![\\w:/])(?:[A-Za-z]:[\\\\/]|/)(?:[^\\s/\\\\:\"'<>]+[\\\\/]){2,}[^\\s\"',;:)<>]*")
  private val longRun = Regex("[A-Za-z0-9_\\-+/]{32,}={0,2}")
  private val newlines = Regex("\\s*[\\r\\n]+\\s*")

  fun redact(text: String): String {
    var s = text
    s = quotedKey.replace(s) { m ->
      val q = m.groupValues[1]
      "$q${m.groupValues[2]}$q${m.groupValues[3]}${m.groupValues[4]}$REDACTED${m.groupValues[4]}"
    }
    s = bareKey.replace(s) { m -> "${m.groupValues[1]}${m.groupValues[2]}$REDACTED" }
    s = bearer.replace(s) { m -> "${m.groupValues[1]} $REDACTED" }
    s = userUri.replace(s, "<uri>")
    s = netUrl.replace(s) { m -> "${m.groupValues[1]}://${m.groupValues[2]}" }
    s = absPath.replace(s, "<path>")
    s = longRun.replace(s, REDACTED)
    return s
  }

  /** One line: redacted, newlines folded, capped. */
  fun clean(text: String, max: Int = MAX_DETAIL): String {
    val one = newlines.replace(redact(text), " | ").trim()
    return if (one.length > max) one.substring(0, max - 1) + "…" else one
  }

  /** An exception, safely: class, message, and (for errors) the top frames, which name code only. */
  fun describe(t: Throwable, frames: Int = 0): String {
    val head = t.message?.let { "${t.javaClass.simpleName}: $it" } ?: t.javaClass.simpleName
    if (frames <= 0) return clean(head)
    val stack = t.stackTrace.take(frames).joinToString(" < ") { "${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}" }
    return clean(if (stack.isEmpty()) head else "$head @ $stack")
  }

  /** `2026-11-01T09:30:00.000Z ERROR bgwatch link.failed: detail` + newline. */
  fun line(atMs: Long, level: String, source: String, event: String, detail: String?): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    val lvl = level.uppercase(Locale.US).padEnd(5)
    val d = detail?.takeIf { it.isNotEmpty() }?.let { ": ${clean(it)}" } ?: ""
    return "${fmt.format(Date(atMs))} $lvl ${source.replace(Regex("\\s+"), "_")} ${event.replace(Regex("\\s+"), "_")}$d\n"
  }

  /** An empty file never rotates; otherwise rotate when the line would pass [max]. */
  fun shouldRotate(size: Long, add: Long, max: Long): Boolean = size > 0 && size + add > max

  /** `native.log`, `native.1.log`, ... newest first. */
  fun rotatedNames(base: String, keep: Int): List<String> = listOf("$base.log") + (1 until keep).map { "$base.$it.log" }
}
