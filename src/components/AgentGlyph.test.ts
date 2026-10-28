import { describe, it, expect } from "vitest";
import { AGENT_MARKS, glyphStateFor } from "./AgentGlyph";
import { AGENTS } from "../agents";

// Node-env only: this imports the module for its two pure exports and never renders the
// component, so no DOM is involved.

describe("glyphStateFor", () => {
  it("draws no ring on a session that has never started", () => {
    // The ring only means something if most rows do not have one.
    expect(glyphStateFor("idle", false)).toBeUndefined();
    expect(glyphStateFor(undefined, false)).toBeUndefined();
  });

  it("rings a loaded but quiet session", () => {
    expect(glyphStateFor("idle", true)).toBe("idle");
  });

  it("ranks needing you above being busy", () => {
    // A session that is both mid-tool and blocked on a permission prompt is, to the user,
    // blocked — surfacing "working" would hide the thing they have to act on.
    expect(glyphStateFor("needsInput", true, true)).toBe("needsInput");
  });

  it("shows compaction as working", () => {
    // Distinct as a sidebar chip (the word is useful), identical as a ring: busy, don't type.
    expect(glyphStateFor("idle", true, true)).toBe("running");
    expect(glyphStateFor("running", true)).toBe("running");
  });

  it("keeps a finished session distinct from an idle one", () => {
    expect(glyphStateFor("done", true)).toBe("done");
  });

  it("survives a status string it has never heard of", () => {
    // Statuses arrive from the hook stream; an unknown one must degrade to "it's loaded",
    // not to a blank glyph on a live session.
    expect(glyphStateFor("some-future-status", true)).toBe("idle");
  });
});

/**
 * Agents that ship no brand mark, and why.
 *
 * The rule this list makes an exception to is real: a missing mark falls back to a
 * monogram, which is the thing these marks replaced. But the rule underneath it is
 * stronger — `agents.ts` says an agent with no mark falls back to its letter "rather than
 * shipping a guessed logo", because transcribing path data by hand is a silent error
 * nobody catches in review.
 *
 * Hermes publishes no vector mark: its own favicon is the caduceus CHARACTER (U+2624)
 * rendered as `<text>`, not a path. There is nothing to copy, so it keeps its monogram
 * until Nous Research ships one. Add an agent here only when the same is true of it, and
 * remove it the moment a real mark exists.
 */
const NO_BRAND_MARK: ReadonlySet<string> = new Set(["hermes"]);

describe("AGENT_MARKS", () => {
  it("has a mark for every agent Conduit can spawn", () => {
    // A missing mark silently falls back to a monogram, which is the thing these replaced.
    for (const a of AGENTS) {
      if (NO_BRAND_MARK.has(a.id)) continue;
      expect(AGENT_MARKS[a.id], a.id).toBeDefined();
    }
  });

  it("gives every markless agent a monogram to fall back to", () => {
    // The fallback is only safe while the letter is actually there.
    for (const a of AGENTS) {
      if (!NO_BRAND_MARK.has(a.id)) continue;
      expect(AGENT_MARKS[a.id], `${a.id} has a mark — drop it from NO_BRAND_MARK`).toBeUndefined();
      expect(a.letter.trim().length, a.id).toBeGreaterThan(0);
    }
  });

  it("keeps each mark a single path in its source viewBox", () => {
    for (const a of AGENTS) {
      if (NO_BRAND_MARK.has(a.id)) continue;
      const mark = AGENT_MARKS[a.id]!;
      expect(mark.viewBox, a.id).toMatch(/^0 0 \d+ \d+$/);
      // One path, so `fill: currentColor` tints the whole mark and nothing carries a
      // hardcoded brand colour that would fight the theme.
      expect(mark.path.length, a.id).toBeGreaterThan(20);
      expect(mark.path, a.id).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });
});
