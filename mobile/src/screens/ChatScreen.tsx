import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  AppState,
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
import { Composer, type AttachSource } from "../components/Composer";
import { pickFiles, pickPhotos, takePhoto, type Picked } from "../data/pickAttachments";
import { composeMessage, formatBytes, decodedBytes, MAX_ATTACHMENTS, tooLarge, type Attachment } from "../logic/attachments";
import { GlassCircle, GlassSurface, Icon, MaterialBar } from "../components/Glass";
import { cardStyle, QuestionCard, Tag, TrailingCard, type OnAnswer, type OnApprove } from "../components/PendingCards";
import type {
  ApprovalItem,
  CommandItem,
  DividerItem,
  ImageItem,
  NoticeItem,
  PlanItem,
  TodosItem,
} from "../data/types";
import { chatOnPhone, glyphStateFor, NO_PHONE_CHAT_TEXT } from "../logic/agents";
import { PRIVATE_SESSION_TEXT } from "../logic/frames";
import { chatHeader } from "../logic/chatHeader";
import { outputPreview } from "../logic/chatView";
import { mix, readableInk } from "../logic/color";
import { callVerb, groupFeed, groupLabel, type Call, type FeedRow } from "../logic/feed";
import { holdPosition, isPinned, newItemCount, newKeys, shouldFollow } from "../logic/follow";
import { imageDataUri } from "../logic/image";
import { cardView, entryForToolUse, nextExpiry, sameCard, trailingEntries, type CardView } from "../logic/pending";
import { layoutThread, sameFeedRow, type ThreadRow } from "../logic/thread";
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
  const { sessionLive, context, view, attach, detach, prompt, pending, answer, approve, upload } = useLive();
  const list = useRef<FlatList<DisplayRow>>(null);

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
  const agent = session?.session.agent ?? "";
  // The Mac follows the session onto a new transcript itself (/clear, a just-spawned chat) and
  // re-sends `history`, so the chat never has to re-attach to catch up.

  const feed = sessionLive.feed;
  const rows = useMemo(() => groupFeed(feed), [feed]);
  // "Today"/"Yesterday" go stale past midnight: re-read the clock every minute and on return
  // to the foreground (a timer does not run while the app is suspended).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const t = setInterval(tick, 60_000);
    const sub = AppState.addEventListener("change", (s) => s === "active" && tick());
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, []);
  const thread = useMemo(() => layoutThread(rows, now), [rows, now]);

  // Rows that arrived while the chat was open animate in; the first history load does not.
  const firstLoad = useRef<number | null>(null);
  if (firstLoad.current === null && rows.length > 0) firstLoad.current = rows.length;
  const animateFrom = firstLoad.current === null ? Infinity : Math.max(firstLoad.current, rows.length - ANIMATE_NEWEST);
  // Inverted list: newest first, so offset 0 is the bottom of the conversation. Each row carries
  // its own animateIn, so renderItem never changes and a memoised row re-renders only when ITS
  // content does.
  // A question your computer is holding joins its transcript card by tool_use id and makes it live;
  // permissions (and questions whose transcript card has not landed yet) sit at the end.
  // `pendingNow` moves only when a settled standalone card's linger ends.
  const [pendingNow, setPendingNow] = useState(() => Date.now());
  useEffect(() => {
    const at = nextExpiry(pending, Date.now());
    if (at === null) return;
    const t = setTimeout(() => setPendingNow(Date.now()), Math.max(0, at - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [pending, pendingNow]);
  const data = useMemo(() => {
    const index = new Map(rows.map((r, i) => [r, i]));
    const asked = new Set<string>();
    const out = thread.map((t): DisplayRow => {
      if (t.type === "date") return t;
      const it = t.row.type === "item" ? t.row.item : null;
      let card: CardView | undefined;
      if (it?.kind === "question") {
        asked.add(it.toolUseId);
        const e = entryForToolUse(pending, sessionId, it.toolUseId);
        if (e) card = cardView(e);
      }
      return { ...t, animateIn: (index.get(t.row) ?? 0) >= animateFrom, card };
    });
    const trailing = trailingEntries(pending, sessionId, asked, pendingNow).map(
      (e): DisplayRow => ({ type: "pending", key: `pending-${e.item.id}`, card: cardView(e) }),
    );
    return [...out, ...trailing].reverse();
  }, [thread, rows, animateFrom, pending, sessionId, pendingNow]);

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
  // A permission or question card arriving at the end of the feed has no transcript row, so
  // the count above never sees it: a reader scrolled up hears of it through the "new" pill.
  const trailingKeys = useMemo(() => data.filter((d) => d.type === "pending").map((d) => d.key), [data]);
  const seenTrailing = useRef<Set<string>>(new Set());
  useEffect(() => {
    const added = newKeys(seenTrailing.current, trailingKeys);
    seenTrailing.current = new Set(trailingKeys);
    if (added > 0 && !pinnedRef.current) setUnseen((n) => n + added);
  }, [trailingKeys]);
  // A question or permission turning live (on open, or as it arrives) is the one thing the
  // reader must see whole. Its card is taller than the static one it replaces, and it grows
  // after the list has settled, so a reader at the bottom is put back at offset 0 once it has
  // laid out -- never a reader scrolled up into history.
  const liveCards = useMemo(
    () => data.flatMap((d) => (d.type !== "date" && d.card && (d.card.mode === "live" || d.card.mode === "sending") ? [d.card.item.id] : [])),
    [data],
  );
  const seenLive = useRef<Set<string>>(new Set());
  useEffect(() => {
    const added = newKeys(seenLive.current, liveCards);
    seenLive.current = new Set(liveCards);
    if (!shouldFollow(pinnedRef.current, added)) return;
    const t = setTimeout(() => list.current?.scrollToOffset({ offset: 0, animated: true }), 60);
    return () => clearTimeout(t);
  }, [liveCards]);

  const jumpToLatest = () => {
    list.current?.scrollToOffset({ offset: 0, animated: true });
    setUnseen(0);
  };

  // Files for the next message. Each uploads the moment it is picked, so Send is instant.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const patchAttachment = useCallback((id: string, patch: Partial<Attachment>) => {
    setAttachments((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);
  const startUpload = useCallback(
    (f: Picked) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const base: Attachment = { id, name: f.name, kind: f.kind, uri: f.uri, state: "uploading" };
      if (tooLarge(f.data)) {
        setAttachments((l) => [
          ...l,
          { ...base, state: "failed", error: `${formatBytes(decodedBytes(f.data))} is over the 10 MB limit for one file.` },
        ]);
        return;
      }
      setAttachments((l) => [...l, base]);
      upload(sessionId, f.name, f.data).then((r) =>
        patchAttachment(id, r.ok ? { state: "ready", path: r.path } : { state: "failed", error: r.error }),
      );
    },
    [sessionId, upload, patchAttachment],
  );
  const onAttach = useCallback(
    async (source: AttachSource) => {
      const room = MAX_ATTACHMENTS - attachments.length;
      if (room <= 0) {
        Alert.alert("That's the most for one message", `Send these ${MAX_ATTACHMENTS} first.`);
        return;
      }
      try {
        const picked =
          source === "photos" ? await pickPhotos(room) : source === "camera" ? [await takePhoto()].filter((x): x is Picked => !!x) : await pickFiles(room);
        picked.forEach(startUpload);
      } catch (e) {
        Alert.alert("Couldn't attach that", e instanceof Error ? e.message : String(e));
      }
    },
    [attachments.length, startUpload],
  );
  const removeAttachment = useCallback((id: string) => setAttachments((l) => l.filter((a) => a.id !== id)), []);

  const send = (typed: string) => {
    const text = composeMessage(typed, attachments);
    if (!text.trim()) return;
    setAttachments([]);
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
    // legacy transcript approval items carry no broker id; live permissions use PermissionCard
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: DisplayRow }) => {
      if (item.type === "date") return <DatePill label={item.label} />;
      if (item.type === "pending") return <PendingRowView card={item.card} onAnswer={answer} onApprove={approve} />;
      return (
        <ThreadRowView
          t={item}
          animateIn={item.animateIn}
          card={item.card}
          onDecide={decide}
          onAnswer={answer}
          onCopied={onCopied}
        />
      );
    },
    [decide, onCopied, answer, approve],
  );
  const refused = sessionLive.refused === "private";
  // Only Claude's conversation reaches the phone (its transcript); say so rather than show nothing.
  const notice = refused ? PRIVATE_SESSION_TEXT : session && !chatOnPhone(agent) && feed.length === 0 ? NO_PHONE_CHAT_TEXT : null;

  // With the keyboard up there is no home indicator to clear, so the composer sits on the keys.
  // Android fires no keyboardWill* events, only keyboardDid*. It also gets the keyboard's
  // height applied by hand (`androidKeyboard`), not by KeyboardAvoidingView: the app is
  // edge-to-edge (forced from Android 15), the window no longer resizes for the keyboard, and
  // KAV's Android arm left its padding behind after the keyboard closed (measured on a vivo
  // X200 Pro, Android 16), floating the composer over an empty band.
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [androidKeyboard, setAndroidKeyboard] = useState(0);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) => {
      setKeyboardUp(true);
      // React Native reports the IME inset MINUS the navigation bar (ReactRootView:
      // ime.bottom - systemBars.bottom), but this screen runs under the nav bar
      // (edge-to-edge), so the composer must clear both. Without the nav bar's share it sat
      // one nav-bar height too low, behind the keys (measured on the vivo, 3-button nav).
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
  const running = header.state === "running";
  // A private chat shows only its notice: no typing bubble and no rows under it. The Mac sends
  // nothing of that session, so the bubble would only be guessing, and any card for it is a
  // private one that repeats the notice -- either would be drawn beneath the centred notice.
  const typing = running && !refused;
  const rowsShown = refused ? NO_ROWS : data;
  const stateColor = header.state === "needs" ? p.amber : running ? p.green : p.textMid;
  const ringState = glyphStateFor(
    header.state === "needs" ? "needsInput" : header.state === "running" ? "running" : sessionLive.status === "done" ? "done" : "idle",
    session?.session.running ?? false,
  );
  const accent = readableInk(session ? (header.color ?? p.accent) : p.accent, p.textBright, p.panelBg);

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <KeyboardAvoidingView
        style={{ flex: 1, paddingBottom: androidKeyboard }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        enabled={Platform.OS === "ios"}
      >
        {/* KAV pads itself; this inner view shrinks with it, so the absolute composer rides the keyboard */}
        <View style={{ flex: 1 }}>
        {/* the conversation scrolls under both floating bars */}
        <FlatList
          ref={list}
          inverted
          data={rowsShown}
          keyExtractor={threadKey}
          renderItem={renderItem}
          style={{ flex: 1 }}
          // inverted: paddingTop is the visual BOTTOM (above the composer), paddingBottom the top
          contentContainerStyle={{ paddingHorizontal: 10, paddingTop: composerH + 6, paddingBottom: headerH + 10 }}
          scrollIndicatorInsets={{ top: composerH, bottom: headerH }}
          ListHeaderComponent={typing ? <WorkingBubble activity={sessionLive.activity} /> : null}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={onScroll}
          scrollEventThrottle={32}
          maintainVisibleContentPosition={holdPosition(pinned)}
          initialNumToRender={20}
          windowSize={11}
        />

        {notice ? (
          <View pointerEvents="none" style={{ position: "absolute", left: 24, right: 24, top: headerH, bottom: composerH, justifyContent: "center", alignItems: "center" }}>
            <View
              accessible
              accessibilityRole="text"
              style={{ maxWidth: 320, flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 14, backgroundColor: p.sidebarBg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.border }}
            >
              <Icon name={refused ? "lock.fill" : "laptopcomputer"} size={16} color={p.textMid} />
              <Text style={{ flex: 1, color: p.textMid, fontSize: TYPE.subhead, lineHeight: 20 }}>{notice}</Text>
            </View>
          </View>
        ) : null}

        {/* iOS: the conversation scrolls under the composer's glass. Android has no glass, so
            the bar is solid: otherwise text shows through beside and below the controls. */}
        <View
          style={[
            { position: "absolute", left: 0, right: 0, bottom: 0 },
            Platform.OS === "android" && { backgroundColor: p.panelBg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border },
          ]}
        >
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
                  <Text maxFontSizeMultiplier={1.3} style={{ color: p.meText, fontSize: TYPE.caption, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{unseen}</Text>
                </View>
              )}
            </View>
          )}
          {refused ? null : (
            <Composer
              name={header.name}
              bottomInset={keyboardUp ? 0 : insets.bottom}
              onSend={send}
              attachments={attachments}
              onAttach={onAttach}
              onRemoveAttachment={removeAttachment}
              onHeight={setComposerH}
            />
          )}
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
          {!header.canStop && (
            <GlassCircle
              symbol="slider.horizontal.3"
              label="Steer: compact or clear the conversation"
              onPress={() => navigation.navigate("QuickActions", { sessionId, running, agent })}
              size={38}
              symbolSize={17}
            />
          )}
          {header.canStop && (
            <Pressable
              onPress={() => navigation.navigate("QuickActions", { sessionId, running: true, agent })}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Stop or steer the current turn"
            >
              <GlassSurface interactive style={{ height: 34, borderRadius: 17, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Icon name="stop.fill" size={11} color={p.red} />
                <Text maxFontSizeMultiplier={1.6} style={{ color: p.red, fontSize: TYPE.footnote, fontWeight: "600" }}>Stop</Text>
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

type DisplayRow =
  | Extract<ThreadRow, { type: "date" }>
  | (Extract<ThreadRow, { type: "row" }> & { animateIn: boolean; card?: CardView })
  | { type: "pending"; key: string; card: CardView };

const NO_ROWS: DisplayRow[] = [];

function threadKey(t: DisplayRow): string {
  return t.key;
}

type RowProps = {
  t: Extract<ThreadRow, { type: "row" }>;
  animateIn: boolean;
  /** the live state of a question card the Mac is holding; undefined = history */
  card?: CardView;
  onDecide: (id: string, d: "allow" | "deny") => void;
  onAnswer: OnAnswer;
  onCopied: () => void;
};

type PendingRowProps = { card: CardView; onAnswer: OnAnswer; onApprove: OnApprove };

/** A standalone card at the end of the feed (a permission, or a question ahead of its transcript card). */
const PendingRowView = React.memo(
  function PendingRowBody({ card, onAnswer, onApprove }: PendingRowProps) {
    return (
      <View style={{ marginTop: 8 }}>
        <TrailingCard card={card} onAnswer={onAnswer} onApprove={onApprove} />
      </View>
    );
  },
  (a: PendingRowProps, b: PendingRowProps) => sameCard(a.card, b.card) && a.onAnswer === b.onAnswer && a.onApprove === b.onApprove,
);

/** A row re-renders only when what it draws changed (see `sameFeedRow`), not on every new message. */
const ThreadRowView = React.memo(
  ThreadRowBody,
  (a: RowProps, b: RowProps) =>
    sameFeedRow(a.t.row, b.t.row) &&
    a.t.first === b.t.first &&
    a.t.time === b.t.time &&
    a.animateIn === b.animateIn &&
    sameCard(a.card, b.card) &&
    a.onDecide === b.onDecide &&
    a.onAnswer === b.onAnswer &&
    a.onCopied === b.onCopied,
);

function ThreadRowBody({
  t,
  animateIn,
  card,
  onDecide,
  onAnswer,
  onCopied,
}: RowProps) {
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
      return <View style={pad}><QuestionCard questions={item.questions} card={card} onAnswer={onAnswer} /></View>;
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
        <Text maxFontSizeMultiplier={1.6} style={{ color: p.textBright, fontSize: TYPE.footnote, fontWeight: "600" }}>Copied</Text>
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

function PlanCard({ item }: { item: PlanItem }) {
  const { palette: p } = useTheme();
  return (
    <View style={[cardStyle(p), { gap: 8 }]}>
      <Tag text="Plan" />
      <AssistantMarkdown text={item.markdown} />
    </View>
  );
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
        <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>{callVerb(call, e.label)}</Text>
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
