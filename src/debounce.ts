/** A trailing debounce with a ceiling: `fn` runs `wait` ms after the last `call()`, but
 *  never more than `maxWait` ms after the first call of a burst. A plain debounce under a
 *  steady event stream (continuity committing every few hundred ms) would never fire, and
 *  the view would freeze on its last read for as long as the stream lasted. */
export function debounceMaxWait(fn: () => void, wait: number, maxWait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | null = null;
  const fire = () => {
    timer = undefined;
    firstAt = null;
    fn();
  };
  return {
    call() {
      const now = Date.now();
      if (firstAt === null) firstAt = now;
      clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(wait, firstAt + maxWait - now)));
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      firstAt = null;
    },
  };
}
