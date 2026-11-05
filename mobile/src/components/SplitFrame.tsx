/**
 * The split view's frame: the list pane, a draggable divider, and the detail pane.
 *
 * Both slots keep their position in the tree whether or not the window is split, so a rotation
 * or a split-screen resize never remounts what is in them (a remounted chat would re-attach and
 * lose its scroll). When the window is not wide, only the `primary` slot is rendered at all:
 * a hidden list behind a phone's chat would poll and hold a back handler for nothing.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, View, useWindowDimensions } from "react-native";
import { usePrefs } from "../data/PrefsProvider";
import { DEFAULT_PREFS } from "../data/prefs";
import { isSplit, listWidth } from "../logic/split";
import { useTheme } from "../theme/ThemeContext";

/** What the detail pane is showing, so the list beside it can mark that row. */
export interface SplitCurrent {
  sessionId?: string;
  chatId?: string;
}

const CurrentCtx = createContext<SplitCurrent | null>(null);

/** The row the detail pane shows; null outside a split frame (a phone, or the list alone). */
export function useSplitCurrent(): SplitCurrent | null {
  return useContext(CurrentCtx);
}

/** Is the window wide enough for the split view (and is it switched on)? */
export function useIsSplit(): boolean {
  const { width } = useWindowDimensions();
  const { prefs } = usePrefs();
  return isSplit(width, prefs.splitView);
}

export function SplitFrame({
  list,
  children,
  primary,
  current = null,
}: {
  list: React.ReactNode;
  children: React.ReactNode;
  /** what a phone-width window shows */
  primary: "list" | "detail";
  current?: SplitCurrent | null;
}) {
  const { palette: p } = useTheme();
  const { width } = useWindowDimensions();
  const { prefs, setPrefs } = usePrefs();
  const split = isSplit(width, prefs.splitView);
  // Dragged live; stored once, on release.
  const [drag, setDrag] = useState<number | null>(null);
  const w = listWidth(drag ?? prefs.splitListWidth, width);
  const start = useRef(w);
  const latest = useRef({ w, width, setPrefs });
  latest.current = { w, width, setPrefs };
  useEffect(() => {
    if (drag === null) start.current = w;
  }, [w, drag]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // A scroll view beside the divider must not steal a drag that started on it.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          start.current = latest.current.w;
        },
        onPanResponderMove: (_e, g) => setDrag(start.current + g.dx),
        onPanResponderRelease: (_e, g) => {
          const next = listWidth(start.current + g.dx, latest.current.width);
          // A tap without a drag puts the list back to its default width.
          const tapped = Math.abs(g.dx) < 3 && Math.abs(g.dy) < 3;
          latest.current.setPrefs({ splitListWidth: tapped ? DEFAULT_PREFS.splitListWidth : next });
          setDrag(null);
        },
        onPanResponderTerminate: () => setDrag(null),
      }),
    [],
  );

  const showList = split || primary === "list";
  const showDetail = split || primary === "detail";
  return (
    <CurrentCtx.Provider value={split ? current : null}>
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: p.panelBg }}>
        <View style={split ? { width: w } : showList ? { flex: 1 } : { width: 0 }}>{showList ? list : null}</View>
        {split ? (
          <View
            {...pan.panHandlers}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Resize the session list"
            accessibilityHint="Drag sideways to resize; tap to reset"
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(e) => {
              const step = e.nativeEvent.actionName === "increment" ? 40 : -40;
              setPrefs({ splitListWidth: listWidth(w + step, width) });
            }}
            hitSlop={{ left: 10, right: 10 }}
            style={{ width: 12, marginHorizontal: -6, zIndex: 2, alignItems: "center", justifyContent: "center" }}
          >
            <View style={{ position: "absolute", top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: p.border }} />
            <View style={{ width: 4, height: 44, borderRadius: 2, backgroundColor: drag !== null ? p.accent : p.textDim, opacity: drag !== null ? 1 : 0.45 }} />
          </View>
        ) : null}
        <View style={showDetail ? { flex: 1 } : { width: 0 }}>{showDetail ? children : null}</View>
      </View>
    </CurrentCtx.Provider>
  );
}
