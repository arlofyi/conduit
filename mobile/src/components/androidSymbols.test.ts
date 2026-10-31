import { readFileSync } from "fs";
import { join } from "path";
import { ANDROID_SYMBOLS } from "./androidSymbols";

// The glyph table expo-symbols draws Android icons from. Read off disk: the package's
// `exports` map does not expose it to `require`.
const symbols: Record<string, unknown> = JSON.parse(
  readFileSync(join(__dirname, "../../node_modules/expo-symbols/build/android/symbols.json"), "utf8"),
);

describe("ANDROID_SYMBOLS", () => {
  it("names only glyphs the bundled Material Symbols font has", () => {
    const missing = Object.values(ANDROID_SYMBOLS).filter((m) => !(m in symbols));
    expect(missing).toEqual([]);
  });
});
