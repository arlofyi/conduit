import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import type { WireDiff } from "../bridge/protocol";
import { AgentAvatar, useReduceMotion } from "../components/AgentAvatar";
import { AssistantMarkdown } from "../components/AssistantMarkdown";
import { ChatBubble } from "../components/ChatBubble";
import { Composer } from "../components/Composer";
import { GlassCircle, GlassSurface, Icon, MaterialBar } from "../components/Glass";
import type {
  ApprovalItem,
  CommandItem,
  DividerItem,
  ImageItem,
  NoticeItem,
  PlanItem,
  QuestionItem,
  TodosItem,
} from "../data/types";
import { glyphStateFor } from "../logic/agents";
import { chatHeader } from "../logic/chatHeader";
import { outputPreview, splitRecommended } from "../logic/chatView";
import { mix, readableInk } from "../logic/color";
import { groupFeed, groupLabel, type Call, type FeedRow } from "../logic/feed";
import { holdPosition, isPinned, newItemCount, shouldFollow } from "../logic/follow";
import { imageDataUri } from "../logic/image";
import { layoutThread, type ThreadRow } from "../logic/thread";
import type { ChatProps } from "../navigation";
import { hq } from "../theme/hq";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, MONO, TYPE } from "../theme/type";

const DIFF_CAP = 16;
/** Only the newest few rows animate in: a re-attach re-maps the whole history, and a wall of
 * bubbles all sliding at once would be noise, not arrival. */
const ANIMATE_NEWEST = 3;

export function ChatScreen({ route, navigation }: ChatProps) {
  const { sessionId, projectId, name } = route.params;
  const { palette: p } = useTheme();
  const h = hq(p);
  const insets = useSafeAreaInsets();
  const { sessionLive, context, view, attach, detach, prompt } = useLive();
  const list = useRef<FlatList<ThreadRow>>(null);

  // Attach to this session's live stream (transcript history + tail + status) while the screen
  // is mounted. Attaching also clears its unread count. Detach names the session, so a chat
  // replaced by another (banner tap) cannot detach its successor.
  useEffect(() => {
    attach(sessionId);
    return () => detach(sessionId);
  }, [sessionId, attach, detach]);

  const header = chatHeader({
    view,
    sessionId,
    projectId,
    fallbackName: name,
    live: { status: sessionLive.status, at: sessionLive.statusAt },
    context,
  });
  const session = useMemo(() => {
    for (const pr of view?.projects ?? []) {
      const s = pr.sessions.find((x) => x.id === sessionId);
      if (s) return { project: pr, session: s };
    }
    return null;
  }, [view, sessionId]);
  const projectName = session?.project.name ?? null;

  // A chat opened the moment it was spawned attaches before its transcript exists, and the Mac
  // fixes the transcript it tails at attach — so the conversation would never arrive. While the
  // feed is still empty, re-attach whenever the list shows the session has moved on.
  const activityKey = `${session?.session.lastMessage?.at ?? ""}|${session?.session.updatedAt ?? ""}`;
  const feedEmpty = sessionLive.feed.length === 0;
  const lastKey = useRef(activityKey);
  const [listGen, setListGen] = useState(0);
  useEffect(() => {
    if (activityKey === lastKey.current) return;
    lastKey.current = activityKey;
    if (!feedEmpty) return;
    attach(sessionId);
    setListGen((g) => g + 1); // a fresh list: the old one kept a scroll position for content it no longer has
  }, [activityKey, feedEmpty, attach, sessionId]);

  const feed = sessionLive.feed;
  const rows = useMemo(() => groupFeed(feed), [feed]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [rows.length]);
  const thread = useMemo(() => layoutThread(rows, now), [rows, now]);
  // Inverted list: newest first, so offset 0 is the bottom of the conversation.
  const data = useMemo(() => [...thread].reverse(), [thread]);

  // Rows that arrived while the chat was open animate in; the first history load does not.
  const firstLoad = useRef<number | null>(null);
  if (firstLoad.current === null && rows.length > 0) firstLoad.current = rows.length;
  const animateFrom = firstLoad.current === null ? Infinity : Math.max(firstLoad.current, rows.length - ANIMATE_NEWEST);
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r, i])), [rows]);

  // Follow rule (logic/follow.ts): only a reader at the bottom follows new rows.
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const sentRef = useRef(false);
  const prevLen = useRef(0);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const pin = isPinned(e.nativeEvent.contentOffset.y);
    if (pin !== pinnedRef.current) {
      pinnedRef.current = pin;
      setPinned(pin);
      if (pin) setUnseen(0);
    }
  }, []);
  useEffect(() => {
    const added = newItemCount(prevLen.current, rows.length);
    prevLen.current = rows.length;
    if (shouldFollow(pinnedRef.current, added, sentRef.current)) {
      list.current?.scrollToOffset({ offset: 0, animated: true });
    } else if (added > 0 && !pinnedRef.current) {
      setUnseen((n) => n + added);
    }
    if (added > 0) sentRef.current = false;
  }, [rows.length]);

  const jumpToLatest = () => {
    list.current?.scrollToOffset({ offset: 0, animated: true });
    setUnseen(0);
  };

  const send = (text: string) => {
    prompt(sessionId, text); // bracketed paste + Enter into the live PTY; the echo comes back as a chat frame
    sentRef.current = true;
    pinnedRef.current = true;
    setPinned(true);
    setUnseen(0);
    list.current?.scrollToOffset({ offset: 0, animated: true });
  };

  // "Copied" confirmation for a long-pressed bubble.
  const [copiedAt, setCopiedAt] = useState(0);
  const onCopied = useCallback(() => setCopiedAt(Date.now()), []);

  const decide = useCallback((_id: string, _decision: "allow" | "deny") => {
    // approvals arrive via the broker (a later phase); no-op in the read channel
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ThreadRow }) => {
      if (item.type === "date") return <DatePill label={item.label} />;
      const i = rowIndex.get(item.row) ?? 0;
      return <ThreadRowView t={item} animateIn={i >= animateFrom} onDecide={decide} onCopied={onCopied} />;
    },
    [rowIndex, animateFrom, decide, onCopied],
  );

  // With the keyboard up there is no home indicator to clear, so the composer sits on the keys.
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", () => setKeyboardUp(true));
    const hide = Keyboard.addListener("keyboardWillHide", () => setKeyboardUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const [headerH, setHeaderH] = useState(insets.top + 56);
  const [composerH, setComposerH] = useState(insets.bottom + 54);
  const running = header.state === "running";
  const stateColor = header.state === "needs" ? p.amber : running ? p.green : p.textMid;
  const ringState = glyphStateFor(
    header.state === "needs" ? "needsInput" : header.state === "running" ? "running" : sessionLive.status === "done" ? "done" : "idle",
    session?.session.running ?? false,
  );
  const accent = readableInk(session ? (header.color ?? p.accent) : p.accent, p.textBright, p.panelBg);

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {/* KAV pads itself; this inner view shrinks with it, so the absolute composer rides the keyboard */}
        <View style={{ flex: 1 }}>
        {/* the conversation scrolls under both floating bars */}
        <FlatList
          key={listGen}
          ref={list}
          inverted
          data={data}
          keyExtractor={threadKey}
          renderItem={renderItem}
          style={{ flex: 1 }}
          // inverted: paddingTop is the visual BOTTOM (above the composer), paddingBottom the top
          contentContainerStyle={{ paddingHorizontal: 10, paddingTop: composerH + 6, paddingBottom: headerH + 10 }}
          scrollIndicatorInsets={{ top: composerH, bottom: headerH }}
          ListHeaderComponent={running ? <WorkingBubble activity={sessionLive.activity} /> : null}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={onScroll}
          scrollEventThrottle={32}
          maintainVisibleContentPosition={holdPosition(pinned)}
          initialNumToRender={20}
          windowSize={11}
        />

        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
          {!pinned && (
            <View style={{ position: "absolute", right: 12, top: -52, alignItems: "center" }}>
              <GlassCircle symbol="chevron.down" label={unseen > 0 ? `Jump to latest, ${unseen} new` : "Jump to latest"} onPress={jumpToLatest} size={40} />
              {unseen > 0 && (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: -6,
                    right: -4,
                    minWidth: 20,
                    height: 20,
                    borderRadius: 10,
                    paddingHorizontal: 5,
                    backgroundColor: p.accent,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: p.meText, fontSize: TYPE.caption, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{unseen}</Text>
                </View>
              )}
            </View>
          )}
          <Composer
            name={header.name}
            bottomInset={keyboardUp ? 0 : insets.bottom}
            onSend={send}
            onActions={() => navigation.navigate("QuickActions", { sessionId, running })}
            onHeight={setComposerH}
          />
        </View>
        </View>
      </KeyboardAvoidingView>

      {/* header: system material, the project's colour as a thin rule under it */}
      <MaterialBar style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
        <View
          onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}
          style={{ paddingTop: insets.top + 4, paddingBottom: 8, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 }}
        >
          <GlassCircle symbol="chevron.left" label="Back to chats" onPress={() => navigation.goBack()} size={38} symbolSize={16} />
          <Pressable
            onPress={() => navigation.navigate("SessionInfo", { sessionId, projectId })}
            accessibilityRole="button"
            accessibilityLabel={`${header.name}, ${projectName ?? ""} ${header.subline}. Session details`}
            style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 9, opacity: pressed ? 0.7 : 1 })}
          >
            <AgentAvatar agent={session?.session.agent ?? ""} projectColor={header.color} state={ringState} size={34} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontWeight: "600", fontSize: TYPE.callout, color: p.textBright }} numberOfLines={1}>
                {header.name}
              </Text>
              <Text style={{ fontSize: TYPE.caption, marginTop: 1 }} numberOfLines={1}>
                {projectName ? <Text style={{ color: accent, fontWeight: "600" }}>{projectName}</Text> : null}
                {projectName ? <Text style={{ color: p.textDim }}>{"  ·  "}</Text> : null}
                <Text style={{ color: stateColor }}>{header.subline}</Text>
              </Text>
            </View>
          </Pressable>
          {header.canStop && (
            <Pressable
              onPress={() => navigation.navigate("QuickActions", { sessionId, running: true })}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Stop or steer the current turn"
            >
              <GlassSurface interactive style={{ height: 34, borderRadius: 17, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Icon name="stop.fill" size={11} color={p.red} />
                <Text style={{ color: p.red, fontSize: TYPE.footnote, fontWeight: "600" }}>Stop</Text>
              </GlassSurface>
            </Pressable>
          )}
        </View>
        <View style={{ height: 1, backgroundColor: header.color ? mix(header.color, p.panelBg, 0.55) : h.hairline }} />
      </MaterialBar>

      <CopiedToast at={copiedAt} top={headerH + 10} />
    </View>
  );
}

function threadKey(t: ThreadRow): string {
  return t.key;
}

function ThreadRowView({
  t,
  animateIn,
  onDecide,
  onCopied,
}: {
  t: Extract<ThreadRow, { type: "row" }>;
  animateIn: boolean;
  onDecide: (id: string, d: "allow" | "deny") => void;
  onCopied: () => void;
}) {
  const row: FeedRow = t.row;
  const pad = { marginTop: 8 };
  if (row.type === "tools") return <View style={pad}><ToolsRow calls={row.calls} /></View>;
  if (row.type === "call") return <View style={pad}><CallLine call={row.call} /></View>;
  const item = row.item;
  switch (item.kind) {
    case "bubble":
      return <ChatBubble role={item.role} text={item.text} time={t.time} first={t.first} animateIn={animateIn} onCopied={onCopied} />;
    case "todos":
      return <View style={pad}><TodosCard item={item} /></View>;
    case "approval":
      return <View style={pad}><ApprovalCard item={item} onDecide={onDecide} /></View>;
    case "notice":
      return <View style={pad}><NotePill item={item} /></View>;
    case "divider":
      return <View style={pad}><DividerRow item={item} /></View>;
    case "command":
      return <View style={pad}><CommandChip item={item} /></View>;
    case "image":
      return <View style={pad}><ImageRow item={item} /></View>;
    case "question":
      return <View style={pad}><QuestionCard item={item} /></View>;
    case "plan":
      return <View style={pad}><PlanCard item={item} /></View>;
  }
}

/** "Today" / "Yesterday" / date, centred between days. */
function DatePill({ label }: { label: string }) {
  const { palette: p } = useTheme();
  return (
    <View style={{ alignItems: "center", marginTop: 14, marginBottom: 4 }}>
      <View
        style={{
          paddingHorizontal: 11,
          paddingVertical: 4,
          borderRadius: 9,
          backgroundColor: p.sidebarBg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: p.border,
        }}
      >
        <Text style={{ fontSize: TYPE.caption, fontWeight: "600", color: p.textMid }}>{label}</Text>
      </View>
    </View>
  );
}

/** The agent at work: WhatsApp's typing bubble, carrying what it is doing right now (hook `activity`). */
function WorkingBubble({ activity }: { activity?: string }) {
  const { palette: p } = useTheme();
  const reduce = useReduceMotion();
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [reduce, t]);
  const dot = (i: number) => {
    const a = i / 3;
    const opacity = reduce
      ? 0.6
      : t.interpolate({ inputRange: [0, a, a + 0.2, Math.min(1, a + 0.4), 1], outputRange: [0.3, 0.3, 1, 0.3, 0.3], extrapolate: "clamp" });
    return <Animated.View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.textMid, opacity }} />;
  };
  return (
    <View
      accessible
      accessibilityLabel={activity ? `Working: ${activity}` : "Working"}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8, marginLeft: 8 }}
    >
      <View
        style={{
          flexDirection: "row",
          gap: 4,
          paddingHorizontal: 13,
          paddingVertical: 12,
          borderRadius: 16,
          borderTopLeftRadius: 4,
          backgroundColor: p.selectionBg,
        }}
      >
        {[0, 1, 2].map(dot)}
      </View>
      {activity ? (
        <Text style={{ flexShrink: 1, fontSize: TYPE.footnote, color: p.textMid }} numberOfLines={1}>
          {activity}
        </Text>
      ) : null}
    </View>
  );
}

function CopiedToast({ at, top }: { at: number; top: number }) {
  const { palette: p } = useTheme();
  const o = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!at) return;
    o.setValue(0);
    Animated.sequence([
      Animated.timing(o, { toValue: 1, duration: 160, useNativeDriver: true }),
      Animated.delay(1100),
      Animated.timing(o, { toValue: 0, duration: 260, useNativeDriver: true }),
    ]).start();
  }, [at, o]);
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", top, alignSelf: "center", opacity: o }}>
      <GlassSurface style={{ borderRadius: 16, paddingHorizontal: 14, height: 32, flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="doc.on.doc" size={13} color={p.textBright} />
        <Text style={{ color: p.textBright, fontSize: TYPE.footnote, fontWeight: "600" }}>Copied</Text>
      </GlassSurface>
    </Animated.View>
  );
}

// ---- the desktop chat mode's language (src/theme.css .hq-*) ----

/** `.hq-note`: a quiet centred pill; tap shows its body under a hairline rule. */
function NotePill({ item }: { item: NoticeItem }) {
  const { palette: p } = useTheme();
  const h = hq(p);
  const [open, setOpen] = useState(false);
  const mark = item.tone === "ok" ? p.green : item.tone === "bad" ? p.red : p.textMid;
  return (
    <View style={{ alignItems: "center", gap: 6 }}>
      <Pressable
        disabled={!item.detail}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole={item.detail ? "button" : "text"}
        accessibilityState={item.detail ? { expanded: open } : undefined}
        style={{
          maxWidth: "92%",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 4,
          borderRadius: 999,
          backgroundColor: mix(p.selectionBg, p.panelBg, 0.4),
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: mix(p.border, p.panelBg, 0.6),
        }}
      >
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: mark }} />
        <Text style={{ color: p.textMid, fontSize: TYPE.footnote, flexShrink: 1 }} numberOfLines={1}>
          {item.text}
        </Text>
        {item.detail ? <Icon name={open ? "chevron.up" : "chevron.down"} size={9} color={p.textDim} /> : null}
      </Pressable>
      {open && item.detail ? (
        <Text
          style={{
            alignSelf: "stretch",
            marginHorizontal: 8,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderLeftWidth: 1,
            borderLeftColor: h.line2,
            color: h.ink2,
            fontSize: TYPE.footnote,
            lineHeight: 18,
          }}
        >
          {item.detail}
        </Text>
      ) : null}
    </View>
  );
}

/** `.hq-divider`: a label between two hairlines; amber for a warning (an interruption). */
function DividerRow({ item }: { item: DividerItem }) {
  const { palette: p } = useTheme();
  const warn = item.tone === "warning";
  const color = warn ? p.amber : p.textMid;
  const line = { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: warn ? mix(p.amber, p.panelBg, 0.4) : p.border };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 4, paddingHorizontal: 6 }}>
      <View style={line} />
      <Text style={{ color, fontSize: TYPE.caption }}>{item.label}</Text>
      <View style={line} />
    </View>
  );
}

/** `.hq-command`: the slash command in mono on the accent wash, output beneath. */
function CommandChip({ item }: { item: CommandItem }) {
  const { palette: p } = useTheme();
  const h = hq(p);
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: "86%", alignItems: "flex-end", gap: 5, marginRight: 8 }}>
      {item.name ? (
        <View style={{ backgroundColor: h.roseSoft, borderWidth: 1, borderColor: h.roseLine, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
          <Text style={{ color: p.accent, fontFamily: MONO, fontSize: 13 }}>
            {item.name}
            {item.args ? ` ${item.args}` : ""}
          </Text>
        </View>
      ) : null}
      {item.output ? <CommandOutput text={item.output} /> : null}
    </View>
  );
}

function CommandOutput({ text }: { text: string }) {
  const { palette: p } = useTheme();
  const h = hq(p);
  const [open, setOpen] = useState(false);
  const view = outputPreview(text, open);
  const long = open || view.hidden > 0;
  return (
    <Pressable
      disabled={!long}
      onPress={() => setOpen((o) => !o)}
      accessibilityRole={long ? "button" : undefined}
      accessibilityState={long ? { expanded: open } : undefined}
      style={{ alignSelf: "stretch", backgroundColor: h.code, borderWidth: StyleSheet.hairlineWidth, borderColor: p.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, gap: 4 }}
    >
      <Text style={{ color: h.ink2, fontFamily: MONO, fontSize: 12.5, lineHeight: 17 }}>{view.text}</Text>
      {long ? <Text style={{ color: p.textMid, fontSize: TYPE.caption }}>{open ? "Show less" : `${view.hidden} more lines`}</Text> : null}
    </Pressable>
  );
}

function ImageRow({ item }: { item: ImageItem }) {
  const { palette: p } = useTheme();
  const uri = imageDataUri(item.mediaType, item.data);
  if (uri) {
    return (
      <Image
        source={{ uri }}
        resizeMode="cover"
        accessibilityLabel="Image"
        style={{ alignSelf: "flex-end", width: 220, height: 220, borderRadius: 12, marginRight: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: p.border }}
      />
    );
  }
  return (
    <View style={{ alignSelf: "flex-end", flexDirection: "row", alignItems: "center", gap: 6, marginRight: 8, backgroundColor: p.sidebarBg, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 6 }}>
      <Icon name="photo" size={13} color={p.textMid} />
      <Text style={{ color: p.textMid, fontSize: TYPE.footnote }}>Image</Text>
    </View>
  );
}

/** `.hq-question`: a question Claude asked earlier — history, so neutral, not amber. */
function QuestionCard({ item }: { item: QuestionItem }) {
  const { palette: p } = useTheme();
  const h = hq(p);
  return (
    <View style={[cardStyle(p), { gap: 12 }]}>
      {item.questions.map((q, i) => (
        <View key={i} style={{ gap: 7 }}>
          {q.header ? <Tag text={q.header} /> : null}
          <Text style={{ color: p.textBright, fontSize: TYPE.callout, fontWeight: "600", lineHeight: 21 }}>{q.question}</Text>
          {q.options.map((o, j) => {
            const { label, recommended } = splitRecommended(o.label);
            return (
              <View key={j} style={{ flexDirection: "row", gap: 10 }}>
                <Text style={{ color: p.textDim, fontSize: 12, fontFamily: MONO, width: 14, marginTop: 2 }}>{j + 1}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                    <Text style={{ color: p.textBright, fontSize: TYPE.subhead }}>{label}</Text>
                    {recommended ? (
                      <View style={{ borderWidth: 1, borderColor: h.roseLine, borderRadius: 999, paddingHorizontal: 6 }}>
                        <Text style={{ color: p.accent, fontSize: 11 }}>Recommended</Text>
                      </View>
                    ) : null}
                  </View>
                  {o.description ? <Text style={{ color: p.textMid, fontSize: TYPE.footnote, lineHeight: 18 }}>{o.description}</Text> : null}
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function PlanCard({ item }: { item: PlanItem }) {
  const { palette: p } = useTheme();
  return (
    <View style={[cardStyle(p), { gap: 8 }]}>
      <Tag text="Plan" />
      <AssistantMarkdown text={item.markdown} />
    </View>
  );
}

/** `.hq-question-header` / `.hq-plan-title`: small uppercase accent tag. */
function Tag({ text }: { text: string }) {
  const { palette: p } = useTheme();
  const h = hq(p);
  return (
    <View style={{ alignSelf: "flex-start", backgroundColor: h.roseSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color: p.accent, fontSize: 11, letterSpacing: 0.66, fontWeight: "600" }}>{text.toUpperCase()}</Text>
    </View>
  );
}

function cardStyle(p: ReturnType<typeof useTheme>["palette"]) {
  return {
    marginHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: p.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: mix(p.selectionBg, p.panelBg, 0.35),
  } as const;
}

/** `.hq-call-glyph`: a dot that says how the call went (shape + label, never hue alone). */
function CallMark({ status }: { status: Call["status"] }) {
  const { palette: p } = useTheme();
  const size = 7;
  if (status === "error") return <Icon name="xmark" size={9} color={p.red} weight="bold" />;
  const filled = status === "ok";
  return (
    <View
      accessibilityLabel={status}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: filled ? p.green : "transparent",
        borderWidth: filled ? 0 : 1.2,
        borderColor: status === "running" ? p.accent : p.textDim,
      }}
    />
  );
}

/** `.hq-tool-line`: verb in the quiet ink, the object in mono. */
function CallLine({ call }: { call: Call }) {
  const { palette: p } = useTheme();
  const e = call.event;
  return (
    <View style={{ gap: 4, paddingHorizontal: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 20 }}>
        <View style={{ width: 10, alignItems: "center" }}>
          <CallMark status={call.status} />
        </View>
        <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>{e.label}</Text>
        {e.mono ? (
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12.5, color: p.textMid, fontFamily: MONO }}>
            {e.mono}
          </Text>
        ) : null}
      </View>
      {call.status === "error" && call.errorText ? (
        <Text style={{ marginLeft: 18, fontSize: TYPE.footnote, color: p.red, lineHeight: 18 }}>{call.errorText}</Text>
      ) : null}
      {call.diff ? <DiffBlock diff={call.diff} /> : null}
    </View>
  );
}

/** A run of quiet calls folded to one digest line; tap lists them. */
function ToolsRow({ calls }: { calls: Call[] }) {
  const { palette: p } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: MIN_TOUCH - 12, paddingHorizontal: 10 }}
      >
        <View style={{ width: 10, alignItems: "center" }}>
          <Icon name={open ? "chevron.down" : "chevron.right"} size={9} color={p.textDim} weight="semibold" />
        </View>
        <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>{groupLabel(calls)}</Text>
      </Pressable>
      {open && (
        <View style={{ marginLeft: 14, paddingLeft: 4, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: p.border, gap: 6 }}>
          {calls.map((c) => (
            <CallLine key={c.event.id} call={c} />
          ))}
        </View>
      )}
    </View>
  );
}

/** `.hq-diff`: mono, add/del in the ok/bad inks, a rule down its left like the desktop's. */
function DiffBlock({ diff }: { diff: WireDiff }) {
  const { palette: p } = useTheme();
  const rows = diff.lines.slice(0, DIFF_CAP);
  const hidden = diff.more + (diff.lines.length - rows.length);
  const ink = (k: string) => (k === "add" ? p.green : k === "del" ? p.red : p.textMid);
  const mark = (k: string) => (k === "add" ? "+" : k === "del" ? "-" : " ");
  const mono = { fontSize: 11.5, lineHeight: 16, fontFamily: MONO };
  return (
    <View style={{ marginLeft: 18, borderLeftWidth: 2, borderLeftColor: p.textDim, paddingLeft: 8, gap: 1 }}>
      {diff.created ? (
        <Text style={[mono, { color: p.green }]}>created · +{diff.added} lines</Text>
      ) : (
        <Text style={mono}>
          <Text style={{ color: p.green }}>+{diff.added}</Text>
          <Text style={{ color: p.textDim }}> </Text>
          <Text style={{ color: p.red }}>−{diff.removed}</Text>
        </Text>
      )}
      {rows.map((l, i) =>
        l.kind === "gap" ? (
          <Text key={i} style={[mono, { color: p.textDim }]}>
            ⋮
          </Text>
        ) : (
          <Text key={i} numberOfLines={1} style={[mono, { color: ink(l.kind) }]}>
            {mark(l.kind)} {l.text}
          </Text>
        ),
      )}
      {hidden > 0 && <Text style={[mono, { color: p.textDim }]}>{hidden} more lines</Text>}
    </View>
  );
}

function TodosCard({ item }: { item: TodosItem }) {
  const { palette: p } = useTheme();
  return (
    <View style={[cardStyle(p), { gap: 8 }]}>
      <Text style={{ fontSize: TYPE.subhead, fontWeight: "600", color: p.textBright, fontVariant: ["tabular-nums"] }}>
        To-dos · {item.done}/{item.total}
      </Text>
      {item.items.map((t, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
          <Icon
            name={t.status === "completed" ? "checkmark.circle.fill" : t.status === "in_progress" ? "circle.lefthalf.filled" : "circle"}
            size={15}
            color={t.status === "completed" ? p.green : t.status === "in_progress" ? p.accent : p.textDim}
          />
          <Text
            style={{
              flex: 1,
              fontSize: TYPE.subhead,
              color: t.status === "pending" ? p.textMid : p.textBright,
              textDecorationLine: t.status === "completed" ? "line-through" : "none",
            }}
          >
            {t.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ApprovalCard({ item, onDecide }: { item: ApprovalItem; onDecide: (id: string, d: "allow" | "deny") => void }) {
  const { palette: p } = useTheme();
  if (item.resolved) {
    const allowed = item.resolved === "allow";
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 }}>
        <Icon name={allowed ? "checkmark" : "xmark"} size={11} color={allowed ? p.green : p.red} weight="bold" />
        <Text style={{ color: p.textMid, fontSize: TYPE.footnote }}>
          {allowed ? "Approved" : "Denied"} · {item.tool}
        </Text>
        <Text style={{ color: p.textDim, fontSize: 12.5, fontFamily: MONO, flexShrink: 1 }} numberOfLines={1}>
          {item.input}
        </Text>
      </View>
    );
  }
  return (
    <View style={{ marginHorizontal: 8, backgroundColor: p.pillNeedsBg, borderWidth: 1, borderColor: mix(p.amber, p.panelBg, 0.6), borderRadius: 12, padding: 13, gap: 11 }}>
      <Text style={{ color: p.pillNeedsText, fontWeight: "600", fontSize: TYPE.callout }}>Approval needed · {item.tool}</Text>
      <View style={{ backgroundColor: p.panelBg, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 9 }}>
        <Text style={{ color: p.textBright, fontFamily: MONO, fontSize: 13 }}>{item.input}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable
          onPress={() => onDecide(item.id, "deny")}
          style={{ flex: 1, minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: p.selectionBg }}
        >
          <Text style={{ color: p.red, fontWeight: "600", fontSize: TYPE.callout }}>Deny</Text>
        </Pressable>
        <Pressable
          onPress={() => onDecide(item.id, "allow")}
          style={{ flex: 1, minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: p.green }}
        >
          <Text style={{ color: p.onGreen, fontWeight: "600", fontSize: TYPE.callout }}>Approve</Text>
        </Pressable>
      </View>
    </View>
  );
}
