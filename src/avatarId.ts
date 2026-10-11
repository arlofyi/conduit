/** Which animal a session is drawn as. Derived, never stored (same rule as projectAccent):
 *  identical in every view that shows it, and nothing to migrate. Store-free for vitest. */
export const ANIMALS = [
  "fox", "rabbit", "owl", "bear", "cat", "frog", "panda", "penguin", "koala", "tiger", "otter", "hedgehog",
] as const;
export type Animal = (typeof ANIMALS)[number];

export function sessionAnimal(key: string): Animal {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ANIMALS[h % ANIMALS.length];
}
