package expo.modules.bgwatch

import org.json.JSONArray
import org.json.JSONObject

/*
 * A line-for-line port of mobile/src/logic/watch.ts (state machine, notification content) and
 * the bits of logic/banner.ts it uses (signalOf, transition, nextSignal, the settle window,
 * failedText). The jest tests in src/logic/watch.test.ts are the specification: change one
 * side, change the other. No Android types here, only org.json; time comes in as `now` (ms).
 */

/** banner.ts Signal. `finishAt`: when it left `running` for a quiet state not yet announced. */
data class Signal(
  val needs: String?,
  val status: String,
  val running: Boolean? = null,
  val stopped: Boolean? = null,
  val failed: String? = null,
  val live: Boolean = false,
  val finishAt: Long? = null,
)

data class WatchSession(
  val id: String,
  val projectId: String,
  val project: String,
  val name: String,
  val branch: String?,
  val silo: Boolean,
  val status: String,
  val needs: String?,
  val needsText: String?,
  val running: Boolean = false,
  val stopped: Boolean = false,
  val failed: String? = null,
)

data class WatchItem(
  val id: String,
  val sessionId: String,
  /** "ask" | "permission" */
  val kind: String,
  val isPrivate: Boolean,
  val question: String,
  val toolName: String,
  val summary: String,
  val silent: Boolean = false,
)

data class Target(val sessionId: String, val projectId: String, val name: String, val branch: String?)

data class WatchNotification(
  val key: String,
  /** "needs" | "finished" | "status" */
  val channel: String,
  val title: String,
  val subtitle: String?,
  val body: String,
  val target: Target?,
) {
  val signature: String get() = listOf(channel, title, subtitle, body, target?.sessionId).toString()
}

data class WatchPrefs(
  val question: Boolean,
  val permission: Boolean,
  val finished: Boolean,
  val failed: Boolean = false,
  val stopped: Boolean = false,
  val unreachable: Boolean = false,
)

/** banner.ts FINISH_SETTLE_MS: a finish is announced after this long quiet (see banner.ts for why). */
const val FINISH_SETTLE_MS = 20_000L

/** watch.ts UNREACHABLE_MS */
const val UNREACHABLE_MS = 10 * 60_000L

/** banner.ts quiet() */
internal fun quiet(s: Signal): Boolean = s.needs == null && s.status != "running" && s.stopped != true && s.failed.isNullOrEmpty()

/** banner.ts transition(): null on first sight; else needs > failed > stopped > finished. */
internal fun transition(prev: Signal?, next: Signal): String? {
  if (prev == null) return null
  if (next.needs != null && prev.needs == null) return next.needs
  if (!next.failed.isNullOrEmpty() && prev.failed.isNullOrEmpty()) return "failed"
  if (next.stopped == true && prev.stopped == false && prev.live) return "stopped"
  if (next.needs == null && next.failed.isNullOrEmpty() && next.stopped != true &&
    prev.status == "running" && (next.status == "done" || next.status == "idle")
  ) return "finished"
  return null
}

/** banner.ts nextSignal(): carry live and a settling finish forward. */
internal fun nextSignal(prev: Signal?, sig: Signal, now: Long): Signal {
  val live = if (sig.running == true && sig.stopped != true) true else if (sig.stopped == true) false else (prev?.live ?: false)
  var finishAt = prev?.finishAt
  if (finishAt == null && transition(prev, sig) == "finished") finishAt = now
  return Signal(sig.needs, sig.status, sig.running, sig.stopped, sig.failed, live, if (finishAt != null && quiet(sig)) finishAt else null)
}

/** banner.ts settled() */
internal fun settled(s: Signal?, now: Long): Boolean =
  s?.finishAt != null && quiet(s) && now - s.finishAt >= FINISH_SETTLE_MS

class WatchRules(private val seen: Set<String>, initialSignals: Map<String, Signal>) {
  private var sessions: Map<String, WatchSession>? = null
  private var signals: LinkedHashMap<String, Signal> = LinkedHashMap(initialSignals)
  private val items = LinkedHashMap<String, WatchItem>()
  private var alerts = LinkedHashMap<String, String>()
  private var finished = LinkedHashSet<String>()
  private var failed = LinkedHashMap<String, String>()
  private var stopped = LinkedHashSet<String>()
  /** general chats' titles, from `rootChats` */
  private var chatTitles: Map<String, String> = emptyMap()
  /** general chats whose reply finished while watching -> the notification body */
  private val chatsDone = LinkedHashMap<String, String>()
  /** when the link went down, null while it is up */
  private var lostSince: Long? = null
  private var unreachable = false
  /** the phone has a VPN (Tailscale) up */
  private var tunnel = true

  fun onChats(list: Map<String, String>) {
    chatTitles = list
  }

  /** watch.ts "chatEvent": `done` announces a finished reply (once per turn; `item` never
   * does), `error` (the turn failed or the agent crashed) announces the failure, `user` (a new
   * turn) clears either. */
  fun onChatEvent(event: String, chatId: String, result: String?, isError: Boolean) {
    when (event) {
      "done" -> chatsDone[chatId] = chatPreview(result, isError)
      "error" -> chatsDone[chatId] = CHAT_FAILED
      "user" -> chatsDone.remove(chatId)
    }
  }

  fun onProjects(list: List<WatchSession>, now: Long) {
    val nextSessions = LinkedHashMap<String, WatchSession>()
    val nextSignals = LinkedHashMap<String, Signal>()
    val withItem = items.values.map { it.sessionId }.toHashSet()
    val nextAlerts = LinkedHashMap<String, String>()
    val nextFinished = LinkedHashSet<String>()
    val nextFailed = LinkedHashMap<String, String>()
    val nextStopped = LinkedHashSet<String>()
    for (x in list) {
      nextSessions[x.id] = x
      val prev = signals[x.id]
      var sig = nextSignal(prev, Signal(x.needs, x.status, x.running, x.stopped, x.failed), now)
      if (x.id in withItem) sig = sig.copy(finishAt = null)
      nextSignals[x.id] = sig
      val kind = transition(prev, sig)
      val carried = alerts[x.id]
      if (carried != null && sig.needs != null) nextAlerts[x.id] = carried
      if (x.id in finished && sig.needs == null && sig.status != "running") nextFinished.add(x.id)
      val carriedFail = failed[x.id]
      if (carriedFail != null && !sig.failed.isNullOrEmpty()) nextFailed[x.id] = carriedFail
      if (x.id in stopped && sig.stopped == true) nextStopped.add(x.id)
      if (kind == "question" || kind == "permission") nextAlerts[x.id] = kind
      if (kind == "failed") nextFailed[x.id] = x.failed ?: ""
      if (kind == "stopped") nextStopped.add(x.id)
      // "finished" only starts settling here (sig.finishAt); settle() announces it
    }
    sessions = nextSessions
    signals = nextSignals
    alerts = nextAlerts
    finished = nextFinished
    failed = nextFailed
    stopped = nextStopped
    settle(now)
  }

  /** watch.ts "tick" */
  fun onTick(now: Long) = settle(now)

  /** watch.ts "link": "watching" = up, anything else = down */
  fun onLink(phase: String, now: Long) {
    if (phase == "watching") {
      lostSince = null
      unreachable = false
      return
    }
    if (lostSince == null) {
      lostSince = now
      unreachable = false
    }
    settle(now)
  }

  /** watch.ts "network" */
  fun onNetwork(tunnelUp: Boolean) {
    tunnel = tunnelUp
  }

  /** watch.ts nextWakeAt(): when a tick is next due, or null */
  fun nextWakeAt(): Long? {
    var at: Long? = null
    fun take(t: Long) {
      if (at == null || t < at!!) at = t
    }
    val lost = lostSince
    if (lost == null) {
      if (sessions != null) for (sig in signals.values) sig.finishAt?.let { take(it + FINISH_SETTLE_MS) }
    } else if (!unreachable) {
      take(lost + UNREACHABLE_MS)
    }
    return at
  }

  /** watch.ts settle() */
  private fun settle(now: Long) {
    val sessions = this.sessions
    if (lostSince == null && sessions != null) {
      for ((sid, sig) in signals.entries) {
        if (!sessions.containsKey(sid) || !settled(sig, now)) continue
        signals[sid] = sig.copy(finishAt = null)
        finished.add(sid)
      }
    }
    val lost = lostSince
    if (lost != null && !unreachable && now - lost >= UNREACHABLE_MS) unreachable = true
  }

  fun onSnapshot(list: List<WatchItem>) {
    val ids = list.map { it.id }.toSet()
    items.keys.retainAll(ids)
    for (it in list) add(it)
  }

  fun onAdded(item: WatchItem) = add(item)

  fun onResolved(id: String) {
    items.remove(id)
  }

  private fun add(item: WatchItem) {
    if (items.containsKey(item.id)) return
    val kind = if (item.kind == "ask") "question" else "permission"
    items[item.id] = item.copy(silent = item.id in seen)
    // a session holding a question has not finished (agy reads `idle` at its permission menu)
    val prev = signals[item.sessionId]
    signals[item.sessionId] = (prev?.copy(finishAt = null) ?: Signal(null, "needsInput")).copy(needs = prev?.needs ?: kind, status = "needsInput")
  }

  fun desired(prefs: WatchPrefs): List<WatchNotification> {
    val sessions = this.sessions ?: return emptyList()
    val out = ArrayList<WatchNotification>()
    val withItem = HashSet<String>()
    for (it in items.values) {
      withItem.add(it.sessionId)
      if (it.silent) continue
      val isAsk = it.kind == "ask"
      if (if (isAsk) !prefs.question else !prefs.permission) continue
      val session = sessions[it.sessionId]
      val priv = it.isPrivate || session?.silo == true
      val body = if (isAsk) it.question.trim().ifEmpty { "Asks you a question" } else permissionBody(it.toolName, it.summary)
      out.add(made("item:${it.id}", "needs", session, priv, body, PRIVATE_NEEDS))
    }
    for ((sid, kind) in alerts) {
      if (sid in withItem) continue
      if (if (kind == "question") !prefs.question else !prefs.permission) continue
      val session = sessions[sid]
      val body = if (kind == "question") session?.needsText?.trim()?.ifEmpty { null } ?: "Asks you a question" else "Needs your input"
      out.add(made("needs:$sid", "needs", session, session?.silo == true, body, PRIVATE_NEEDS))
    }
    if (prefs.failed) {
      for ((sid, kind) in failed) {
        val session = sessions[sid]
        out.add(made("failed:$sid", "needs", session, session?.silo == true, failedText(kind), PRIVATE_FAILED))
      }
    }
    if (prefs.stopped) {
      for (sid in stopped) {
        val session = sessions[sid]
        out.add(made("stopped:$sid", "status", session, session?.silo == true, STOPPED_BODY, PRIVATE_STOPPED))
      }
    }
    if (prefs.finished) {
      for (sid in finished) {
        val session = sessions[sid]
        out.add(made("done:$sid", "finished", session, session?.silo == true, "Finished", PRIVATE_FINISHED))
      }
    }
    for ((chatId, body) in chatsDone) {
      // a failed reply is a failure (its own switch); a good one is a finish
      if (if (body == CHAT_FAILED) !prefs.failed else !prefs.finished) continue
      val title = chatTitles[chatId]?.trim()?.ifEmpty { null } ?: CHAT_DEFAULT_TITLE
      out.add(
        WatchNotification(
          "chat:$chatId",
          "finished",
          title,
          "Chats",
          body.ifEmpty { CHAT_REPLIED },
          Target("$CHAT_TARGET_PREFIX$chatId", "", title, null),
        ),
      )
    }
    // only with a tunnel up: with Tailscale switched off on purpose the computer is unreachable by design
    if (prefs.unreachable && unreachable && tunnel) {
      out.add(WatchNotification(UNREACHABLE_KEY, "status", APP_TITLE, null, UNREACHABLE_BODY, null))
    }
    return out
  }

  companion object {
    const val APP_TITLE = "Conduit"
    const val PRIVATE_NEEDS = "A private session needs you"
    const val PRIVATE_FINISHED = "A private session finished"
    const val PRIVATE_FAILED = "A private session failed"
    const val PRIVATE_STOPPED = "A private session stopped"
    const val PUBLIC_NEEDS = "An agent needs you"
    const val PUBLIC_FINISHED = "An agent finished"
    const val PUBLIC_STATUS = "An update from your computer"
    const val STOPPED_BODY = "Stopped"
    const val UNREACHABLE_KEY = "unreachable"
    const val UNREACHABLE_BODY = "Can't reach your computer for 10 minutes. Nothing from it will arrive until it's back."
    const val CHAT_REPLIED = "Replied"
    const val CHAT_FAILED = "The reply failed"
    const val CHAT_DEFAULT_TITLE = "Chat"
    const val CHAT_PREVIEW_MAX = 140
    const val CHAT_TARGET_PREFIX = "chat:"

    /** watch.ts chatPreview: the reply's start (whitespace folded, capped), else a plain line. */
    fun chatPreview(result: String?, isError: Boolean): String {
      if (isError) return CHAT_FAILED
      val t = (result ?: "").replace(Regex("\\s+"), " ").trim()
      if (t.isEmpty()) return CHAT_REPLIED
      return if (t.length > CHAT_PREVIEW_MAX) t.take(CHAT_PREVIEW_MAX - 1).trimEnd() + "…" else t
    }

    private val FAILED_WORDS = mapOf(
      "rate_limit" to "rate limit",
      "overloaded" to "the API is overloaded",
      "authentication_failed" to "sign-in failed",
      "oauth_org_not_allowed" to "sign-in not allowed",
      "account_on_hold" to "account on hold",
      "verification_required" to "verification required",
      "billing_error" to "billing problem",
      "invalid_request" to "invalid request",
      "model_not_found" to "model not found",
      "server_error" to "API server error",
      "max_output_tokens" to "hit the output limit",
      "cloud_credential_error" to "cloud credentials",
    )

    /** banner.ts failedText */
    fun failedText(kind: String?): String {
      val k = (kind ?: "").trim()
      val words = FAILED_WORDS[k] ?: if (k.isNotEmpty() && k != "unknown" && k != "error") k.replace('_', ' ') else ""
      return if (words.isNotEmpty()) "Stopped on an error: $words" else "Stopped on an error"
    }

    /** `rootChats` frame -> id to title. */
    fun chatTitlesOf(frame: JSONObject): Map<String, String> {
      val out = HashMap<String, String>()
      val a = frame.optJSONArray("chats") ?: return out
      for (i in 0 until a.length()) {
        val c = a.optJSONObject(i) ?: continue
        val id = c.str("id") ?: continue
        out[id] = c.str("title") ?: ""
      }
      return out
    }

    private val SHELL_TOOLS = Regex("^(bash|powershell|shell|run_command|run_shell_command|exec|command)$", RegexOption.IGNORE_CASE)

    fun permissionBody(toolName: String, summary: String): String {
      val tool = toolName.trim()
      val what = summary.trim()
      if (what.isEmpty() || what == tool) return if (tool.isNotEmpty()) "Wants to use $tool" else "Needs your permission"
      if (tool.isEmpty() || SHELL_TOOLS.matches(tool)) return "Wants to run: $what"
      return "Wants to use $tool: $what"
    }

    private fun made(key: String, channel: String, session: WatchSession?, isPrivate: Boolean, body: String, privateBody: String): WatchNotification {
      if (isPrivate) return WatchNotification(key, channel, APP_TITLE, null, privateBody, null)
      if (session == null) return WatchNotification(key, channel, APP_TITLE, null, body, null)
      return WatchNotification(
        key,
        channel,
        session.name.ifEmpty { APP_TITLE },
        session.project.ifEmpty { null },
        body,
        Target(session.id, session.projectId, session.name, session.branch),
      )
    }

    // ---- frame parsing (watchSessionsOf / fromWire + watchItemOf) ----

    private fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k)

    private fun JSONObject.boolOrNull(k: String): Boolean? = if (has(k) && !isNull(k)) optBoolean(k) else null

    fun sessionsOf(frame: JSONObject): List<WatchSession> {
      val out = ArrayList<WatchSession>()
      val projects = frame.optJSONArray("projects") ?: return out
      for (i in 0 until projects.length()) {
        val p = projects.optJSONObject(i) ?: continue
        val pid = p.str("id") ?: continue
        val pname = p.str("name") ?: ""
        val list = p.optJSONArray("sessions") ?: continue
        for (j in 0 until list.length()) {
          val s = list.optJSONObject(j) ?: continue
          val id = s.str("id") ?: continue
          val status = s.str("status") ?: "idle"
          val needsObj = s.optJSONObject("needs")
          val needsKind = needsObj?.str("kind")
          // banner.ts signalOf
          val needs = when {
            needsKind == "ask" -> "question"
            needsObj != null || status == "needsInput" -> "permission"
            else -> null
          }
          out.add(
            WatchSession(
              id = id,
              projectId = pid,
              project = pname,
              name = s.str("name") ?: "",
              branch = s.str("branch")?.ifEmpty { null },
              silo = s.optBoolean("silo", false),
              status = status,
              needs = needs,
              needsText = if (needsKind == "ask") needsObj?.str("text") else null,
              running = s.optBoolean("running", false),
              stopped = s.optBoolean("stopped", false),
              failed = s.str("failed")?.ifEmpty { null },
            ),
          )
        }
      }
      return out
    }

    fun itemOf(o: JSONObject): WatchItem? {
      val id = o.str("id") ?: return null
      val sid = o.str("sessionId") ?: return null
      val kind = if (o.str("kind") == "permission") "permission" else "ask"
      if (o.optBoolean("private", false)) return WatchItem(id, sid, kind, true, "", "", "")
      if (kind == "permission") return WatchItem(id, sid, kind, false, "", o.str("toolName") ?: "", o.str("summary") ?: "")
      val q = o.optJSONArray("questions")?.optJSONObject(0)?.str("question") ?: ""
      return WatchItem(id, sid, kind, false, q, "", "")
    }

    fun itemsOf(a: JSONArray?): List<WatchItem> {
      if (a == null) return emptyList()
      return (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { itemOf(it) } }
    }

    /** The app's baseline (`watchBaseline` as JSON):
     * `{seen: string[], signals: {id: {needs, status, running?, stopped?, failed?, live?}}}`. */
    /**
     * watch.ts `watchBaseline` + `baselineSignals`. A finish the app was still settling arrives
     * as its age (`finishAgoMs`), because the app's clock and [now]'s (elapsedRealtime) do not
     * share an origin; it lands as `finishAt = now - age`, and only on a session that is quiet.
     */
    fun baselineOf(json: String, now: Long): Pair<Set<String>, Map<String, Signal>> {
      val o = runCatching { JSONObject(json) }.getOrNull() ?: return emptySet<String>() to emptyMap()
      val seen = HashSet<String>()
      o.optJSONArray("seen")?.let { a -> for (i in 0 until a.length()) a.optString(i, "").takeIf { it.isNotEmpty() }?.let(seen::add) }
      val signals = LinkedHashMap<String, Signal>()
      o.optJSONObject("signals")?.let { m ->
        for (k in m.keys()) {
          val s = m.optJSONObject(k) ?: continue
          val sig = Signal(
            needs = s.str("needs"),
            status = s.str("status") ?: "idle",
            running = s.boolOrNull("running"),
            stopped = s.boolOrNull("stopped"),
            failed = s.str("failed")?.ifEmpty { null },
            live = s.optBoolean("live", false),
          )
          val ago = if (s.has("finishAgoMs") && !s.isNull("finishAgoMs")) s.optLong("finishAgoMs", -1L) else -1L
          signals[k] = if (ago >= 0 && quiet(sig)) sig.copy(finishAt = now - ago) else sig
        }
      }
      return seen to signals
    }
  }
}
