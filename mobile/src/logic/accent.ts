/**
 * A project's colour, the same one the desktop gives it. Port of `projectHue` /
 * `PROJECT_PALETTE` / `projectAccent` from the desktop's src/layout.ts: an uncoloured project
 * must wear the same colour on the phone as in the Mac's sidebar, so this is a literal copy
 * and `accent.test.ts` pins the same five outputs as the desktop's `layout.test.ts`.
 *
 * The desktop's per-machine "auto project colours" switch is not mirrored: the phone always
 * shows a colour, because its avatars have no neutral fallback to fall back to.
 */

/** Values only, in the desktop's order (the order IS the mapping). */
export const PROJECT_PALETTE: readonly string[] = [
  "#c4906c", // Terracotta
  "#c9a86b", // Ochre
  "#b8b072", // Sand
  "#93ad7c", // Sage
  "#75a898", // Seafoam
  "#7c9fb8", // Slate
  "#9691c4", // Lavender
  "#b989b1", // Mauve
  "#c47f88", // Rose
  "#a89383", // Driftwood
];

/** FNV-1a over UTF-16 code units, spread by 137° — identical to the desktop's. */
export function projectHue(projectId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ((h % 360) * 137) % 360;
}

export function projectAccent(projectId: string): string {
  return PROJECT_PALETTE[projectHue(projectId) % PROJECT_PALETTE.length];
}

/** The chosen colour when the user picked one on your computer, else the derived accent. */
export function accentFor(project: { id: string; color: string | null }): string {
  return project.color ? project.color : projectAccent(project.id);
}

/** `#rrggbb` + alpha as `#rrggbbaa`; null for any other colour syntax (caller falls back). */
export function tint(hex: string, alpha: number): string | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}
