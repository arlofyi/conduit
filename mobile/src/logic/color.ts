/**
 * Colour arithmetic the desktop does in CSS with `color-mix(in srgb, …)`. React Native has no
 * color-mix, so the phone computes the same mixes once, as hex. Pure and tested.
 */

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function parse(hex: string): [number, number, number] | null {
  if (!HEX6.test(hex)) return null;
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

const byte = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");

/**
 * `color-mix(in srgb, a <weight*100>%, b)`: `weight` of `a`, the rest `b`. Non-hex input
 * returns `a` unchanged (the caller's colour is never lost to a parse failure).
 */
export function mix(a: string, b: string, weight: number): string {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return a;
  const w = Math.min(1, Math.max(0, weight));
  return `#${x.map((v, i) => byte(v * w + y[i] * (1 - w))).join("")}`;
}

/**
 * The desktop's `--glyph-ink`: an agent's fixed brand tint bent 28% toward the theme's
 * bright text (`.agent-glyph` in src/theme.css). That mix is meant to clear the 3:1 WCAG
 * 1.4.11 asks of a graphic, and it does everywhere but one place: Command Code's #e0b341 on
 * Warm Light lands at 2.83:1. Given the `ground` it sits on, the phone keeps the desktop's mix
 * whenever it passes and bends further toward the ink only where it does not.
 */
export function glyphInk(tint: string, textBright: string, ground?: string): string {
  let w = 0.72;
  let ink = mix(tint, textBright, w);
  while (ground && w > 0.3 && (contrast(ink, ground) ?? 3) < 3) {
    w -= 0.04;
    ink = mix(tint, textBright, w);
  }
  return ink;
}

/** WCAG relative luminance of a `#rrggbb` colour; null for anything else. */
export function luminance(hex: string): number | null {
  const c = parse(hex);
  if (!c) return null;
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colours (1..21); null on a parse failure. */
export function contrast(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
