/**
 * The General tab: the computer's root chats (HQ), listed under the profile the Chats tab has
 * selected (every chat under "All profiles"), newest first. "+" starts one that sees the
 * selected profile's projects, or everything under "All profiles".
 */
import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { GlassCircle, Icon } from "../components/Glass";
import { useListSelection } from "../data/ListSelection";
import { ALL_PROFILES, profileName, relativeTime, resolveProfile } from "../logic/chatList";
import { chatsForProfile, createProfileId, defaultScope, scopeSummary, type RootChat } from "../logic/general";
import type { GeneralProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";

const CLOCK_MS = 30_000;

export function GeneralScreen({ navigation }: GeneralProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { view, conn, rootChats, refreshRootChats, createRootChat } = useLive();
  const { profileSel } = useListSelection();
  const ready = conn.phase === "ready";

  // Asking subscribes this socket to the chats' live events too.
  useFocusEffect(
    useCallback(() => {
      refreshRootChats();
    }, [refreshRootChats]),
  );
  useEffect(() => {
    if (ready) refreshRootChats();
  }, [ready, refreshRootChats]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);

  const sel = view ? resolveProfile(view, profileSel === undefined ? view.activeProfileId : profileSel) : null;
  const rows = useMemo(() => (rootChats ? chatsForProfile(rootChats, sel, view) : []), [rootChats, sel, view]);

  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => setRefreshing(false), [rootChats]);
  useEffect(() => {
    if (!refreshing) return;
    const t = setTimeout(() => setRefreshing(false), 5000);
    return () => clearTimeout(t);
  }, [refreshing]);

  const [creating, setCreating] = useState(false);
  const create = async () => {
    if (creating) return;
    setCreating(true);
    const r = await createRootChat(createProfileId(sel, view), defaultScope(sel));
    setCreating(false);
    if (r.ok) navigation.navigate("GeneralChat", { chatId: r.chat.id, title: r.chat.title });
    else Alert.alert("Couldn't start a chat", r.error);
  };

  const where = view ? (sel === ALL_PROFILES ? "All profiles" : `${profileName(view, sel)} profile`) : null;
  const empty = !ready
    ? "Not connected to your computer."
    : rootChats === null
      ? "Loading…"
      : "No general chats here yet. Tap + to ask something across your projects.";

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 14, paddingBottom: 8, flexDirection: "row", alignItems: "center" }}>
        <GlassCircle symbol="ellipsis" label="Profile and computer" onPress={() => navigation.navigate("ChatsMenu")} />
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text accessibilityRole="header" style={{ fontSize: TYPE.headline, fontWeight: "600", color: p.textBright }}>
            General
          </Text>
          {where ? (
            <Text style={{ fontSize: TYPE.caption, color: p.textMid }} numberOfLines={1}>
              {where}
            </Text>
          ) : null}
        </View>
        <GlassCircle symbol="plus" primary label="New general chat" disabled={!ready || creating} onPress={create} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(c) => c.id}
        renderItem={({ item, index }) => (
          <ChatRow
            chat={item}
            first={index === 0}
            scope={scopeSummary(item.scope, view)}
            time={relativeTime(item.createdAt * 1000, now)}
            onOpen={() => navigation.navigate("GeneralChat", { chatId: item.id, title: item.title })}
          />
        )}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 24, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              refreshRootChats();
            }}
            enabled={ready}
            tintColor={p.accent}
            colors={[p.accent]}
          />
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

function ChatRow({ chat, first, scope, time, onOpen }: { chat: RootChat; first: boolean; scope: string; time: string; onOpen: () => void }) {
  const { palette: p } = useTheme();
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${chat.title}, ${scope}${chat.running ? ", working" : ""}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: MIN_TOUCH + 20,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: pressed ? p.selectionBg : "transparent",
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: p.border,
      })}
    >
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: p.selectionBg, alignItems: "center", justifyContent: "center" }}>
        <Icon name="sparkles" size={18} color={p.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ flex: 1, fontSize: TYPE.body, fontWeight: "600", color: p.textBright }} numberOfLines={1}>
            {chat.title}
          </Text>
          <Text style={{ fontSize: TYPE.footnote, color: p.textMid, fontVariant: ["tabular-nums"] }}>{time}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {chat.running ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.green }} /> : null}
          <Text style={{ flex: 1, fontSize: TYPE.subhead, color: chat.running ? p.green : p.textMid }} numberOfLines={1}>
            {chat.running ? `Working · ${scope}` : scope}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
