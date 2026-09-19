import { describe, it, expect } from "vitest";
import {
  LOCAL_PRESETS,
  isLocalPreset,
  providerReady,
  allowedForLocalOnly,
  EMPTY_PROVIDER,
  type ProviderSettings,
} from "./providers";

const p = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
  ...EMPTY_PROVIDER,
  enabled: true,
  preset: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "qwen3:30b",
  ...over,
});

describe("isLocalPreset", () => {
  it("counts only presets that keep inference on the machine", () => {
    for (const preset of LOCAL_PRESETS) expect(isLocalPreset(preset), preset).toBe(true);
  });

  it("does NOT count OpenRouter", () => {
    // The whole point of the split: OpenRouter is a perfectly good endpoint that happens
    // to be someone else's computer.
    expect(isLocalPreset("openrouter")).toBe(false);
  });

  it("does NOT count a custom URL", () => {
    // A custom URL may point anywhere. Treating "the user typed a URL" as local is how a
    // siloed session would get quietly routed off the machine.
    expect(isLocalPreset("custom")).toBe(false);
    expect(isLocalPreset("")).toBe(false);
  });
});

describe("providerReady", () => {
  it("needs the switch and both halves of the route", () => {
    expect(providerReady(p())).toBe(true);
    expect(providerReady(p({ enabled: false }))).toBe(false);
    expect(providerReady(p({ model: "" })), "no model").toBe(false);
    expect(providerReady(p({ baseUrl: "" })), "no base URL").toBe(false);
  });

  it("treats whitespace as absent rather than as a value", () => {
    expect(providerReady(p({ model: "   " }))).toBe(false);
    expect(providerReady(p({ baseUrl: "  " }))).toBe(false);
  });

  it("is false for a missing entry", () => {
    expect(providerReady(undefined)).toBe(false);
    expect(providerReady(null)).toBe(false);
    expect(providerReady(EMPTY_PROVIDER)).toBe(false);
  });
});

describe("allowedForLocalOnly", () => {
  it("admits a configured local endpoint", () => {
    expect(allowedForLocalOnly(p())).toBe(true);
  });

  it("refuses OpenRouter even when pinned", () => {
    // `pinLocal` means "don't fall back elsewhere", which a cloud aggregator satisfies
    // completely. Reading it as containment is the exact bug this guards.
    const cloud = p({ preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1", pinLocal: true });
    expect(allowedForLocalOnly(cloud)).toBe(false);
  });

  it("refuses a custom URL", () => {
    expect(allowedForLocalOnly(p({ preset: "custom", baseUrl: "https://example.com/v1" }))).toBe(
      false,
    );
  });

  it("admits an endpoint that is not configured at all", () => {
    // Nothing to route means nothing to contain -- the session runs on the agent's own
    // config, which is the safe outcome, not a blocked one.
    expect(allowedForLocalOnly(EMPTY_PROVIDER)).toBe(true);
    expect(allowedForLocalOnly(p({ preset: "openrouter", enabled: false }))).toBe(true);
  });
});
