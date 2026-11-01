package expo.modules.bgwatch

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * WatchRules is a port of mobile/src/logic/watch.ts, and src/logic/watch.test.ts is its
 * specification. These cases mirror that file's, name for name where one exists, so a rule
 * changed on one side and not the other fails here.
 */
class WatchRulesTest {
  private val all = WatchPrefs(question = true, permission = true, finished = true, failed = true, stopped = true, unreachable = true)

  /** frames at t=0 unless a test says otherwise (watch.test.ts `projects`) */
  private fun WatchRules.onProjects(list: List<WatchSession>) = onProjects(list, 0L)

  /** time enough for a finish seen at 0 to settle (watch.test.ts `settleTick`) */
  private fun WatchRules.settle() = onTick(FINISH_SETTLE_MS)

  /** a projects-view session, as the bridge sends it (frames go through sessionsOf, as live) */
  private fun sess(
    id: String,
    status: String = "idle",
    name: String = "name-$id",
    silo: Boolean = false,
    needs: JSONObject? = null,
    running: Boolean = true,
    stopped: Boolean = false,
    failed: String? = null,
  ): JSONObject = JSONObject()
    .put("running", running)
    .put("stopped", stopped)
    .put("failed", failed ?: JSONObject.NULL)
    .put("id", id)
    .put("name", name)
    .put("agent", "claude")
    .put("branch", JSONObject.NULL)
    .put("silo", silo)
    .put("status", status)
    .put("needs", needs ?: JSONObject.NULL)

  private fun needs(kind: String, text: String? = null): JSONObject =
    JSONObject().put("kind", kind).put("text", text ?: JSONObject.NULL)

  private fun projects(vararg sessions: JSONObject): List<WatchSession> {
    val p = JSONObject().put("id", "p").put("name", "conduit").put("sessions", JSONArray(sessions.toList()))
    return WatchRules.sessionsOf(JSONObject().put("type", "projects").put("projects", JSONArray().put(p)))
  }

  private fun ask(id: String, sessionId: String, question: String = "Which db?") =
    WatchItem(id, sessionId, "ask", false, question, "", "")

  private fun perm(id: String, sessionId: String, toolName: String = "Bash", summary: String = "npm test") =
    WatchItem(id, sessionId, "permission", false, "", toolName, summary)

  private fun rules(seen: Set<String> = emptySet(), signals: Map<String, Signal> = emptyMap()) = WatchRules(seen, signals)

  private val running = Signal(null, "running", running = true, stopped = false, live = true)

  private fun WatchRules.keys(prefs: WatchPrefs = all) = desired(prefs).map { it.key }

  @Test
  fun posts_nothing_until_names_are_known_then_announces_a_new_item() {
    val r = rules()
    r.onSnapshot(listOf(perm("1", "a")))
    assertEquals(emptyList<String>(), r.keys())
    r.onProjects(projects(sess("a", status = "needsInput")))
    val n = r.desired(all).single()
    assertEquals("item:1", n.key)
    assertEquals("needs", n.channel)
    assertEquals("name-a", n.title)
    assertEquals("conduit", n.subtitle)
    assertEquals("Wants to run: npm test", n.body)
    assertEquals(Target("a", "p", "name-a", null), n.target)
  }

  @Test
  fun an_item_the_app_already_showed_is_not_announced_again() {
    val r = rules(seen = setOf("1"))
    r.onProjects(projects(sess("a")))
    r.onSnapshot(listOf(ask("1", "a"), ask("2", "a")))
    assertEquals(listOf("item:2"), r.keys())
  }

  @Test
  fun resolved_or_missing_from_a_later_snapshot_cancels() {
    val r = rules()
    r.onProjects(projects(sess("a")))
    r.onAdded(ask("1", "a"))
    r.onAdded(ask("2", "a"))
    assertEquals(listOf("item:1", "item:2"), r.keys())
    r.onResolved("1")
    assertEquals(listOf("item:2"), r.keys())
    r.onSnapshot(emptyList())
    assertEquals(emptyList<String>(), r.keys())
  }

  @Test
  fun a_question_reads_as_the_question() {
    val r = rules()
    r.onProjects(projects(sess("a")))
    r.onAdded(ask("1", "a", " Postgres or SQLite? "))
    assertEquals("Postgres or SQLite?", r.desired(all)[0].body)
    val blank = rules()
    blank.onProjects(projects(sess("a")))
    blank.onAdded(ask("1", "a", ""))
    assertEquals("Asks you a question", blank.desired(all)[0].body)
  }

  @Test
  fun private_items_and_silo_sessions_say_nothing_and_open_nothing() {
    var r = rules()
    r.onProjects(projects(sess("a", silo = true)))
    r.onAdded(WatchItem("1", "a", "permission", true, "", "", ""))
    val n = r.desired(all)[0]
    assertEquals("Conduit", n.title)
    assertNull(n.subtitle)
    assertEquals(WatchRules.PRIVATE_NEEDS, n.body)
    assertNull(n.target)
    // a silo session's item, even one carrying detail, is redacted too
    r = rules()
    r.onProjects(projects(sess("a", silo = true)))
    r.onAdded(perm("1", "a"))
    assertEquals(WatchRules.PRIVATE_NEEDS, r.desired(all)[0].body)
    r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", silo = true, status = "done")))
    r.settle()
    val done = r.desired(all)[0]
    assertEquals("done:a", done.key)
    assertEquals(WatchRules.PRIVATE_FINISHED, done.body)
    assertNull(done.target)
  }

  @Test
  fun finished_follows_the_banner_rule_and_clears_when_it_runs_again() {
    val r = rules()
    // first sight is not a transition
    r.onProjects(projects(sess("a", status = "done")))
    assertEquals(emptyList<String>(), r.keys())
    r.onProjects(projects(sess("a", status = "running")))
    r.onProjects(projects(sess("a", status = "done")))
    r.settle()
    val n = r.desired(all)[0]
    assertEquals("done:a", n.key)
    assertEquals("finished", n.channel)
    assertEquals("Finished", n.body)
    // a later identical view keeps it; running again drops it
    r.onProjects(projects(sess("a", status = "idle")))
    assertEquals(listOf("done:a"), r.keys())
    r.onProjects(projects(sess("a", status = "running")))
    assertEquals(emptyList<String>(), r.keys())
  }

  @Test
  fun the_baseline_from_the_app_catches_a_turn_that_ended_during_the_hand_over() {
    val (seen, signals) = WatchRules.baselineOf("""{"seen":[],"signals":{"a":{"needs":null,"status":"running"}}}""", 0L)
    val r = WatchRules(seen, signals)
    r.onProjects(projects(sess("a", status = "done")))
    r.settle()
    assertEquals(listOf("done:a"), r.keys())
  }

  @Test
  fun a_view_only_needs_alert_is_for_agents_that_hold_nothing() {
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", status = "needsInput", needs = needs("input"))))
    val n = r.desired(all)[0]
    assertEquals("needs:a", n.key)
    assertEquals("Needs your input", n.body)
    // a held item for that session replaces the generic alert
    r.onAdded(perm("9", "a"))
    assertEquals(listOf("item:9"), r.keys())
    // needs cleared: the alert goes
    r.onResolved("9")
    r.onProjects(projects(sess("a", status = "running")))
    assertEquals(emptyList<String>(), r.keys())
  }

  @Test
  fun an_item_first_then_the_view_showing_it_raises_one_notification() {
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", status = "running")))
    r.onAdded(ask("1", "a"))
    r.onProjects(projects(sess("a", status = "needsInput", needs = needs("ask", "Which db?"))))
    r.onResolved("1")
    // answered on the computer before the view caught up: nothing left
    assertEquals(emptyList<String>(), r.keys())
  }

  @Test
  fun switches_gate_each_kind() {
    val r = rules(signals = mapOf("c" to running))
    r.onProjects(projects(sess("a"), sess("b"), sess("c", status = "done")))
    r.onAdded(ask("1", "a"))
    r.onAdded(perm("2", "b"))
    r.settle()
    assertEquals(listOf("item:1", "item:2", "done:c"), r.keys())
    assertEquals(listOf("item:2", "done:c"), r.keys(all.copy(question = false)))
    assertEquals(listOf("item:1"), r.keys(all.copy(permission = false, finished = false)))
  }

  @Test
  fun a_session_gone_from_the_view_drops_its_alerts() {
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", status = "done")))
    r.settle()
    assertEquals(listOf("done:a"), r.keys())
    r.onProjects(projects())
    assertEquals(emptyList<String>(), r.keys())
  }

  @Test
  fun a_rename_changes_the_signature_so_it_is_reposted() {
    val r = rules()
    r.onProjects(projects(sess("a")))
    r.onAdded(ask("1", "a"))
    val before = r.desired(all)[0].signature
    assertEquals(before, r.desired(all)[0].signature)
    r.onProjects(projects(sess("a", name = "renamed")))
    val after = r.desired(all)[0]
    assertEquals("renamed", after.title)
    assertNotEquals(before, after.signature)
  }

  @Test
  fun permissionBody_names_what_it_wants() {
    assertEquals("Wants to run: rm -rf build", WatchRules.permissionBody("Bash", "rm -rf build"))
    assertEquals("Wants to run: ls", WatchRules.permissionBody("run_command", "ls"))
    assertEquals("Wants to use Edit: src/a.ts", WatchRules.permissionBody("Edit", "src/a.ts"))
    assertEquals("Wants to use WebFetch", WatchRules.permissionBody("WebFetch", "WebFetch"))
    assertEquals("Needs your permission", WatchRules.permissionBody("", ""))
  }

  @Test
  fun pending_items_reduce_to_what_a_notification_can_say() {
    val priv = WatchRules.itemOf(JSONObject("""{"kind":"permission","id":"1","sessionId":"a","private":true,"toolName":"Bash","summary":"x"}"""))!!
    assertEquals(true, priv.isPrivate)
    assertEquals("", priv.summary)
    val q = WatchRules.itemOf(
      JSONObject("""{"kind":"ask","id":"1","sessionId":"a","private":false,"questions":[{"question":"Q?","options":[]}]}"""),
    )!!
    assertEquals("Q?", q.question)
  }

  // ---- general chats ----

  @Test
  fun chat_announces_a_finished_reply_with_its_title_and_a_preview_opening_that_chat() {
    val r = rules()
    r.onProjects(projects())
    r.onChats(WatchRules.chatTitlesOf(JSONObject("""{"chats":[{"id":"c1","title":"Plan the week"}]}""")))
    r.onChatEvent("done", "c1", "Here is   the plan.", false)
    assertEquals(
      listOf(
        WatchNotification("chat:c1", "finished", "Plan the week", "Chats", "Here is the plan.", Target("chat:c1", "", "Plan the week", null)),
      ),
      r.desired(all),
    )
  }

  @Test
  fun chat_clears_on_the_next_message_respects_finished_and_names_an_unknown_chat() {
    val r = rules()
    r.onProjects(projects())
    r.onChatEvent("done", "c9", null, false)
    val n = r.desired(all)[0]
    assertEquals("Chat", n.title)
    assertEquals("Replied", n.body)
    assertEquals(emptyList<WatchNotification>(), r.desired(all.copy(finished = false)))
    r.onChatEvent("user", "c9", null, false)
    assertEquals(emptyList<WatchNotification>(), r.desired(all))
  }

  @Test
  fun chat_error_event_announces_the_failure_and_a_new_turn_clears_it() {
    val r = rules()
    r.onProjects(projects())
    r.onChatEvent("error", "c1", null, false)
    assertEquals(listOf("chat:c1"), r.keys())
    assertEquals(WatchRules.CHAT_FAILED, r.desired(all)[0].body)
    r.onChatEvent("user", "c1", null, false)
    assertEquals(emptyList<String>(), r.keys())
  }

  @Test
  fun chat_previews_trimmed_capped_and_an_error_says_so() {
    assertEquals(140, WatchRules.chatPreview("x".repeat(200), false).length)
    assertEquals("Replied", WatchRules.chatPreview(null, false))
    assertEquals("The reply failed", WatchRules.chatPreview("ok", true))
  }

  @Test
  fun transition_rules() {
    assertNull(transition(null, Signal("question", "needsInput")))
    assertEquals("permission", transition(Signal(null, "running"), Signal("permission", "needsInput")))
    assertNull(transition(Signal("question", "needsInput"), Signal("question", "needsInput")))
    assertEquals("finished", transition(Signal(null, "running"), Signal(null, "done")))
    assertEquals("finished", transition(Signal(null, "running"), Signal(null, "idle")))
    assertNull(transition(Signal(null, "idle"), Signal(null, "done")))
    // failed outranks finished; a stop needs a live, explicitly-not-stopped session before
    assertEquals("failed", transition(Signal(null, "running"), Signal(null, "done", failed = "rate_limit")))
    assertEquals("stopped", transition(Signal(null, "idle", stopped = false, live = true), Signal(null, "idle", stopped = true)))
    assertNull(transition(Signal(null, "idle", live = true), Signal(null, "idle", stopped = true)))
    assertNull(transition(Signal(null, "idle", stopped = false, live = false), Signal(null, "idle", stopped = true)))
  }

  // ---- finished settles (watch.test.ts "finished settles ...") ----

  @Test
  fun a_finish_waits_FINISH_SETTLE_MS_then_posts_once() {
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", status = "done")), 1000L)
    assertEquals(emptyList<String>(), r.keys())
    assertEquals(1000L + FINISH_SETTLE_MS, r.nextWakeAt())
    r.onTick(1000L + FINISH_SETTLE_MS - 1)
    assertEquals(emptyList<String>(), r.keys())
    r.onTick(1000L + FINISH_SETTLE_MS)
    assertEquals(listOf("done:a"), r.keys())
    assertNull(r.nextWakeAt())
    val sig = r.desired(all)[0].signature
    r.onProjects(projects(sess("a", status = "done")), 60_000L)
    r.onTick(90_000L)
    assertEquals(sig, r.desired(all)[0].signature)
  }

  @Test
  fun running_again_inside_the_window_cancels_it_so_a_flapping_turn_posts_nothing() {
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", status = "idle")), 0L)
    r.onProjects(projects(sess("a", status = "running")), 1_000L)
    r.onProjects(projects(sess("a", status = "idle")), 5_000L)
    r.onProjects(projects(sess("a", status = "running")), 6_000L)
    r.onProjects(projects(sess("a", status = "done")), 10_000L)
    r.onProjects(projects(sess("a", status = "running")), 12_000L)
    r.onTick(40_000L)
    assertEquals(emptyList<String>(), r.keys())
    r.onProjects(projects(sess("a", status = "done")), 50_000L)
    r.onTick(50_000L + FINISH_SETTLE_MS)
    assertEquals(listOf("done:a"), r.keys())
  }

  @Test
  fun the_window_counts_from_the_first_quiet_frame_not_the_last() {
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", status = "done")), 0L)
    r.onProjects(projects(sess("a", status = "idle")), 10_000L)
    r.onProjects(projects(sess("a", status = "idle")), FINISH_SETTLE_MS)
    assertEquals(listOf("done:a"), r.keys())
  }

  @Test
  fun a_held_question_or_permission_is_not_a_finish() {
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", status = "idle")), 0L)
    r.onAdded(perm("p1", "a"))
    r.settle()
    assertEquals(listOf("item:p1"), r.keys())
    r.onProjects(projects(sess("a", status = "idle")), 1_000L)
    r.onTick(1_000L + FINISH_SETTLE_MS)
    assertEquals(listOf("item:p1"), r.keys())
  }

  @Test
  fun a_finish_does_not_settle_while_the_link_is_down() {
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", status = "done")), 0L)
    r.onLink("retrying", 1_000L)
    r.settle()
    assertEquals(emptyList<String>(), r.keys())
    r.onLink("watching", 30_000L)
    r.onProjects(projects(sess("a", status = "done")), 30_000L)
    assertEquals(listOf("done:a"), r.keys())
  }

  @Test
  fun general_chat_bubbles_never_notify_only_the_turn_end() {
    val r = rules()
    r.onProjects(projects(sess("a")))
    repeat(5) { r.onChatEvent("item", "c1", null, false) }
    assertEquals(emptyList<String>(), r.keys())
    r.onChatEvent("done", "c1", "ok", false)
    assertEquals(listOf("chat:c1"), r.keys())
  }

  // ---- failed, stopped and unreachable ----

  @Test
  fun a_turn_that_ends_on_an_error_is_failed_not_finished() {
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", status = "done", failed = "rate_limit")))
    r.settle()
    val n = r.desired(all).single()
    assertEquals("failed:a", n.key)
    assertEquals("needs", n.channel)
    assertEquals("Stopped on an error: rate limit", n.body)
    assertEquals("name-a", n.title)
    assertEquals(emptyList<String>(), r.keys(all.copy(failed = false)))
    r.onProjects(projects(sess("a", status = "running")))
    assertEquals(emptyList<String>(), r.keys())
  }

  @Test
  fun a_failure_already_in_place_is_not_news_and_a_private_one_says_nothing() {
    val first = rules()
    first.onProjects(projects(sess("a", status = "done", failed = "x")))
    assertEquals(emptyList<String>(), first.keys())
    val r = rules(signals = mapOf("a" to running))
    r.onProjects(projects(sess("a", silo = true, status = "done", failed = "error")))
    val n = r.desired(all)[0]
    assertEquals("failed:a", n.key)
    assertEquals(WatchRules.PRIVATE_FAILED, n.body)
    assertNull(n.target)
    assertNull(n.subtitle)
  }

  @Test
  fun a_live_session_that_is_stopped_posts_stopped_and_clears_when_started() {
    val r = rules(signals = mapOf("a" to running))
    // stop_session saves the idle status a moment before the stopped flag: two frames
    r.onProjects(projects(sess("a", status = "idle", running = false, stopped = false)))
    r.onProjects(projects(sess("a", status = "idle", running = false, stopped = true)))
    r.settle()
    val n = r.desired(all).single()
    assertEquals("stopped:a", n.key)
    assertEquals("status", n.channel)
    assertEquals("Stopped", n.body)
    assertEquals(emptyList<String>(), r.keys(all.copy(stopped = false)))
    r.onProjects(projects(sess("a", status = "idle", running = true, stopped = false)))
    assertEquals(emptyList<String>(), r.keys())
  }

  @Test
  fun a_session_never_live_is_not_announced_as_stopped_and_private_wording_holds() {
    val parked = rules()
    parked.onProjects(projects(sess("a", running = false, stopped = false)))
    parked.onProjects(projects(sess("a", running = false, stopped = true)))
    assertEquals(emptyList<String>(), parked.keys())
    val priv = rules(signals = mapOf("a" to running))
    priv.onProjects(projects(sess("a", silo = true, running = false, stopped = true)))
    val n = priv.desired(all)[0]
    assertEquals("stopped:a", n.key)
    assertEquals(WatchRules.PRIVATE_STOPPED, n.body)
    assertNull(n.target)
  }

  @Test
  fun unreachable_after_UNREACHABLE_MS_down_with_a_tunnel_once_and_cleared_on_reconnect() {
    val r = rules()
    r.onProjects(projects())
    r.onLink("retrying", 0L)
    assertEquals(UNREACHABLE_MS, r.nextWakeAt())
    r.onTick(UNREACHABLE_MS - 1)
    assertEquals(emptyList<String>(), r.keys())
    r.onLink("connecting", UNREACHABLE_MS - 1)
    r.onTick(UNREACHABLE_MS)
    assertEquals(
      listOf(WatchNotification("unreachable", "status", "Conduit", null, WatchRules.UNREACHABLE_BODY, null)),
      r.desired(all),
    )
    assertNull(r.nextWakeAt())
    assertEquals(emptyList<String>(), r.keys(all.copy(unreachable = false)))
    r.onNetwork(false)
    assertEquals(emptyList<String>(), r.keys())
    r.onNetwork(true)
    r.onLink("watching", UNREACHABLE_MS + 5)
    assertEquals(emptyList<String>(), r.keys())
  }

  @Test
  fun a_failed_general_chat_reply_follows_the_failed_switch() {
    val r = rules()
    r.onProjects(projects())
    r.onChatEvent("error", "c", null, false)
    assertEquals(WatchRules.CHAT_FAILED, r.desired(all.copy(finished = false))[0].body)
    assertEquals(emptyList<String>(), r.keys(all.copy(failed = false)))
  }

  @Test
  fun failedText_names_the_error() {
    assertEquals("Stopped on an error: rate limit", WatchRules.failedText("rate_limit"))
    assertEquals("Stopped on an error: some new kind", WatchRules.failedText("some_new_kind"))
    assertEquals("Stopped on an error", WatchRules.failedText("unknown"))
    assertEquals("Stopped on an error", WatchRules.failedText(null))
  }

  @Test
  fun the_baseline_carries_live_stopped_and_failed() {
    val (_, signals) = WatchRules.baselineOf(
      """{"seen":[],"signals":{"a":{"needs":null,"status":"running","running":true,"stopped":false,"failed":null,"live":true}}}""",
      0L,
    )
    assertEquals(Signal(null, "running", running = true, stopped = false, failed = null, live = true), signals["a"])
  }

  @Test
  fun a_finish_the_app_was_settling_goes_across_with_its_age() {
    // watch.test.ts builds this JSON with watchBaseline (app saw the turn end 5 s earlier)
    val (seen, signals) = WatchRules.baselineOf(
      """{"seen":[],"signals":{"a":{"needs":null,"status":"done","running":true,"stopped":false,"failed":null,"live":true,"finishAgoMs":5000},""" +
        """"r":{"needs":null,"status":"running","running":true,"stopped":false,"failed":null,"live":true}}}""",
      100_000L,
    )
    assertEquals(95_000L, signals["a"]?.finishAt)
    assertNull(signals["r"]?.finishAt)
    val r = WatchRules(seen, signals)
    r.onProjects(projects(sess("a", status = "done")), 100_000L)
    r.onTick(95_000L + FINISH_SETTLE_MS - 1)
    assertEquals(emptyList<String>(), r.keys())
    assertEquals(95_000L + FINISH_SETTLE_MS, r.nextWakeAt())
    r.onTick(95_000L + FINISH_SETTLE_MS)
    assertEquals(listOf("done:a"), r.keys())
  }

  @Test
  fun a_baseline_age_on_a_session_no_longer_quiet_is_dropped() {
    val (_, signals) = WatchRules.baselineOf(
      """{"seen":[],"signals":{"a":{"needs":"question","status":"needsInput","finishAgoMs":3000}}}""",
      50_000L,
    )
    assertNull(signals["a"]?.finishAt)
  }
}
