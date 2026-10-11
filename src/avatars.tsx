import type { JSX } from "react";
import { sessionAnimal, type Animal } from "./avatarId";

/** One path set per animal, all in a 64×64 viewBox (never rescale path data by hand —
 *  same rule as AGENT_MARKS). Fills are the only fixed colours in the view; they sit on
 *  --selection-bg in both themes. */
const ART: Record<Animal, JSX.Element> = {
  fox: (
    <>
      <path d="M12 14 L24 26 L14 32 Z M52 14 L40 26 L50 32 Z" fill="#c4906c" />
      <path d="M17 17 L22 24 L17 27 Z M47 17 L42 24 L47 27 Z" fill="#3a2a22" />
      <path d="M32 54 C18 54 12 42 14 30 C18 24 26 22 32 22 C38 22 46 24 50 30 C52 42 46 54 32 54 Z" fill="#d49a72" />
      <path d="M32 54 C24 54 20 46 22 40 L32 44 L42 40 C44 46 40 54 32 54 Z" fill="#f3e6d8" />
      <circle cx="25" cy="35" r="2.6" fill="#1b1310" /><circle cx="39" cy="35" r="2.6" fill="#1b1310" />
      <circle cx="26" cy="34" r=".8" fill="#fff" /><circle cx="40" cy="34" r=".8" fill="#fff" />
      <ellipse cx="32" cy="44" rx="2.6" ry="1.9" fill="#1b1310" />
    </>
  ),
  rabbit: (
    <>
      <rect x="20" y="4" width="9" height="26" rx="4.5" fill="#d8d0c6" /><rect x="35" y="4" width="9" height="26" rx="4.5" fill="#d8d0c6" />
      <rect x="22.5" y="8" width="4" height="18" rx="2" fill="#e8b4a8" /><rect x="37.5" y="8" width="4" height="18" rx="2" fill="#e8b4a8" />
      <circle cx="32" cy="40" r="16" fill="#e6dfd6" />
      <circle cx="26" cy="38" r="2.6" fill="#1b1310" /><circle cx="38" cy="38" r="2.6" fill="#1b1310" />
      <circle cx="27" cy="37" r=".8" fill="#fff" /><circle cx="39" cy="37" r=".8" fill="#fff" />
      <path d="M30 44 L34 44 L32 46.5 Z" fill="#e08a8a" />
      <circle cx="22" cy="45" r="2.6" fill="#f0b8b0" opacity=".6" /><circle cx="42" cy="45" r="2.6" fill="#f0b8b0" opacity=".6" />
    </>
  ),
  owl: (
    <>
      <path d="M14 16 L22 24 L16 28 Z M50 16 L42 24 L48 28 Z" fill="#8f7a64" />
      <path d="M32 58 C16 58 12 44 14 32 C16 22 24 18 32 18 C40 18 48 22 50 32 C52 44 48 58 32 58 Z" fill="#a8927a" />
      <circle cx="24" cy="34" r="8" fill="#f1e8dc" /><circle cx="40" cy="34" r="8" fill="#f1e8dc" />
      <circle cx="24" cy="34" r="4" fill="#1b1310" /><circle cx="40" cy="34" r="4" fill="#1b1310" />
      <circle cx="25.4" cy="32.6" r="1.2" fill="#fff" /><circle cx="41.4" cy="32.6" r="1.2" fill="#fff" />
      <path d="M29 41 L35 41 L32 46 Z" fill="#c2a063" />
      <path d="M22 50 Q32 46 42 50" stroke="#8f7a64" strokeWidth="2" fill="none" />
    </>
  ),
  bear: (
    <>
      <circle cx="17" cy="20" r="8" fill="#8a6b52" /><circle cx="47" cy="20" r="8" fill="#8a6b52" />
      <circle cx="17" cy="20" r="4" fill="#5e4636" /><circle cx="47" cy="20" r="4" fill="#5e4636" />
      <circle cx="32" cy="36" r="19" fill="#9a7a5f" />
      <ellipse cx="32" cy="43" rx="9" ry="7" fill="#d9c3a8" />
      <circle cx="25" cy="33" r="2.6" fill="#1b1310" /><circle cx="39" cy="33" r="2.6" fill="#1b1310" />
      <circle cx="26" cy="32" r=".8" fill="#fff" /><circle cx="40" cy="32" r=".8" fill="#fff" />
      <ellipse cx="32" cy="40.5" rx="3" ry="2.2" fill="#1b1310" />
    </>
  ),
  cat: (
    <>
      <path d="M14 12 L26 24 L14 30 Z M50 12 L38 24 L50 30 Z" fill="#9b9a96" />
      <circle cx="32" cy="37" r="18" fill="#b3b1ab" />
      <ellipse cx="25" cy="35" rx="2.2" ry="3" fill="#1b1310" /><ellipse cx="39" cy="35" rx="2.2" ry="3" fill="#1b1310" />
      <path d="M30 42 L34 42 L32 44 Z" fill="#d08a8a" />
      <path d="M14 40 L24 41 M14 45 L24 43 M50 40 L40 41 M50 45 L40 43" stroke="#6e6c68" strokeWidth="1" />
    </>
  ),
  frog: (
    <>
      <circle cx="22" cy="22" r="9" fill="#93ad7c" /><circle cx="42" cy="22" r="9" fill="#93ad7c" />
      <circle cx="22" cy="22" r="5" fill="#f1e8dc" /><circle cx="42" cy="22" r="5" fill="#f1e8dc" />
      <circle cx="22" cy="22" r="2.6" fill="#1b1310" /><circle cx="42" cy="22" r="2.6" fill="#1b1310" />
      <ellipse cx="32" cy="40" rx="21" ry="15" fill="#93ad7c" />
      <path d="M22 44 Q32 51 42 44" stroke="#4a5e3c" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    </>
  ),
  panda: (
    <>
      {/* A light rim: the ears are near-black and would vanish into the dark tile. */}
      <circle cx="17" cy="19" r="8" fill="#2b2826" stroke="#5e574f" strokeWidth={1.2} /><circle cx="47" cy="19" r="8" fill="#2b2826" stroke="#5e574f" strokeWidth={1.2} />
      <circle cx="32" cy="36" r="19" fill="#ece7e1" />
      <ellipse cx="24.5" cy="34" rx="5" ry="6" fill="#2b2826" transform="rotate(-20 24.5 34)" />
      <ellipse cx="39.5" cy="34" rx="5" ry="6" fill="#2b2826" transform="rotate(20 39.5 34)" />
      <circle cx="25" cy="34" r="2" fill="#f5f1ec" /><circle cx="39" cy="34" r="2" fill="#f5f1ec" />
      <ellipse cx="32" cy="42" rx="3" ry="2.2" fill="#2b2826" />
    </>
  ),
  penguin: (
    <>
      <ellipse cx="32" cy="36" rx="19" ry="21" fill="#3a3f4a" />
      <ellipse cx="32" cy="40" rx="13" ry="15" fill="#f1ece4" />
      <circle cx="26" cy="31" r="2.6" fill="#1b1310" /><circle cx="38" cy="31" r="2.6" fill="#1b1310" />
      <circle cx="27" cy="30" r=".8" fill="#fff" /><circle cx="39" cy="30" r=".8" fill="#fff" />
      <path d="M28 37 L36 37 L32 42 Z" fill="#c2a063" />
    </>
  ),
  koala: (
    <>
      <circle cx="14" cy="24" r="10" fill="#9a9792" /><circle cx="50" cy="24" r="10" fill="#9a9792" />
      <circle cx="14" cy="24" r="5" fill="#d9d4cd" /><circle cx="50" cy="24" r="5" fill="#d9d4cd" />
      <circle cx="32" cy="36" r="18" fill="#a8a59f" />
      <circle cx="25" cy="33" r="2.6" fill="#1b1310" /><circle cx="39" cy="33" r="2.6" fill="#1b1310" />
      <circle cx="26" cy="32" r=".8" fill="#fff" /><circle cx="40" cy="32" r=".8" fill="#fff" />
      <ellipse cx="32" cy="41" rx="4.5" ry="5.5" fill="#3a3330" />
    </>
  ),
  tiger: (
    <>
      <circle cx="18" cy="18" r="7" fill="#d4874a" /><circle cx="46" cy="18" r="7" fill="#d4874a" />
      <circle cx="32" cy="36" r="19" fill="#d98f4e" />
      <path d="M32 18 L29 26 L35 26 Z M14 34 L22 35 M14 40 L22 39 M50 34 L42 35 M50 40 L42 39" stroke="#3a2a22" strokeWidth="2.2" fill="#3a2a22" />
      <ellipse cx="32" cy="44" rx="9" ry="6" fill="#f3e6d8" />
      <circle cx="25" cy="34" r="2.6" fill="#1b1310" /><circle cx="39" cy="34" r="2.6" fill="#1b1310" />
      <circle cx="26" cy="33" r=".8" fill="#fff" /><circle cx="40" cy="33" r=".8" fill="#fff" />
      <path d="M30 41 L34 41 L32 43.5 Z" fill="#1b1310" />
    </>
  ),
  otter: (
    <>
      <circle cx="19" cy="22" r="5" fill="#7a5b44" /><circle cx="45" cy="22" r="5" fill="#7a5b44" />
      <circle cx="32" cy="36" r="18" fill="#8d6a50" />
      <ellipse cx="32" cy="43" rx="11" ry="8" fill="#d8c3a8" />
      <circle cx="25" cy="33" r="2.6" fill="#1b1310" /><circle cx="39" cy="33" r="2.6" fill="#1b1310" />
      <circle cx="26" cy="32" r=".8" fill="#fff" /><circle cx="40" cy="32" r=".8" fill="#fff" />
      <ellipse cx="32" cy="40" rx="3" ry="2.2" fill="#1b1310" />
      <path d="M20 44 L27 43 M20 47 L27 45 M44 44 L37 43 M44 47 L37 45" stroke="#5e4636" strokeWidth="1" />
    </>
  ),
  hedgehog: (
    <>
      <path d="M8 40 L12 22 L18 30 L22 14 L28 26 L32 10 L36 26 L42 14 L46 30 L52 22 L56 40 Z" fill="#6e5a48" />
      <ellipse cx="32" cy="42" rx="17" ry="14" fill="#d9c3a5" />
      <circle cx="26" cy="40" r="2.6" fill="#1b1310" /><circle cx="38" cy="40" r="2.6" fill="#1b1310" />
      <circle cx="27" cy="39" r=".8" fill="#fff" /><circle cx="39" cy="39" r=".8" fill="#fff" />
      <circle cx="32" cy="47" r="2.4" fill="#1b1310" />
    </>
  ),
};

export type AvatarTone = "running" | "needs" | "idle" | "stopped" | "visitor";

export function SessionAvatar({
  nodeKey, size = 72, tone = "idle", chipColor = null, badge = 0, title,
}: {
  nodeKey: string; size?: number; tone?: AvatarTone; chipColor?: string | null; badge?: number; title?: string;
}) {
  const animal = sessionAnimal(nodeKey);
  return (
    <div className={`session-avatar tone-${tone}`} style={{ width: size, height: size }} title={title}>
      <svg viewBox="0 0 64 64" width={size * 0.75} height={size * 0.75} aria-hidden="true">
        {ART[animal]}
      </svg>
      {badge > 0 && <span className="session-avatar-badge">{badge}</span>}
      {chipColor && <span className="session-avatar-chip" style={{ background: chipColor }} />}
    </div>
  );
}
