import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, BackHandler, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { AgentAvatar } from "../components/AgentAvatar";
import { GlassCircle, Icon } from "../components/Glass";
import { confirmText, prune, resultText, toggle, type SessionAction } from "../logic/selection";
import { useListSelection } from "../data/ListSelection";
import { mix, readableInk } from "../logic/color";
import {
  buildRows,
  chipsFor,
  offlineText,
  resolveFilter,
  resolveProfile,
  sameRow,
  type Chip,
  type Row,
} from "../logic/chatList";
import { connStatus } from "../logic/connCopy";
import { openBySession } from "../logic/pending";
import type { ChatsProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";

/** How long a pull-to-refresh spins without an answer before giving up. */
const REFRESH_TIMEOUT_MS = 5000;

/** Row times only change at minute granularity. */
const CLOCK_MS = 30_000;

const AVATAR = 52;
/** the avatar's footprint including its ring (AgentAvatar) */
const AVATAR_OUTER = AVATAR + 8;
const GUTTER = 14;
const TEXT_INSET = GUTTER + AVATAR_OUTER + 12;

export function ChatsScreen({ navigation }: ChatsProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { view, viewAt, refreshProjects, unread, lastSeen, conn, currentMac, pending, sessionAction } = useLive();
  // Pushed questions/permissions lead their rows at once, ahead of the 10 s poll.
  const openPending = useMemo(() => openBySession(pending), [pending]);
  const { profileSel, filter, setFilter } = useListSelection();
  const macName = currentMac?.macName ?? "your computer";

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);
  // A fresh view re-reads the clock too, so a row that just changed shows the right time.
  useEffect(() => setNow(Date.now()), [viewAt]);

  const profileId = view ? resolveProfile(view, profileSel === undefined ? view.activeProfileId : profileSel) : null;
  const chips = useMemo(() => (view ? chipsFor(view, profileId, openPending) : []), [view, profileId, openPending]);
  // A filter whose chip is gone (nothing left to count, project removed) shows All.
  const activeFilter = view ? resolveFilter(chips, filter) : filter;
  const rows = useMemo(
    () => (view ? buildRows(view, { profileId, filter: activeFilter, unread, now, pending: openPending }) : []),
    [view, profileId, activeFilter, unread, now, openPending],
  );

  // Pull to refresh: spin until the next view lands (or give up quietly).
  const [refreshing, setRefreshing] = useState(false);
  const refreshStartedAt = useRef(0);
  useEffect(() => {
    if (refreshing && viewAt > refreshStartedAt.current) setRefreshing(false);
  }, [refreshing, viewAt]);
  useEffect(() => {
    if (!refreshing) return;
    const t = setTimeout(() => setRefreshing(false), REFRESH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [refreshing]);
  const onRefresh = useCallback(() => {
    refreshStartedAt.current = Date.now();
    setRefreshing(true);
    refreshProjects();
  }, [refreshProjects]);

  const ready = conn.phase === "ready";
  const status = connStatus(conn, macName);
  // A plain drop reads "<Mac> offline · last seen …"; a reason (refused, update needed) wins.
  const plainDrop = !conn.error || conn.error.kind === "closed";
  const offline = ready ? null : lastSeen !== null && plainDrop ? offlineText(macName, lastSeen, now) : status.text;

  // Multi-select: a long press starts it (WhatsApp's gesture), taps then add or remove, and
  // the top bar turns into the actions. Private sessions are never selectable: the computer
  // would refuse them anyway.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const selecting = selected.size > 0;
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  useEffect(() => setSelected((sel) => prune(sel, rowIds)), [rowIds]);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  useEffect(() => {
    if (!selecting) return;
    // Android back leaves selection mode instead of leaving the screen.
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      clearSelection();
      return true;
    });
    return () => sub.remove();
  }, [selecting, clearSelection]);
  const select = useCallback((row: Row) => {
    if (row.openable) setSelected((sel) => toggle(sel, row.id));
  }, []);

  const open = useCallback(
    (row: Row) => {
      if (!row.openable) return;
      if (selecting) {
        select(row);
        return;
      }
      navigation.navigate("Chat", { sessionId: row.id, projectId: row.projectId, name: row.title, branch: row.branch });
    },
    [navigation, selecting, select],
  );

  const [acting, setActing] = useState(false);
  const run = useCallback(
    (action: SessionAction) => {
      const ids = [...selected];
      if (ids.length === 0 || acting) return;
      const running = rows.filter((r) => selected.has(r.id) && r.dot === "running").length;
      const go = async () => {
        setActing(true);
        const r = await sessionAction(action, ids);
        setActing(false);
        if (r.ok) clearSelection();
        if (!r.ok || r.skipped.length > 0) Alert.alert(action === "delete" ? "Delete" : "Stop", resultText(action, r));
      };
      const ask = confirmText(action, ids.length, running);
      if (!ask) {
        void go();
        return;
      }
      Alert.alert(ask.title, ask.body, [
        { text: "Cancel", style: "cancel" },
        { text: action === "delete" ? "Delete" : "Stop", style: "destructive", onPress: () => void go() },
      ]);
    },
    [selected, acting, rows, sessionAction, clearSelection],
  );

  // The bar's hairline appears only once the list has scrolled under it, as iOS bars do.
  const [scrolled, setScrolled] = useState(false);

  const empty = !view
    ? ready
      ? "Loading sessions…"
      : status.text
    : activeFilter === "needs"
      ? "Nothing needs you right now."
      : view.projects.length === 0
        ? `No projects on ${macName} yet.`
        : "No sessions here yet. Tap + to start one.";

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      {selecting ? (
        <SelectionBar
          count={selected.size}
          top={insets.top}
          busy={acting || !ready}
          onCancel={clearSelection}
          onAll={() => setSelected(new Set(rows.filter((r) => r.openable).map((r) => r.id)))}
          onStop={() => run("stop")}
          onDelete={() => run("delete")}
        />
      ) : (
      /* compact top bar: "…" (profile, Switch computer) · Chats · "+" (new chat) */
      <View
        style={{
          paddingTop: insets.top + 4,
          paddingHorizontal: GUTTER,
          paddingBottom: 8,
          flexDirection: "row",
          alignItems: "center",
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: scrolled ? p.border : "transparent",
        }}
      >
        <GlassCircle symbol="ellipsis" label="Profile and computer" onPress={() => navigation.navigate("ChatsMenu")} />
        <Text
          accessibilityRole="header"
          style={{ flex: 1, textAlign: "center", fontSize: TYPE.headline, fontWeight: "600", color: p.textBright }}
        >
          Chats
        </Text>
        <GlassCircle
          symbol="plus"
          primary
          label="New chat"
          disabled={!ready || !view || view.projects.length === 0}
          onPress={() => navigation.navigate("NewChat")}
        />
      </View>
      )}

      {offline && (
        <Pressable
          onPress={() => navigation.navigate("Settings")}
          accessibilityRole="button"
          style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: GUTTER + 2, paddingVertical: 6 }}
        >
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status.tone === "busy" ? p.amber : p.red }} />
          <Text style={{ flex: 1, fontSize: TYPE.footnote, color: p.textMid }} numberOfLines={1}>
            {offline}
          </Text>
        </Pressable>
      )}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => (
          <ChatRow row={item} onOpen={open} onLongPress={select} selecting={selecting} selected={selected.has(item.id)} />
        )}
        extraData={selected}
        ItemSeparatorComponent={Separator}
        contentInsetAdjustmentBehavior="automatic"
        onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 2)}
        scrollEventThrottle={64}
        contentContainerStyle={{ paddingBottom: 24, flexGrow: 1 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} enabled={ready} tintColor={p.accent} colors={[p.accent]} />
        }
        ListHeaderComponent={
          chips.length > 1 ? <ChipBar chips={chips} active={activeFilter} onPick={setFilter} /> : null
        }
        ListEmptyComponent={
          <View style={{ paddingVertical: 48, paddingHorizontal: 32, alignItems: "center" }}>
            <Text style={{ color: p.textMid, fontSize: TYPE.subhead, textAlign: "center", lineHeight: 21 }}>{empty}</Text>
          </View>
        }
      />
    </View>
  );
}

function Separator() {
  const { palette: p } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, marginLeft: TEXT_INSET, backgroundColor: p.border }} />;
}

function ChipBar({ chips, active, onPick }: { chips: Chip[]; active: string; onPick: (k: string) => void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 7, paddingHorizontal: GUTTER, paddingTop: 4, paddingBottom: 8 }}
    >
      {chips.map((c) => (
        <ChipView key={c.key} chip={c} on={active === c.key} onPress={() => onPick(c.key)} />
      ))}
    </ScrollView>
  );
}

/** Slim outlined chips; the selected one takes a tint of its own colour, as WhatsApp's does. */
function ChipView({ chip, on, onPress }: { chip: Chip; on: boolean; onPress: () => void }) {
  const { palette: p } = useTheme();
  const hue = chip.needs ? p.amber : chip.color ?? p.accent;
  const fg = on ? (chip.needs ? p.pillNeedsText : p.textBright) : chip.needs ? p.pillNeedsText : p.textMid;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      hitSlop={{ top: 8, bottom: 8 }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 30,
        paddingHorizontal: 12,
        borderRadius: 15,
        borderWidth: 1,
        borderColor: on ? mix(hue, p.panelBg, 0.55) : chip.needs ? mix(p.amber, p.panelBg, 0.4) : p.border,
        backgroundColor: on ? mix(hue, p.panelBg, 0.16) : pressed ? p.sidebarBg : "transparent",
      })}
    >
      {chip.color && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: chip.color }} />}
      <Text maxFontSizeMultiplier={1.6} style={{ fontSize: TYPE.footnote, color: fg, fontWeight: on ? "600" : "500", fontVariant: ["tabular-nums"] }}>
        {chip.label}
      </Text>
    </Pressable>
  );
}

/** The top bar while sessions are selected: cancel, count, select all, stop, delete. */
function SelectionBar({
  count,
  top,
  busy,
  onCancel,
  onAll,
  onStop,
  onDelete,
}: {
  count: number;
  top: number;
  busy: boolean;
  onCancel: () => void;
  onAll: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const { palette: p } = useTheme();
  return (
    <View
      style={{
        paddingTop: top + 4,
        paddingHorizontal: GUTTER,
        paddingBottom: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        backgroundColor: p.sidebarBg,
      }}
    >
      <GlassCircle symbol="xmark" label="Cancel selection" onPress={onCancel} />
      <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={{ flex: 1, fontSize: TYPE.headline, fontWeight: "600", color: p.textBright }}>
        {count} selected
      </Text>
      <GlassCircle symbol="checklist" label="Select all" onPress={onAll} disabled={busy} />
      <GlassCircle symbol="stop.circle" label={`Stop ${count} selected`} onPress={onStop} disabled={busy} />
      <GlassCircle symbol="trash" label={`Delete ${count} selected`} onPress={onDelete} disabled={busy} />
    </View>
  );
}

/** Memoized by row VALUE: rows are rebuilt on every poll/clock tick, and most do not change. */
const ChatRow = React.memo(
  ChatRowView,
  (a, b) =>
    a.onOpen === b.onOpen &&
    a.onLongPress === b.onLongPress &&
    a.selecting === b.selecting &&
    a.selected === b.selected &&
    sameRow(a.row, b.row),
);

function ChatRowView({
  row,
  onOpen,
  onLongPress,
  selecting,
  selected,
}: {
  row: Row;
  onOpen: (row: Row) => void;
  onLongPress: (row: Row) => void;
  selecting: boolean;
  selected: boolean;
}) {
  const { palette: p } = useTheme();
  const pv = row.preview;
  const unread = row.unread > 0;
  const previewColor = pv.tone === "running" ? p.green : pv.tone === "needs" ? p.pillNeedsText : pv.tone === "private" ? p.textDim : p.textMid;
  const state = row.dot === "needs" ? "needs you" : row.dot === "running" ? "working" : "idle";
  return (
    <Pressable
      onPress={() => onOpen(row)}
      onLongPress={() => onLongPress(row)}
      delayLongPress={350}
      disabled={!row.openable}
      accessibilityRole={selecting ? "checkbox" : "button"}
      accessibilityState={{ disabled: !row.openable, ...(selecting ? { checked: selected } : {}) }}
      accessibilityHint={selecting ? undefined : "Long press to select"}
      accessibilityLabel={`${row.title}, ${row.projectName}, ${state}${row.time ? `, ${row.time}` : ""}${unread ? `, ${row.unread} unread` : ""}. ${pv.prefix ?? ""} ${pv.text}${row.openable ? "" : ". Private session, open it on your computer"}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingLeft: GUTTER,
        paddingRight: GUTTER + 2,
        paddingVertical: 9,
        backgroundColor: selected || pressed ? p.selectionBg : "transparent",
        opacity: row.openable ? 1 : 0.55,
      })}
    >
      <View>
        <AgentAvatar agent={row.agent} projectColor={row.color} state={row.glyph} size={AVATAR} />
        {selected ? (
          <View
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: p.accent,
              borderWidth: 2,
              borderColor: p.panelBg,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="checkmark" size={12} color={p.meText} weight="bold" />
          </View>
        ) : null}
      </View>

      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text style={{ flex: 1, fontSize: TYPE.body, fontWeight: "600", color: p.textBright }} numberOfLines={1}>
            {row.title}
          </Text>
          {row.time !== "" && (
            <Text
              style={{
                fontSize: TYPE.footnote,
                color: unread ? (row.needs ? p.amber : p.accent) : p.textMid,
                fontWeight: unread ? "600" : "400",
                fontVariant: ["tabular-nums"],
              }}
            >
              {row.time}
            </Text>
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <Text
            style={{ flex: 1, fontSize: TYPE.subhead, lineHeight: 20, color: previewColor, fontStyle: pv.tone === "private" ? "italic" : "normal" }}
            numberOfLines={2}
          >
            <Text style={{ color: readableInk(row.color, p.textBright, p.panelBg), fontWeight: "600" }}>{row.projectName}</Text>
            <Text style={{ color: p.textDim }}>{"  ·  "}</Text>
            {pv.prefix && (
              <Text style={{ color: pv.tone === "needs" ? p.pillNeedsText : p.textBright, fontWeight: "600" }}>{pv.prefix} </Text>
            )}
            {pv.text}
          </Text>
          {unread && (
            <View
              style={{
                marginTop: 1,
                backgroundColor: row.needs ? p.amber : p.accent,
                borderRadius: 10,
                minWidth: 20,
                height: 20,
                paddingHorizontal: 6,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text maxFontSizeMultiplier={1.3} style={{ color: p.meText, fontSize: TYPE.caption, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                {row.unread}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}
