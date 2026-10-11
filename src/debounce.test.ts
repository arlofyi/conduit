import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounceMaxWait } from "./debounce";

describe("debounceMaxWait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once, `wait` after the last call, when calls stop", () => {
    const fn = vi.fn();
    const d = debounceMaxWait(fn, 750, 3000);
    d.call();
    vi.advanceTimersByTime(500);
    d.call();
    vi.advanceTimersByTime(749);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still fires at least every `maxWait` while calls keep arriving", () => {
    const fn = vi.fn();
    const d = debounceMaxWait(fn, 750, 3000);
    for (let t = 0; t < 6000; t += 500) {
      d.call();
      vi.advanceTimersByTime(500);
    }
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending call", () => {
    const fn = vi.fn();
    const d = debounceMaxWait(fn, 750, 3000);
    d.call();
    d.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
