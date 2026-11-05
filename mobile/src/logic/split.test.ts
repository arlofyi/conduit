import { DETAIL_MIN, LIST_MAX, LIST_MIN, isSplit, listWidth, readingInset } from "./split";

describe("split layout", () => {
  it("splits on a wide window only, and only when enabled", () => {
    expect(isSplit(411)).toBe(false); // phone, upright
    expect(isSplit(719)).toBe(false);
    expect(isSplit(800)).toBe(true); // tablet upright
    expect(isSplit(1280)).toBe(true);
    expect(isSplit(1280, false)).toBe(false);
  });
  it("keeps the list between its bounds and leaves the detail pane room", () => {
    expect(listWidth(360, 1280)).toBe(360);
    expect(listWidth(100, 1280)).toBe(LIST_MIN);
    expect(listWidth(2000, 1280)).toBe(LIST_MAX);
    // half the window wins over LIST_MAX on a narrower one
    expect(listWidth(2000, 800)).toBe(400);
    // the detail pane always keeps DETAIL_MIN where it can
    expect(800 - listWidth(2000, 800)).toBeGreaterThanOrEqual(DETAIL_MIN);
    // never below the floor, even on the narrowest split window
    expect(listWidth(360, 720)).toBe(340);
  });
  it("centres an over-wide reading column", () => {
    expect(readingInset(700)).toBe(0);
    expect(readingInset(1060)).toBe(100);
  });
});
