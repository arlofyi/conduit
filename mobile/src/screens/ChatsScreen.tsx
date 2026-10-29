import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { tint } from "../logic/accent";
import {
  buildRows,
  chipsFor,
  offlineText,
  profileName,
  profileSheet,
  profileSummary,
  resolveProfile,
  type ChatFilter,
  type ProfileSel,
  type Row,
  type Section,
} from "../logic/chatList";
import { connStatus } from "../logic/connCopy";
import type { ChatsProps } from "../navigation";
import type { Palette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";

/** How long a pull-to-refresh spins without an answer before giving up. */
const REFRESH_TIMEOUT_MS = 5000;

/** The relative times only need to tick about as often as their coarsest bucket changes. */
const CLOCK_MS = 30_000;

export function ChatsScreen({ navigation }: ChatsProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { view, viewAt, refreshProjects, unread, lastSeen, conn, currentMac } = useLive();
  const macName = currentMac?.macName ?? "your Mac";

  // undefined = "not chosen yet on this Mac": follow the Mac's active profile.
  const [profileSel, setProfileSel] = useState<ProfileSel | undefined>(undefined);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [sheetOpen, setSheetOpen] = useState(false);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);
  // A fresh view re-reads the clock too, so a row that just changed never reads "1 min".
  useEffect(() => setNow(Date.now()), [viewAt]);

  const profileId = view ? resolveProfile(view, profileSel === undefined ? view.activeProfileId : profileSel) : null;
  const sections = useMemo(
    // SectionList reads each section's rows from `data`
    () => (view ? buildRows(view, { profileId, filter, unread, now }) : []).map((s) => ({ ...s, data: s.rows })),
    [view, profileId, filter, unread, now],
  );
  const chips = useMemo(() => (view ? chipsFor(view, profileId) : []), [view, profileId]);
  const sheet = useMemo(() => (view ? profileSheet(view) : []), [view]);

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

  const pickProfile = (id: ProfileSel) => {
    setProfileSel(id);
    setFilter("all");
    setSheetOpen(false);
  };

  const open = (row: Row) => {
    if (!row.openable) return;
    navigation.navigate("Chat", { sessionId: row.id, projectId: row.projectId, name: row.title, branch: row.branch });
  };

  const empty = !view
    ? ready
      ? "Loading sessions…"
      : status.text
    : filter === "needs"
      ? "Nothing needs you right now."
      : "No sessions here.";

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      {/* header */}
      <View
        style={{
          paddingTop: insets.top + 6,
          paddingHorizontal: 16,
          paddingBottom: 10,
          backgroundColor: p.sidebarBg,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: p.border,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <Text style={{ flex: 1, fontSize: TYPE.title, fontWeight: "700", color: p.textBright }}>Chats</Text>
        {view && (
          <Pressable
            onPress={() => setSheetOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Profile: ${profileName(view, profileId)}. Change profile`}
            style={{
              backgroundColor: p.selectionBg,
              borderRadius: 14,
              paddingHorizontal: 11,
              paddingVertical: 6,
              flexDirection: "row",
            }}
          >
            <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>Profile: </Text>
            <Text style={{ fontSize: TYPE.footnote, color: p.accent, fontWeight: "700" }}>
              {profileName(view, profileId)}
            </Text>
            <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}> ▾</Text>
          </Pressable>
        )}
      </View>

      {/* slim offline bar */}
      {offline && (
        <Pressable
          onPress={() => navigation.navigate("Settings")}
          accessibilityRole="button"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
            paddingHorizontal: 16,
            paddingVertical: 6,
            backgroundColor: p.selectionBg,
          }}
        >
          <View
            style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status.tone === "busy" ? p.amber : p.red }}
          />
          <Text style={{ flex: 1, fontSize: TYPE.caption, color: p.textMid }} numberOfLines={1}>
            {offline}
          </Text>
        </Pressable>
      )}

      {/* filter chips */}
      {chips.length > 0 && (
        <View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}
          >
            {chips.map((c) => (
              <ChipView key={c.key} chip={c} on={filter === c.key} needs={c.key === "needs"} onPress={() => setFilter(c.key)} />
            ))}
          </ScrollView>
        </View>
      )}

      <SectionList<Row, Section>
        sections={sections}
        keyExtractor={(r) => r.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            enabled={ready}
            tintColor={p.accent}
            colors={[p.accent]}
          />
        }
        renderSectionHeader={({ section }) =>
          section.title === null ? null : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 }}>
              {section.color && <Swatch color={section.color} />}
              <Text
                style={{
                  fontSize: TYPE.micro,
                  fontWeight: "600",
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  color: p.textMid,
                  flexShrink: 1,
                }}
                numberOfLines={1}
              >
                {section.title}
              </Text>
              <View style={{ flex: 1 }} />
              <Text style={{ fontSize: TYPE.micro, color: p.textDim }}>
                {section.count} session{section.count === 1 ? "" : "s"}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => <ChatRow row={item} onPress={() => open(item)} />}
        ListEmptyComponent={
          <View style={{ paddingVertical: 40, paddingHorizontal: 24, alignItems: "center" }}>
            <Text style={{ color: p.textMid, fontSize: TYPE.subhead, textAlign: "center" }}>{empty}</Text>
          </View>
        }
      />

      <ProfileSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        entries={sheet}
        selected={profileId}
        onPick={pickProfile}
        p={p}
        bottomInset={insets.bottom}
      />
    </View>
  );
}

function Swatch({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

function ChipView({
  chip,
  on,
  needs,
  onPress,
}: {
  chip: { label: string; color: string | null };
  on: boolean;
  needs: boolean;
  onPress: () => void;
}) {
  const { palette: p } = useTheme();
  const bg = needs ? (on ? p.amber : p.pillNeedsBg) : on ? p.accent : p.chipBg;
  const fg = on ? p.panelBg : needs ? p.pillNeedsText : p.chipText;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      hitSlop={{ top: 8, bottom: 8 }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 11,
        paddingVertical: 6,
        borderRadius: 14,
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: needs ? p.amber : "transparent",
      }}
    >
      {chip.color && <Swatch color={chip.color} />}
      <Text style={{ fontSize: TYPE.caption, color: fg, fontWeight: on ? "700" : "500" }}>{chip.label}</Text>
    </Pressable>
  );
}

function ChatRow({ row, onPress }: { row: Row; onPress: () => void }) {
  const { palette: p } = useTheme();
  const dot = row.dot === "needs" ? p.amber : row.dot === "running" ? p.green : p.textDim;
  const pv = row.preview;
  const previewColor = pv.tone === "running" ? p.green : pv.tone === "private" ? p.textDim : p.textMid;
  const state = row.dot === "needs" ? "needs you" : row.dot === "running" ? "working" : "idle";
  return (
    <Pressable
      onPress={onPress}
      disabled={!row.openable}
      accessibilityRole="button"
      accessibilityState={{ disabled: !row.openable }}
      accessibilityLabel={`${row.title}, ${state}${row.unread ? `, ${row.unread} unread` : ""}${row.openable ? "" : ", private session, open it on your Mac"}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: MIN_TOUCH + 16,
        paddingHorizontal: 16,
        paddingVertical: 9,
        backgroundColor: pressed ? p.selectionBg : row.needs ? p.needsBg : "transparent",
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: p.border,
        opacity: row.openable ? 1 : 0.5,
      })}
    >
      {/* avatar: agent initials on the project's colour, status dot */}
      <View
        style={{
          width: 42,
          height: 42,
          borderRadius: 21,
          backgroundColor: tint(row.color, 0.18) ?? p.selectionBg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: row.color, fontWeight: "700", fontSize: TYPE.footnote }}>{row.initials}</Text>
        <View
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 12,
            height: 12,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: p.panelBg,
            backgroundColor: dot,
          }}
        />
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <Text style={{ flex: 1, fontSize: TYPE.subhead, fontWeight: "600", color: p.textBright }} numberOfLines={1}>
            {row.title}
          </Text>
          {row.time !== "" && <Text style={{ fontSize: TYPE.micro, color: p.textMid }}>{row.time}</Text>}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
          <Text
            style={{ flex: 1, fontSize: TYPE.footnote, color: previewColor, fontStyle: pv.tone === "private" ? "italic" : "normal" }}
            numberOfLines={1}
          >
            {pv.prefix && <Text style={{ color: p.pillNeedsText, fontWeight: "600" }}>{pv.prefix} </Text>}
            {pv.text}
          </Text>
          {row.unread > 0 && (
            <View
              style={{
                backgroundColor: row.needs ? p.amber : p.accent,
                borderRadius: 10,
                minWidth: 20,
                paddingHorizontal: 6,
                paddingVertical: 1,
                alignItems: "center",
              }}
            >
              <Text style={{ color: p.panelBg, fontSize: TYPE.micro, fontWeight: "700" }}>{row.unread}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function ProfileSheet({
  open,
  onClose,
  entries,
  selected,
  onPick,
  p,
  bottomInset,
}: {
  open: boolean;
  onClose: () => void;
  entries: ReturnType<typeof profileSheet>;
  selected: ProfileSel;
  onPick: (id: ProfileSel) => void;
  p: Palette;
  bottomInset: number;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} onPress={onClose} accessibilityLabel="Close" />
      <View
        style={{
          backgroundColor: p.sidebarBg,
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: p.border,
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: bottomInset + 20,
        }}
      >
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: p.textDim, alignSelf: "center", marginBottom: 12 }} />
        <Text style={{ fontSize: TYPE.callout, fontWeight: "700", color: p.textBright, marginBottom: 6 }}>Profile</Text>
        {entries.map((e) => {
          const on = e.id === selected;
          const sum = profileSummary(e);
          return (
            <Pressable
              key={e.id ?? "default"}
              onPress={() => onPick(e.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                minHeight: MIN_TOUCH,
                paddingVertical: 10,
                paddingHorizontal: 4,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: p.border,
              }}
            >
              <Text style={{ width: 14, color: p.accent }}>{on ? "✓" : ""}</Text>
              <Text
                style={{ flex: 1, fontSize: TYPE.subhead, color: on ? p.accent : p.textBright, fontWeight: on ? "600" : "400" }}
                numberOfLines={1}
              >
                {e.name}
              </Text>
              <Text style={{ fontSize: TYPE.caption, color: p.textMid }}>
                {sum.projects}
                {sum.needs && (
                  <Text style={{ color: p.pillNeedsText }}>
                    {" · "}
                    {sum.needs}
                  </Text>
                )}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Modal>
  );
}
