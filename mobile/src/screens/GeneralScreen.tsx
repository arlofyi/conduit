/**
 * The Chats tab (route `General`): the computer's root chats (HQ), listed under the profile the
 * Sessions tab has selected (every chat under "All profiles"), newest first. "+" starts a chat
 * at once with nothing attached: it asks only for the agent (GeneralNew), and not even that
 * when the computer offers one. Everything else is set from inside the chat.
 */
import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { GlassCircle, Icon } from "../components/Glass";
import { useListSelection } from "../data/ListSelection";
import { ALL_PROFILES, profileName, relativeTime, resolveProfile } from "../logic/chatList";
import { agentLabel, chatsForProfile, needsAgentChoice, scopeSummary, startAgents, type RootChat } from "../logic/general";
import type { GeneralProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE, tabBarClearance } from "../theme/type";
import { useStartChat } from "./GeneralOptions";
import { OfflineStrip, useOfflineLine } from "../components/OfflineStrip";

const CLOCK_MS = 30_000;

export function GeneralScreen({ navigation }: GeneralProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { view, conn, rootChats, rootChatsSavedAt, refreshRootChats, rootChatOptions, loadRootChatOptions } = useLive();
  // Offline the list is this phone's saved copy, and its chats open read-only.
  const offline = useOfflineLine(rootChatsSavedAt);
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

  // Ask which agents a chat can run on before "+" is tapped, so starting one waits on nothing.
  const optionsLive = rootChatOptions?.live === true;
  useEffect(() => {
    if (ready && !optionsLive) void loadRootChatOptions();
  }, [ready, optionsLive, loadRootChatOptions]);

  // "+": one agent (or an older desktop) starts the chat right here; a choice opens the chooser.
  const onStarted = useCallback((chat: RootChat) => navigation.navigate("GeneralChat", { chatId: chat.id, title: chat.title }), [navigation]);
  const { start, starting, error: startError } = useStartChat(onStarted);
  const newChat = () => {
    if (rootChatOptions && !needsAgentChoice(rootChatOptions)) void start(startAgents(rootChatOptions)[0].id);
    else navigation.navigate("GeneralNew");
  };

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

  const where = view ? (sel === ALL_PROFILES ? "All profiles" : `${profileName(view, sel)} profile`) : null;
  const empty = !ready
    ? rootChats === null
      ? "Not connected to your computer. Chats you open while connected are kept on this phone."
      : "No saved chats here."
    : rootChats === null
      ? "Loading…"
      : "No chats here yet. Tap + to ask something across your projects.";

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 14, paddingBottom: 8, flexDirection: "row", alignItems: "center" }}>
        <GlassCircle symbol="ellipsis" label="Profile and computer" onPress={() => navigation.navigate("ChatsMenu")} />
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text accessibilityRole="header" style={{ fontSize: TYPE.headline, fontWeight: "600", color: p.textBright }}>
            Chats
          </Text>
          {where ? (
            <Text style={{ fontSize: TYPE.caption, color: p.textMid }} numberOfLines={1}>
              {where}
            </Text>
          ) : null}
        </View>
        <GlassCircle symbol="plus" primary label={starting ? "Starting a chat" : "New chat"} disabled={!ready || starting} onPress={newChat} />
      </View>
      {offline ? <OfflineStrip text={offline.text} tone={offline.tone} onRetry={offline.onRetry} onPress={() => navigation.navigate("Settings")} /> : null}
      {startError ? (
        <Text accessibilityLiveRegion="polite" style={{ marginHorizontal: 16, marginBottom: 8, fontSize: TYPE.footnote, color: p.red }}>
          {startError}
        </Text>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(c) => c.id}
        renderItem={({ item, index }) => (
          <ChatRow
            chat={item}
            first={index === 0}
            // a non-Claude chat says which agent answers it
            scope={item.agent && item.agent !== "claude" ? `${scopeSummary(item.scope, view)} · ${agentLabel(rootChatOptions, item.agent)}` : scopeSummary(item.scope, view)}
            time={relativeTime(item.createdAt * 1000, now)}
            onOpen={() => navigation.navigate("GeneralChat", { chatId: item.id, title: item.title })}
          />
        )}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: tabBarClearance(24, insets.bottom, Platform.OS), flexGrow: 1 }}
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
