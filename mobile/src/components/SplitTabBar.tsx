/**
 * The tab bar under a split view's detail pane.
 *
 * A chat, a general chat and a session's files are ROOT stack screens pushed over the tab
 * navigator, so on a phone they cover the tab bar on purpose (a full-screen chat). In the split
 * view the list beside them looks like the tab's own content, and the bar vanishing under it
 * read as the app losing its navigation. This draws the same tabs, with the same badges, and a
 * tap goes back to the Tabs route on that tab (which closes the detail pane, the same as
 * switching tabs does).
 *
 * The native bar cannot be reused here: it belongs to the tab navigator, which is the screen
 * underneath.
 */
import React, { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useLive } from "../bridge/LiveProvider";
import { useAppUpdate } from "../data/AppUpdateProvider";
import { useListSelection } from "../data/ListSelection";
import { usePortMirror } from "../data/PortMirrorProvider";
import { needsCount, resolveProfile } from "../logic/chatList";
import { openBySession } from "../logic/pending";
import { navigationRef } from "../navRef";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";
import { Icon } from "./Glass";
import type { AppSymbol } from "./androidSymbols";

export type SplitTab = "Chats" | "General" | "Apps" | "Settings";

/** The bar's height above the bottom safe-area inset. */
export const SPLIT_TAB_BAR_HEIGHT = 56;

interface TabDef {
  name: SplitTab;
  title: string;
  symbol: AppSymbol;
  badge?: string;
}

export function SplitTabBar({ active, bottomInset }: { active: SplitTab; bottomInset: number }) {
  const { palette: p } = useTheme();
  const { view, pending } = useLive();
  const { profileSel } = useListSelection();
  const { available: mirrorAvailable } = usePortMirror();
  const { release } = useAppUpdate();
  const profile = view ? resolveProfile(view, profileSel === undefined ? view.activeProfileId : profileSel) : null;
  const openPending = useMemo(() => openBySession(pending), [pending]);
  const needs = needsCount(view, profile, openPending);

  const tabs: TabDef[] = [
    { name: "Chats", title: "Sessions", symbol: "bubble.left.and.bubble.right", badge: needs > 0 ? String(needs) : undefined },
    { name: "General", title: "Chats", symbol: "sparkles" },
    ...(mirrorAvailable ? [{ name: "Apps" as const, title: "Apps", symbol: "globe" as const }] : []),
    { name: "Settings", title: "Settings", symbol: "gearshape", badge: release ? "1" : undefined },
  ];

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        justifyContent: "center",
        height: SPLIT_TAB_BAR_HEIGHT + bottomInset,
        paddingBottom: bottomInset,
        borderTopWidth: 1,
        borderTopColor: p.border,
        backgroundColor: p.sidebarBg,
      }}
    >
      {tabs.map((t) => {
        const on = t.name === active;
        const color = on ? p.accent : p.textMid;
        return (
          <Pressable
            key={t.name}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={t.badge ? `${t.title}, ${t.badge}` : t.title}
            onPress={() => {
              if (on || !navigationRef.isReady()) return;
              (navigationRef.navigate as (name: string, params: object) => void)("Tabs", { screen: t.name });
            }}
            style={{ width: 120, alignItems: "center", justifyContent: "center", gap: 3 }}
          >
            <View>
              <Icon name={t.symbol} size={22} color={color} />
              {t.badge ? (
                <View
                  style={{
                    position: "absolute",
                    top: -5,
                    right: -12,
                    minWidth: 17,
                    height: 17,
                    borderRadius: 9,
                    paddingHorizontal: 4,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: p.amber,
                  }}
                >
                  <Text style={{ color: p.meText, fontSize: 11, fontWeight: "700" }}>{t.badge}</Text>
                </View>
              ) : null}
            </View>
            <Text style={{ color, fontSize: TYPE.caption, fontWeight: on ? "600" : "400" }}>{t.title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
