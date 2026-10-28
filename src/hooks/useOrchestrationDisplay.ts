import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Only the P1 display switch is read here. Policy enforcement is intentionally absent. */
export function useOrchestrationDisplay(projectIds: string[]): Record<string, boolean> {
  const key = [...projectIds].sort().join(",");
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const ids = key ? key.split(",") : [];
      const entries = await Promise.all(ids.map(async (id) => {
        try {
          const view = await invoke<{ effective: { contextDisplay?: boolean } }>("orchestration_policy_view", { projectId: id });
          return [id, view.effective.contextDisplay === true] as const;
        } catch { return [id, false] as const; }
      }));
      if (active) setEnabled(Object.fromEntries(entries));
    };
    void refresh();
    const unlisten = listen("store-saved", () => { void refresh(); });
    return () => { active = false; void unlisten.then((f) => f()); };
  }, [key]);
  return enabled;
}
