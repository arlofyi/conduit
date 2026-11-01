package expo.modules.bgwatch

import org.json.JSONArray
import org.json.JSONObject

/*
 * A line-for-line port of mobile/src/logic/watch.ts (state machine, notification content) and
 * the bits of logic/banner.ts it uses (signalOf, transition). The jest tests in
 * src/logic/watch.test.ts are the specification: change one side, change the other.
 * No Android types here, only org.json.
 */

data class Signal(val needs: String?, val status: String)

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
  /** "needs" | "finished" */
  val channel: String,
  val title: String,
  val subtitle: String?,
  val body: String,
  val target: Target?,
) {
  val signature: String get() = listOf(channel, title, subtitle, body, target?.sessionId).toString()
}

data class WatchPrefs(val question: Boolean, val permission: Boolean, val finished: Boolean)

/** banner.ts transition(): null on first sight, a needs kind on entering needs, "finished" on running -> done/idle. */
internal fun transition(prev: Signal?, next: Signal): String? {
  if (prev == null) return null
  if (next.needs != null && prev.needs == null) return next.needs
  if (next.needs == null && prev.status == "running" && (next.status == "done" || next.status == "idle")) return "finished"
  return null
}

class WatchRules(private val seen: Set<String>, initialSignals: Map<String, Signal>) {
  private var sessions: Map<String, WatchSession>? = null
  private var signals: MutableMap<String, Signal> = initialSignals.toMutableMap()
  private val items = LinkedHashMap<String, WatchItem>()
  private var alerts = LinkedHashMap<String, String>()
  private var finished = LinkedHashSet<String>()

  fun onProjects(list: List<WatchSession>) {
    val nextSessions = LinkedHashMap<String, WatchSession>()
    val nextSignals = HashMap<String, Signal>()
    val nextAlerts = LinkedHashMap<String, String>()
    val nextFinished = LinkedHashSet<String>()
    for (x in list) {
      nextSessions[x.id] = x
      val sig = Signal(x.needs, x.status)
      nextSignals[x.id] = sig
      val kind = transition(signals[x.id], sig)
      val carried = alerts[x.id]
      if (carried != null && sig.needs != null) nextAlerts[x.id] = carried
      if (x.id in finished && sig.needs == null && sig.status != "running") nextFinished.add(x.id)
      if (kind == "question" || kind == "permission") nextAlerts[x.id] = kind
      if (kind == "finished") nextFinished.add(x.id)
    }
    sessions = nextSessions
    signals = nextSignals
    alerts = nextAlerts
    finished = nextFinished
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
    signals[item.sessionId] = Signal(signals[item.sessionId]?.needs ?: kind, "needsInput")
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
      out.add(made("item:${it.id}", "needs", session, priv, body))
    }
    for ((sid, kind) in alerts) {
      if (sid in withItem) continue
      if (if (kind == "question") !prefs.question else !prefs.permission) continue
      val session = sessions[sid]
      val body = if (kind == "question") session?.needsText?.trim()?.ifEmpty { null } ?: "Asks you a question" else "Needs your input"
      out.add(made("needs:$sid", "needs", session, session?.silo == true, body))
    }
    if (prefs.finished) {
      for (sid in finished) {
        val session = sessions[sid]
        out.add(made("done:$sid", "finished", session, session?.silo == true, "Finished"))
      }
    }
    return out
  }

  companion object {
    const val APP_TITLE = "Conduit"
    const val PRIVATE_NEEDS = "A private session needs you"
    const val PRIVATE_FINISHED = "A private session finished"
    const val PUBLIC_NEEDS = "An agent needs you"
    const val PUBLIC_FINISHED = "An agent finished"

    private val SHELL_TOOLS = Regex("^(bash|powershell|shell|run_command|run_shell_command|exec|command)$", RegexOption.IGNORE_CASE)

    fun permissionBody(toolName: String, summary: String): String {
      val tool = toolName.trim()
      val what = summary.trim()
      if (what.isEmpty() || what == tool) return if (tool.isNotEmpty()) "Wants to use $tool" else "Needs your permission"
      if (tool.isEmpty() || SHELL_TOOLS.matches(tool)) return "Wants to run: $what"
      return "Wants to use $tool: $what"
    }

    private fun made(key: String, channel: String, session: WatchSession?, isPrivate: Boolean, body: String): WatchNotification {
      if (isPrivate) {
        val text = if (channel == "needs") PRIVATE_NEEDS else PRIVATE_FINISHED
        return WatchNotification(key, channel, APP_TITLE, null, text, null)
      }
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

    /** The app's baseline (`watchBaseline` as JSON): `{seen: string[], signals: {id: {needs, status}}}`. */
    fun baselineOf(json: String): Pair<Set<String>, Map<String, Signal>> {
      val o = runCatching { JSONObject(json) }.getOrNull() ?: return emptySet<String>() to emptyMap()
      val seen = HashSet<String>()
      o.optJSONArray("seen")?.let { a -> for (i in 0 until a.length()) a.optString(i, "").takeIf { it.isNotEmpty() }?.let(seen::add) }
      val signals = HashMap<String, Signal>()
      o.optJSONObject("signals")?.let { m ->
        for (k in m.keys()) {
          val s = m.optJSONObject(k) ?: continue
          signals[k] = Signal(s.str("needs"), s.str("status") ?: "idle")
        }
      }
      return seen to signals
    }
  }
}
