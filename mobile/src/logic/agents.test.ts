import * as fs from "fs";
import * as path from "path";
import { AGENT_MARKS, AGENTS, agentInfo, chatOnPhone, glyphStateFor, pulsePeriod } from "./agents";
import { contrast, glyphInk, mix, readableInk } from "./color";
import { PALETTES } from "../theme/palettes";

const DESKTOP = path.resolve(__dirname, "../../../src");

describe("agent identity matches the desktop", () => {
  it("ports every brand mark verbatim (src/components/AgentGlyph.tsx)", () => {
    const glyph = fs.readFileSync(path.join(DESKTOP, "components/AgentGlyph.tsx"), "utf8");
    for (const [id, mark] of Object.entries(AGENT_MARKS)) {
      expect(glyph).toContain(`path: "${mark.path}"`);
      expect(glyph).toContain(`viewBox: "${mark.viewBox}"`);
      expect(AGENTS.some((a) => a.id === id)).toBe(true);
    }
    expect(Object.keys(AGENT_MARKS).sort()).toEqual(["antigravity", "claude", "codex", "commandcode", "gemini", "opencode"]);
  });

  it("ports labels, letters and tints (src/agents.ts)", () => {
    const agents = fs.readFileSync(path.join(DESKTOP, "agents.ts"), "utf8");
    for (const a of AGENTS) {
      const line = agents.split("\n").find((l) => l.includes(`id: "${a.id}"`));
      expect(line).toBeDefined();
      expect(line).toContain(`label: "${a.label}"`);
      expect(line).toContain(`letter: "${a.letter}"`);
      expect(line).toContain(`tint: "${a.tint}"`);
    }
  });

  it("falls back for an unknown agent", () => {
    expect(agentInfo("gpt9")).toMatchObject({ id: "gpt9", letter: "?" });
  });
});

describe("glyphStateFor", () => {
  it("matches the desktop's mapping", () => {
    expect(glyphStateFor("needsInput", false)).toBe("needsInput");
    expect(glyphStateFor("idle", true, true)).toBe("running");
    expect(glyphStateFor("running", false)).toBe("running");
    expect(glyphStateFor("done", false)).toBe("done");
    expect(glyphStateFor("idle", true)).toBe("idle");
    expect(glyphStateFor("idle", false)).toBeUndefined();
  });
  it("pulses at the desktop's periods", () => {
    expect(pulsePeriod("running")).toBe(2400);
    expect(pulsePeriod("needsInput")).toBe(1600);
    expect(pulsePeriod("idle")).toBeNull();
    expect(pulsePeriod(undefined)).toBeNull();
  });
});

describe("readableInk", () => {
  it("keeps a colour that already reads as text, bends one that does not to 4.5:1", () => {
    const d = PALETTES["warm-near-black"];
    expect(readableInk("#c47f88", d.textBright, d.panelBg)).toBe("#c47f88");
    const l = PALETTES["warm-light"];
    const ink = readableInk("#c47f88", l.textBright, l.panelBg);
    expect(ink).not.toBe("#c47f88");
    expect(contrast(ink, l.panelBg)!).toBeGreaterThanOrEqual(4.5);
  });
});

describe("colour mixing", () => {
  it("mixes like color-mix in srgb", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#ff0000", "#0000ff", 1)).toBe("#ff0000");
    expect(mix("rgb(1,2,3)", "#ffffff", 0.5)).toBe("rgb(1,2,3)");
  });
  it("bends every brand tint to >= 3:1 on every theme (WCAG 1.4.11), as --glyph-ink does", () => {
    const low: string[] = [];
    for (const [id, p] of Object.entries(PALETTES)) {
      for (const a of AGENTS) {
        const c = contrast(glyphInk(a.tint, p.textBright, p.panelBg), p.panelBg)!;
        if (c < 3) low.push(`${id}/${a.id}=${c.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });
  it("keeps the desktop's exact mix wherever it already passes", () => {
    const p = PALETTES["warm-near-black"];
    expect(glyphInk("#ce8a6e", p.textBright, p.panelBg)).toBe(mix("#ce8a6e", p.textBright, 0.72));
    // the one desktop shortfall (2.83:1) is bent further on the phone
    const l = PALETTES["warm-light"];
    expect(glyphInk("#e0b341", l.textBright)).toBe(mix("#e0b341", l.textBright, 0.72));
    expect(glyphInk("#e0b341", l.textBright, l.panelBg)).not.toBe(mix("#e0b341", l.textBright, 0.72));
  });
});

describe("chatOnPhone", () => {
  it("is Claude only: its transcript is the chat, and its slash commands are the quick actions", () => {
    expect(chatOnPhone("claude")).toBe(true);
    for (const a of AGENTS.filter((x) => x.id !== "claude")) expect(chatOnPhone(a.id)).toBe(false);
    expect(chatOnPhone("")).toBe(false);
  });
});
