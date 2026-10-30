/**
 * The desktop chat mode's `--hq-*` tokens (src/theme.css), computed for a palette. The desktop
 * derives them with `color-mix`; React Native has none, so they are mixed once here, over the
 * panel they sit on (a translucent wash over a known ground is the same colour, opaque).
 */
import { mix } from "../logic/color";
import type { Palette } from "./palettes";

export interface Hq {
  /** --hq-ink-2: secondary prose (blockquotes, note bodies) */
  ink2: string;
  /** --hq-line-2: the stronger rule */
  line2: string;
  /** --hq-rose-soft over the panel: the user bubble's fill */
  roseSoft: string;
  /** --hq-rose-line over the panel: the user bubble's border */
  roseLine: string;
  /** the Insight callout's 7% wash */
  insightBg: string;
  /** assistant bubble: the warm selection tier, a step above the panel */
  them: string;
  /** code blocks inside a bubble: --hq-surface at 70% over the bubble */
  code: string;
  /** a hairline that reads on the panel */
  hairline: string;
}

const cache = new Map<Palette, Hq>();

export function hq(p: Palette): Hq {
  const hit = cache.get(p);
  if (hit) return hit;
  const them = p.selectionBg;
  const v: Hq = {
    ink2: mix(p.textBright, p.textMid, 0.45),
    line2: mix(p.border, p.textDim, 0.55),
    roseSoft: mix(p.accent, p.panelBg, 0.18),
    roseLine: mix(p.accent, p.panelBg, 0.34),
    insightBg: mix(p.accent, them, 0.07),
    them,
    code: mix(p.panelBg, them, 0.7),
    hairline: p.border,
  };
  cache.set(p, v);
  return v;
}
