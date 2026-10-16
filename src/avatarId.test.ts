import { describe, expect, it } from "vitest";
import { ANIMALS, sessionAnimal } from "./avatarId";

describe("sessionAnimal", () => {
  it("is stable for a key", () => {
    expect(sessionAnimal("8b1f2c")).toBe(sessionAnimal("8b1f2c"));
  });
  it("always lands in the set", () => {
    for (let i = 0; i < 500; i++) expect(ANIMALS).toContain(sessionAnimal(`s-${i}`));
  });
  it("spreads: 200 ids use at least 10 of the 12 animals", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => sessionAnimal(`${i}-x`)));
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});
