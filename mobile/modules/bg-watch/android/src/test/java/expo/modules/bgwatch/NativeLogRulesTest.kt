package expo.modules.bgwatch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * NativeLogRules is a port of mobile/src/logic/diagLog.ts; these cases mirror diagLog.test.ts so
 * the app's log and the services' log scrub the same things.
 */
class NativeLogRulesTest {
  private val token = "kq3V9xZ2mL7pR4tY8wB1nC6dF0gH5jK2sA9eU3iO7"

  @Test fun dropsTokenFromJsonFrame() {
    val out = NativeLogRules.redact("""{"type":"auth","token":"$token"}""")
    assertFalse(out.contains(token))
    assertTrue(out.contains(""""token":"<redacted>""""))
    assertTrue(out.contains(""""type":"auth""""))
  }

  @Test fun dropsSecretsUnderAnyKeySpelling() {
    for (k in listOf("secret", "pairSecret", "deviceToken", "nonce", "apiKey", "password")) {
      assertFalse(NativeLogRules.redact("""{"$k": "short-value"}""").contains("short-value"))
    }
  }

  @Test fun dropsKeyValueAndBearer() {
    assertEquals("GET /x?token=<redacted>&port=8455", NativeLogRules.redact("GET /x?token=abc123&port=8455"))
    assertFalse(NativeLogRules.redact("Authorization: Bearer abc.def.ghi").contains("abc.def.ghi"))
    assertEquals("secret: <redacted>", NativeLogRules.redact("secret: hunter2"))
  }

  @Test fun keepsHostAndPortOnly() {
    assertEquals("dial ws://100.64.0.7:8455 failed", NativeLogRules.redact("dial ws://me:pw@100.64.0.7:8455/ws?token=zzz failed"))
    assertEquals("https://mac.tailnet.ts.net:8455", NativeLogRules.redact("https://mac.tailnet.ts.net:8455/a/b"))
  }

  @Test fun hidesUserUrisAndPaths() {
    assertEquals("Couldn't read <uri>", NativeLogRules.redact("Couldn't read file:///data/user/0/x/cache/a/secret-plan.pdf"))
    assertEquals("ENOENT <path>", NativeLogRules.redact("ENOENT /Users/me/work/plan/notes.md"))
    assertEquals("denied <path> here", NativeLogRules.redact("denied C:\\Users\\me\\proj\\a.txt here"))
    // an OkHttp connect failure keeps the address it could not reach
    assertEquals(
      "Failed to connect to /100.64.0.7:8455",
      NativeLogRules.redact("Failed to connect to /100.64.0.7:8455"),
    )
  }

  @Test fun removesLongOpaqueRuns() {
    assertEquals("refused <redacted> now", NativeLogRules.redact("refused $token now"))
    assertEquals("the system refused to start the watcher", NativeLogRules.redact("the system refused to start the watcher"))
  }

  @Test fun cleanFoldsAndCaps() {
    val d = NativeLogRules.clean("a\nb\r\n c " + "word ".repeat(400))
    assertTrue(d.startsWith("a | b | c"))
    assertEquals(NativeLogRules.MAX_DETAIL, d.length)
    assertTrue(d.endsWith("…"))
  }

  @Test fun describeNamesClassAndMessage() {
    assertEquals("IllegalStateException: bad token=<redacted>", NativeLogRules.describe(IllegalStateException("bad token=$token")))
    assertTrue(NativeLogRules.describe(RuntimeException("x"), 2).startsWith("RuntimeException: x @ "))
  }

  @Test fun lineFormatMatchesTheApp() {
    // Date.UTC(2026, 10, 1, 9, 30) in diagLog.test.ts
    val at = 1793525400000L
    assertEquals(
      "2026-11-01T09:30:00.000Z ERROR bgwatch link.failed: closed | again\n",
      NativeLogRules.line(at, "error", "bgwatch", "link.failed", "closed\nagain"),
    )
    assertEquals("1970-01-01T00:00:00.000Z INFO  app start\n", NativeLogRules.line(0, "info", "app", "start", null))
  }

  @Test fun rotation() {
    assertEquals(listOf("native.log", "native.1.log"), NativeLogRules.rotatedNames("native", 2))
    assertFalse(NativeLogRules.shouldRotate(0, 10_000, 100))
    assertFalse(NativeLogRules.shouldRotate(90, 10, 100))
    assertTrue(NativeLogRules.shouldRotate(90, 11, 100))
  }
}
