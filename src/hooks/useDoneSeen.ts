import { useEffect } from "react";
import { useStore } from "../store";
import { handOffView } from "../askHandoff";
import { askShouldHandOff } from "../asks";
import { doneSeenIn } from "../statusRules";

/**
 * `done` means "finished while you were not looking": once the finished session has been
 * in front of the user, it reads as idle. The rule is `doneSeenIn` (pure, tested); this
 * only supplies what is on screen and owns the one timer.
 *
 * "In front" is the same test a question card uses to hand itself back to the terminal
 * (`askShouldHandOff`): this window focused, that session selected, and its terminal not
 * covered by the Continuity view. A session visible in a second pane but not selected is
 * not "looked at" -- two definitions of "the session the user is watching" is how a card
 * and a dot end up disagreeing.
 */
export function useDoneSeen() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armedFor: string | undefined;
    const disarm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      armedFor = undefined;
    };
    const check = () => {
      const st = useStore.getState();
      const view = handOffView(st);
      const id = view.selectedSessionId;
      const live = id ? st.live[id] : undefined;
      const wait =
        id && live
          ? doneSeenIn(live.status, live.updatedAt, Date.now(), askShouldHandOff({ session: id }, view))
          : undefined;
      if (!id || wait === undefined) return disarm();
      // Already counting down for this session: leave the timer alone, or every store
      // change (and there are many a second) would push it back.
      if (armedFor === id) return;
      disarm();
      armedFor = id;
      timer = setTimeout(() => {
        timer = undefined;
        armedFor = undefined;
        // Re-read everything: the user may have looked away, or a new turn started.
        const now = useStore.getState();
        const v = handOffView(now);
        const l = now.live[id];
        if (doneSeenIn(l?.status, l?.updatedAt, Date.now(), askShouldHandOff({ session: id }, v)) === 0) {
          now.markSeen(id);
        } else {
          check();
        }
      }, wait);
    };
    check();
    const unsub = useStore.subscribe(check);
    return () => {
      unsub();
      disarm();
    };
  }, []);
}
