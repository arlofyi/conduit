/**
 * The Chats list's selection (profile + filter chip), shared by the list and the "…" sheet that
 * now owns the profile picker. In memory only, and reset whenever the Mac changes: another Mac
 * has other profiles and projects, so it starts from its own active profile and All.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useLive } from "../bridge/LiveProvider";
import type { ChatFilter, ProfileSel } from "../logic/chatList";

interface ListSelection {
  /** undefined = "not chosen yet on this Mac": follow the Mac's active profile */
  profileSel: ProfileSel | undefined;
  setProfileSel: (p: ProfileSel) => void;
  filter: ChatFilter;
  setFilter: (f: ChatFilter) => void;
}

const Ctx = createContext<ListSelection | null>(null);

export function ListSelectionProvider({ children }: { children: React.ReactNode }) {
  const { currentMac } = useLive();
  const macId = currentMac?.deviceId ?? null;
  const [profileSel, setProfileSel] = useState<ProfileSel | undefined>(undefined);
  const [filter, setFilter] = useState<ChatFilter>("all");
  useEffect(() => {
    setProfileSel(undefined);
    setFilter("all");
  }, [macId]);
  const value = useMemo(() => ({ profileSel, setProfileSel, filter, setFilter }), [profileSel, filter]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useListSelection(): ListSelection {
  const v = useContext(Ctx);
  if (!v) throw new Error("useListSelection must be used within a ListSelectionProvider");
  return v;
}
