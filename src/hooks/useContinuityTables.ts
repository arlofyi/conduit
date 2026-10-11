import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ServiceTab, TableTab, TablesView } from "../continuityTables";

const REFETCH_DEBOUNCE_MS = 750; // same as the graph (useContinuityGraph)
/** Files is a 30-minute window and Activity/age labels drift, so the visible table refreshes
 *  on this tick even without a database change. */
const TICK_MS = 30_000;
/** Cheap and worth a number in the tab strip, so they are kept fresh while the view is open
 *  even when another tab shows. */
const COUNTED: ServiceTab[] = ["decisions", "handoffs", "tasks"];

export type TablesData = { [K in ServiceTab]?: TablesView<K> };

/** The Continuity view's table reads. Rows of every fetched tab are kept, so switching tabs
 *  paints the last read at once while it refreshes. Nothing runs while the view is closed. */
export function useContinuityTables(projectId: string, tab: TableTab) {
  const [data, setData] = useState<TablesData>({});
  const [now, setNow] = useState(() => Date.now());
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // A reply for the previous project must not land under this one.
  const projRef = useRef(projectId);
  projRef.current = projectId;
  // Per-tab request sequence: replies can land out of order (a debounced stream refetch and a
  // tab-open refetch overlap), and only the newest request for a tab may write its rows.
  const seqRef = useRef<Partial<Record<ServiceTab, number>>>({});

  const pull = (tabs: ServiceTab[]) => {
    const pid = projectId;
    for (const t of tabs) {
      const seq = (seqRef.current[t] ?? 0) + 1;
      seqRef.current[t] = seq;
      invoke<TablesView>("continuity_tables", { projectId: pid, tab: t })
        .then((v) => {
          if (projRef.current === pid && seqRef.current[t] === seq) setData((d) => ({ ...d, [t]: v }));
        })
        .catch(() => {
          /* keep the last good read */
        });
    }
  };
  const wanted = (): ServiceTab[] => {
    const t = tabRef.current;
    return t === "graph" || COUNTED.includes(t) ? COUNTED : [...COUNTED, t];
  };

  useEffect(() => {
    setData({});
    pull(wanted());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const un = listen("continuity-changed", () => {
      if (!alive) return;
      clearTimeout(timer);
      timer = setTimeout(() => pull(wanted()), REFETCH_DEBOUNCE_MS);
    });
    const tick = setInterval(() => {
      setNow(Date.now());
      const t = tabRef.current;
      if (t === "files" || t === "activity") pull([t]);
    }, TICK_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(tick);
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Opening a tab refreshes it (the counted ones are already fresh from the stream).
  useEffect(() => {
    if (tab === "graph") return;
    setNow(Date.now());
    pull([tab]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return { data, now };
}
