/**
 * One general chat (the computer's root chat): the same feed rendering as a session chat, a
 * composer, Stop while a turn runs, and an "attached" chip naming what it knows about ("No
 * projects attached" for a new chat); tapping it opens the settings at the attach picker.
 * Proposed work is approved on the computer, so this screen never shows approval cards. The
 * header names the chat's agent + model and opens its settings; `/` in the composer offers the
 * computer's skills.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { Composer, type ComposerSuggestion } from "../components/Composer";
import { GlassCircle, GlassSurface, Icon, MaterialBar } from "../components/Glass";
import { groupFeed } from "../logic/feed";
import { attachedSummary, chatBadge, emptyChatInfo, EMPTY_FEED, insertSkill, isUnattached, skillSuggestions } from "../logic/general";
import { layoutThread, type ThreadRow } from "../logic/thread";
import type { GeneralChatProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { CopiedToast, DatePill, ThreadRowView, WorkingBubble } from "./ChatScreen";
import { OfflineStrip, useOfflineLine } from "../components/OfflineStrip";
import { chatFeedSource, OFFLINE_COMPOSER_HINT, OFFLINE_NOT_SAVED } from "../logic/offlineCache";

const NO_ATTACHMENTS: never[] = [];
const noop = () => {};

export function GeneralChatScreen({ route, navigation }: GeneralChatProps) {
  const { chatId } = route.params;
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { view, conn, rootChats, rootFeeds, rootCache, openRootChat, closeRootChat, sendRootChat, stopRootChat, rootChatOptions, loadRootChatOptions } = useLive();
  const list = useRef<FlatList<ThreadRow>>(null);

  useEffect(() => {
    openRootChat(chatId);
    return () => closeRootChat(chatId);
  }, [chatId, openRootChat, closeRootChat]);

  const chat = rootChats?.find((c) => c.id === chatId) ?? null;
  const title = chat?.title ?? route.params.title ?? "Chat";
  const live = rootFeeds[chatId] ?? EMPTY_FEED;
  // The computer's history wins; until it arrives (or while offline) the saved copy reads.
  const source = chatFeedSource(live.loaded, rootCache[chatId]);
  const state = source.from === "cache" ? { ...live, feed: source.items } : live;
  const savedAt = source.from === "cache" ? source.savedAt : null;
  const offline = useOfflineLine(savedAt);
  const running = state.running && conn.phase === "ready";
  const scope = chat ? attachedSummary(chat.scope, view) : null;
  const unattached = isUnattached(chat?.scope);
  const badge = chat ? chatBadge(chat, rootChatOptions) : null;

  // Skills for `/` in the composer, and agent/model names for the header.
  // Asked once per chat open / reconnect until a live answer arrives (an older desktop never
  // answers, and then the header simply names the agent).
  const connected = conn.phase === "ready";
  const optionsLive = rootChatOptions?.live === true;
  useEffect(() => {
    if (connected && !optionsLive) void loadRootChatOptions();
  }, [connected, optionsLive, chatId, loadRootChatOptions]);
  const skills = rootChatOptions?.skills;
  const suggest = useCallback(
    (draft: string): ComposerSuggestion[] =>
      skills ? skillSuggestions(draft, skills).map((k) => ({ key: k.name, label: `/${k.name}`, detail: k.description || undefined, insert: insertSkill(k.name) })) : [],
    [skills],
  );

  const thread = useMemo(() => layoutThread(groupFeed(state.feed), Date.now()), [state.feed]);
  const data = useMemo(() => [...thread].reverse(), [thread]);

  const [copiedAt, setCopiedAt] = useState(0);
  const onCopied = useCallback(() => setCopiedAt(Date.now()), []);
  const renderItem = useCallback(
    ({ item }: { item: ThreadRow }) =>
      item.type === "date" ? (
        <DatePill label={item.label} />
      ) : (
        <ThreadRowView t={item} animateIn={false} onDecide={noop} onAnswer={noop} onCopied={onCopied} />
      ),
    [onCopied],
  );

  const send = (text: string) => {
    if (!sendRootChat(chatId, text)) return;
    list.current?.scrollToOffset({ offset: 0, animated: true });
  };

  // Same keyboard handling as the session chat (see useKeyboardInset on Android's edge-to-edge).
  const { keyboardUp, androidKeyboard } = useKeyboardInset();

  const [headerH, setHeaderH] = useState(insets.top + 56);
  const [composerH, setComposerH] = useState(insets.bottom + 54);
  const ready = conn.phase === "ready";
  const info = !ready
    ? state.feed.length > 0
      ? null
      : offline?.tone === "busy"
        ? "Connecting…"
        : OFFLINE_NOT_SAVED
    : !state.loaded && savedAt === null
      ? "Loading…"
      : state.feed.length === 0 && !running
        ? emptyChatInfo(chat?.agent, chat?.scope)
        : null;

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <KeyboardAvoidingView
        style={{ flex: 1, paddingBottom: androidKeyboard }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        enabled={Platform.OS === "ios"}
      >
        <View style={{ flex: 1 }}>
          <FlatList
            ref={list}
            inverted
            data={data}
            keyExtractor={(t) => t.key}
            renderItem={renderItem}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 10, paddingTop: composerH + 6, paddingBottom: headerH + 10 }}
            scrollIndicatorInsets={{ top: composerH, bottom: headerH }}
            ListHeaderComponent={running ? <WorkingBubble /> : null}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            initialNumToRender={20}
            windowSize={11}
          />

          {info ? (
            <View pointerEvents="none" style={{ position: "absolute", left: 24, right: 24, top: headerH, bottom: composerH, justifyContent: "center", alignItems: "center" }}>
              <View
                accessible
                accessibilityRole="text"
                style={{ maxWidth: 320, flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 14, backgroundColor: p.sidebarBg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.border }}
              >
                <Icon name={ready ? "info.circle" : "wifi.slash"} size={16} color={p.textMid} />
                <Text style={{ flex: 1, color: p.textMid, fontSize: TYPE.subhead, lineHeight: 20 }}>{info}</Text>
              </View>
            </View>
          ) : null}

          <View
            style={[
              { position: "absolute", left: 0, right: 0, bottom: 0 },
              Platform.OS === "android" && { backgroundColor: p.panelBg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border },
            ]}
          >
            <Composer
              name={title}
              bottomInset={keyboardUp ? 0 : insets.bottom + (Platform.OS === "android" ? 8 : 0)}
              onSend={send}
              attachments={NO_ATTACHMENTS}
              onRemoveAttachment={noop}
              onHeight={setComposerH}
              suggest={suggest}
              offline={ready ? undefined : OFFLINE_COMPOSER_HINT}
            />
          </View>
        </View>
      </KeyboardAvoidingView>

      <MaterialBar style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
        <View onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}>
        <View
          style={{ paddingTop: insets.top + 4, paddingBottom: 8, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 }}
        >
          <GlassCircle symbol="chevron.left" label="Back to chats" onPress={() => navigation.goBack()} size={38} symbolSize={16} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={{ fontWeight: "600", fontSize: TYPE.callout, color: p.textBright }} numberOfLines={1}>
              {title}
            </Text>
            {badge ? (
              <Text style={{ fontSize: TYPE.caption, color: p.textMid }} numberOfLines={1} accessibilityLabel={`Runs on ${badge}`}>
                {badge}
              </Text>
            ) : null}
            {scope ? (
              // A MIN_TOUCH-high touch box around the small chip; the negative margin keeps the
              // header's height as it was.
              <Pressable
                onPress={() => navigation.navigate("GeneralSettings", { chatId, attach: true })}
                accessibilityRole="button"
                accessibilityLabel={`${scope}. Attach profiles or projects to this chat`}
                style={{ alignSelf: "flex-start", maxWidth: "100%", minHeight: MIN_TOUCH, marginVertical: -12, justifyContent: "center" }}
              >
                {({ pressed }) => (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      borderRadius: 999,
                      backgroundColor: pressed ? p.selectionBg : p.sidebarBg,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: p.border,
                    }}
                  >
                    <Icon name={unattached ? "paperclip" : "square.stack"} size={10} color={unattached ? p.textMid : p.accent} />
                    <Text style={{ flexShrink: 1, fontSize: TYPE.caption, color: unattached ? p.textMid : p.accent, fontWeight: "600" }} numberOfLines={1}>
                      {scope}
                    </Text>
                    <Icon name="chevron.down" size={8} color={p.textMid} />
                  </View>
                )}
              </Pressable>
            ) : null}
          </View>
          {running ? (
            <Pressable onPress={() => stopRootChat(chatId)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Stop this turn">
              <GlassSurface interactive style={{ height: 34, borderRadius: 17, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Icon name="stop.fill" size={11} color={p.red} />
                <Text maxFontSizeMultiplier={1.6} style={{ color: p.red, fontSize: TYPE.footnote, fontWeight: "600" }}>
                  Stop
                </Text>
              </GlassSurface>
            </Pressable>
          ) : chat ? (
            <GlassCircle
              symbol="slider.horizontal.3"
              label="Chat settings: attached projects, model, effort, deep research, MCP servers"
              onPress={() => navigation.navigate("GeneralSettings", { chatId })}
              size={36}
              symbolSize={15}
            />
          ) : null}
        </View>
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.border }} />
        {offline ? <OfflineStrip text={offline.text} tone={offline.tone} onRetry={offline.onRetry} inset={14} /> : null}
        </View>
      </MaterialBar>

      <CopiedToast at={copiedAt} top={headerH + 10} />
    </View>
  );
}
