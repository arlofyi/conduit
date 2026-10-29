/**
 * The small native sheets (iOS form sheets, fitted to their content, grabber visible, swipe
 * to dismiss): the Chats "…" menu, the composer's quick actions, and session details.
 */
import { type SFSymbol } from "expo-symbols";
import React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { AgentAvatar } from "../components/AgentAvatar";
import { GlassCircle, Icon } from "../components/Glass";
import { useListSelection } from "../data/ListSelection";
import { agentInfo } from "../logic/agents";
import { accentFor } from "../logic/accent";
import { modelLabel } from "../logic/chatHeader";
import { ALL_PROFILES, profileSheet, profileSummary, resolveProfile, isNeeds } from "../logic/chatList";
import { quickActionMsgs, quickActionsFor, type QuickAction } from "../logic/quickActions";
import type { ChatsMenuProps, QuickActionsProps, SessionInfoProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, MONO, TYPE } from "../theme/type";

export function SheetScaffold({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  // The sheet's FIRST scroll view is adopted by the native sheet as its content scroll view and
  // moved; a horizontal chip row there rendered on top of the title (founder report). So every
  // sheet's first scroll view is this vertical container, which is also what lets a tall sheet
  // (keyboard up, many projects) scroll instead of clipping.
  return (
    <ScrollView
      style={{ flexGrow: 0 }}
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      bounces={false}
      contentContainerStyle={{ paddingTop: 14, paddingBottom: Math.max(insets.bottom, 16) + 4 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, marginBottom: 10 }}>
        <View style={{ width: 36 }} />
        <Text accessibilityRole="header" style={{ flex: 1, textAlign: "center", fontSize: TYPE.headline, fontWeight: "600", color: p.textBright }}>
          {title}
        </Text>
        <GlassCircle symbol="xmark" label="Close" onPress={onClose} size={36} symbolSize={14} />
      </View>
      {children}
    </ScrollView>
  );
}

/** A grouped-list row in a sheet: symbol, title, optional detail, optional trailing text. */
export function SheetRow({
  symbol,
  title,
  detail,
  trailing,
  tone = "plain",
  selected = false,
  onPress,
  disabled = false,
  first = false,
}: {
  symbol?: SFSymbol;
  title: string;
  detail?: string;
  trailing?: string;
  tone?: "plain" | "accent" | "destructive";
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  first?: boolean;
}) {
  const { palette: p } = useTheme();
  const color = tone === "destructive" ? p.red : tone === "accent" ? p.accent : p.textBright;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityState={{ selected, disabled }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: MIN_TOUCH + 6,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: pressed ? p.selectionBg : "transparent",
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: p.border,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      {symbol ? (
        <View style={{ width: 24, alignItems: "center" }}>
          <Icon name={symbol} size={19} color={color} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: TYPE.body, color, fontWeight: selected ? "600" : "400" }} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={{ fontSize: TYPE.footnote, color: p.textMid }} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {trailing ? <Text style={{ fontSize: TYPE.footnote, color: p.textMid, fontVariant: ["tabular-nums"] }}>{trailing}</Text> : null}
      {selected ? <Icon name="checkmark" size={16} color={p.accent} weight="semibold" /> : null}
    </Pressable>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  const { palette: p } = useTheme();
  return (
    <View
      style={{
        marginHorizontal: 16,
        marginBottom: 12,
        borderRadius: 14,
        overflow: "hidden",
        backgroundColor: p.sidebarBg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: p.border,
      }}
    >
      {children}
    </View>
  );
}

function GroupLabel({ children }: { children: string }) {
  const { palette: p } = useTheme();
  return (
    <Text style={{ marginHorizontal: 32, marginBottom: 6, fontSize: TYPE.footnote, color: p.textMid }}>{children}</Text>
  );
}

// ---- "…" on Chats ----

export function ChatsMenuScreen({ navigation }: ChatsMenuProps) {
  const { view, currentMac } = useLive();
  const { profileSel, setProfileSel, setFilter } = useListSelection();
  const entries = view ? profileSheet(view) : [];
  const selected = view ? resolveProfile(view, profileSel === undefined ? view.activeProfileId : profileSel) : null;
  return (
    <SheetScaffold title={currentMac?.macName ?? "Chats"} onClose={() => navigation.goBack()}>
      {entries.length > 0 && (
        <>
          <GroupLabel>Profile</GroupLabel>
          <Group>
            {entries.map((e, i) => {
              const sum = profileSummary(e);
              return (
                <SheetRow
                  key={e.id ?? "default"}
                  first={i === 0}
                  symbol={e.id === ALL_PROFILES ? "square.stack" : "person.crop.circle"}
                  title={e.name}
                  detail={sum.needs ? `${sum.projects} · ${sum.needs}` : sum.projects}
                  selected={e.id === selected}
                  onPress={() => {
                    setProfileSel(e.id);
                    setFilter("all");
                    navigation.goBack();
                  }}
                />
              );
            })}
          </Group>
        </>
      )}
      <Group>
        <SheetRow first symbol="laptopcomputer" title="Switch Mac…" tone="accent" onPress={() => {
            navigation.goBack();
            navigation.navigate("Connect");
          }}
        />
      </Group>
    </SheetScaffold>
  );
}

// ---- "+" in the composer ----

export function QuickActionsScreen({ navigation, route }: QuickActionsProps) {
  const { sendFrames, interrupt } = useLive();
  const { sessionId, running, agent } = route.params;
  const actions = quickActionsFor(running, agent);
  const run = (a: QuickAction) => {
    // Stop goes through the provider so the open feed marks the interruption.
    if (a.id === "stop") interrupt(sessionId);
    else sendFrames(quickActionMsgs(a.id, sessionId));
    navigation.goBack();
  };
  return (
    <SheetScaffold title="Steer this session" onClose={() => navigation.goBack()}>
      <Group>
        {actions.length === 0 ? (
          <SheetRow first symbol="stop.circle" title="Nothing to steer right now" detail="Stop appears here while the agent is working." disabled />
        ) : null}
        {actions.map((a, i) => (
          <SheetRow
            key={a.id}
            first={i === 0}
            symbol={a.symbol}
            title={a.title}
            detail={a.detail}
            tone={a.destructive ? "destructive" : "plain"}
            onPress={() => {
              const c = a.confirm;
              if (!c) return run(a);
              Alert.alert(c.title, c.message, [
                { text: "Cancel", style: "cancel" },
                { text: c.action, style: "destructive", onPress: () => run(a) },
              ]);
            }}
          />
        ))}
      </Group>
    </SheetScaffold>
  );
}

// ---- tap the chat header ----

export function SessionInfoScreen({ navigation, route }: SessionInfoProps) {
  const { palette: p } = useTheme();
  const { view, context, sessionLive } = useLive();
  const { sessionId, projectId } = route.params;
  const project = view?.projects.find((x) => x.sessions.some((s) => s.id === sessionId)) ?? view?.projects.find((x) => x.id === projectId);
  const session = project?.sessions.find((s) => s.id === sessionId) ?? null;
  const agent = agentInfo(session?.agent ?? "");
  const color = project ? accentFor(project) : null;
  const model = modelLabel(context?.model ?? session?.model ?? null);
  const pct = context ? Math.round(Math.min(1, Math.max(0, context.fraction)) * 100) : null;
  const state = session && isNeeds(session) ? "Needs you" : sessionLive.status === "running" || session?.status === "running" ? "Working" : session?.stopped ? "Stopped" : "Idle";
  const rows: { symbol: SFSymbol; title: string; value: string; mono?: boolean }[] = [
    { symbol: "folder", title: "Project", value: project?.name ?? "—" },
    { symbol: "cpu", title: "Agent", value: agent.label },
    { symbol: "sparkles", title: "Model", value: model ?? "—" },
    { symbol: "gauge.with.dots.needle.33percent", title: "Context", value: pct === null ? "—" : `${pct}% used` },
    { symbol: "arrow.triangle.branch", title: "Branch", value: session?.branch ?? "—", mono: true },
    { symbol: "circle.dotted", title: "Status", value: state },
  ];
  return (
    <SheetScaffold title="Session" onClose={() => navigation.goBack()}>
      <View style={{ alignItems: "center", gap: 8, marginBottom: 16 }}>
        <AgentAvatar agent={session?.agent ?? ""} projectColor={color} size={64} ground={p.panelBg} />
        <Text style={{ fontSize: TYPE.title3, fontWeight: "600", color: p.textBright }} numberOfLines={1}>
          {session?.name ?? "Session"}
        </Text>
        {pct !== null && <ContextMeter fraction={pct / 100} />}
      </View>
      <Group>
        {rows.map((r, i) => (
          <View
            key={r.title}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              minHeight: MIN_TOUCH,
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: p.border,
            }}
          >
            <View style={{ width: 24, alignItems: "center" }}>
              <Icon name={r.symbol} size={17} color={r.title === "Project" && color ? color : p.textMid} />
            </View>
            <Text style={{ flex: 1, fontSize: TYPE.body, color: p.textBright }}>{r.title}</Text>
            <Text
              style={{ maxWidth: "58%", fontSize: r.mono ? TYPE.footnote : TYPE.subhead, color: p.textMid, fontFamily: r.mono ? MONO : undefined }}
              numberOfLines={1}
            >
              {r.value}
            </Text>
          </View>
        ))}
      </Group>
    </SheetScaffold>
  );
}

function ContextMeter({ fraction }: { fraction: number }) {
  const { palette: p } = useTheme();
  const color = fraction >= 0.85 ? p.red : fraction >= 0.6 ? p.amber : p.green;
  return (
    <View
      accessible
      accessibilityLabel={`${Math.round(fraction * 100)} percent of the context window used`}
      style={{ width: 120, height: 4, borderRadius: 2, backgroundColor: p.selectionBg, overflow: "hidden" }}
    >
      <View style={{ width: `${Math.round(fraction * 100)}%`, height: 4, backgroundColor: color }} />
    </View>
  );
}
