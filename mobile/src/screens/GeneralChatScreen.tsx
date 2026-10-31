/**
 * One general chat (the computer's root chat): the same feed rendering as a session chat, a
 * composer, Stop while a turn runs, and a scope chip naming which projects it may see.
 * Proposed work is approved on the computer, so this screen never shows approval cards.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { Composer } from "../components/Composer";
import { GlassCircle, GlassSurface, Icon, MaterialBar } from "../components/Glass";
import { groupFeed } from "../logic/feed";
import { EMPTY_CHAT_INFO, EMPTY_FEED, scopeSummary } from "../logic/general";
import { layoutThread, type ThreadRow } from "../logic/thread";
import type { GeneralChatProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";
import { CopiedToast, DatePill, ThreadRowView, WorkingBubble } from "./ChatScreen";

const NO_ATTACHMENTS: never[] = [];
const noop = () => {};

export function GeneralChatScreen({ route, navigation }: GeneralChatProps) {
  const { chatId } = route.params;
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { view, conn, rootChats, rootFeeds, openRootChat, closeRootChat, sendRootChat, stopRootChat } = useLive();
  const list = useRef<FlatList<ThreadRow>>(null);

  useEffect(() => {
    openRootChat(chatId);
    return () => closeRootChat(chatId);
  }, [chatId, openRootChat, closeRootChat]);

  const chat = rootChats?.find((c) => c.id === chatId) ?? null;
  const title = chat?.title ?? route.params.title ?? "General chat";
  const state = rootFeeds[chatId] ?? EMPTY_FEED;
  const running = state.running;
  const scope = chat ? scopeSummary(chat.scope, view) : null;

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

  // Same keyboard handling as the session chat (see ChatScreen on Android's edge-to-edge).
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [androidKeyboard, setAndroidKeyboard] = useState(0);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) => {
      setKeyboardUp(true);
      if (!ios) setAndroidKeyboard(e.endCoordinates.height + insetsRef.current.bottom);
    });
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => {
      setKeyboardUp(false);
      if (!ios) setAndroidKeyboard(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const [headerH, setHeaderH] = useState(insets.top + 56);
  const [composerH, setComposerH] = useState(insets.bottom + 54);
  const ready = conn.phase === "ready";
  const info = !ready
    ? "Not connected to your computer."
    : !state.loaded
      ? "Loading…"
      : state.feed.length === 0 && !running
        ? EMPTY_CHAT_INFO
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
            />
          </View>
        </View>
      </KeyboardAvoidingView>

      <MaterialBar style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
        <View
          onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}
          style={{ paddingTop: insets.top + 4, paddingBottom: 8, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 }}
        >
          <GlassCircle symbol="chevron.left" label="Back to general chats" onPress={() => navigation.goBack()} size={38} symbolSize={16} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={{ fontWeight: "600", fontSize: TYPE.callout, color: p.textBright }} numberOfLines={1}>
              {title}
            </Text>
            {scope ? (
              <Pressable
                onPress={() => navigation.navigate("GeneralScope", { chatId })}
                accessibilityRole="button"
                accessibilityLabel={`Sees: ${scope}. Change which projects this chat can see`}
                hitSlop={6}
                style={({ pressed }) => ({
                  alignSelf: "flex-start",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderRadius: 999,
                  backgroundColor: pressed ? p.selectionBg : p.sidebarBg,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: p.border,
                })}
              >
                <Icon name="square.stack" size={10} color={p.accent} />
                <Text style={{ fontSize: TYPE.caption, color: p.accent, fontWeight: "600" }} numberOfLines={1}>
                  {scope}
                </Text>
                <Icon name="chevron.down" size={8} color={p.textMid} />
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
          ) : null}
        </View>
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.border }} />
      </MaterialBar>

      <CopiedToast at={copiedAt} top={headerH + 10} />
    </View>
  );
}
