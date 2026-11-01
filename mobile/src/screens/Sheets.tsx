/**
 * The small native sheets (iOS form sheets, fitted to their content, grabber visible, swipe
 * to dismiss): the Chats "…" menu and the session sheet (details + preferences in one).
 */
import { type AppSymbol } from "../components/androidSymbols";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { AgentAvatar } from "../components/AgentAvatar";
import { GlassCircle, Icon } from "../components/Glass";
import { useListSelection } from "../data/ListSelection";
import { agentInfo } from "../logic/agents";
import { accentFor } from "../logic/accent";
import { activeModel, contextRing, effortText } from "../logic/sessionHeader";
import { ALL_PROFILES, profileSheet, profileSummary, resolveProfile, isNeeds } from "../logic/chatList";
import { QUICK_ACTIONS, quickActionsFor, type QuickAction } from "../logic/quickActions";
import type { SessionSetPatch } from "../bridge/protocol";
import {
  canRunNow,
  effortName,
  filterCommands,
  kindTag,
  MAX_NAME,
  renameValue,
  type CommandOption,
  type SessionOptions,
} from "../logic/sessionOptions";
import type { ChatsMenuProps, QuickActionsProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, MONO, TYPE } from "../theme/type";

export function SheetScaffold({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // Capped below the screen with the header pinned and the body scrolling: a fitted Android
  // sheet otherwise grows past the screen and nothing scrolls (the session sheet's Compact /
  // Clear / Stop rows were unreachable). The scroll view is vertical for the reason below.
  // The sheet's FIRST scroll view is adopted by the native sheet as its content scroll view and
  // moved; a horizontal chip row there rendered on top of the title (founder report).
  return (
    <View style={{ maxHeight: Math.round(height * 0.88) }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 }}>
        <View style={{ width: 36 }} />
        <Text accessibilityRole="header" style={{ flex: 1, textAlign: "center", fontSize: TYPE.headline, fontWeight: "600", color: p.textBright }}>
          {title}
        </Text>
        <GlassCircle symbol="xmark" label="Close" onPress={onClose} size={36} symbolSize={14} />
      </View>
      <ScrollView
        style={{ flexGrow: 0, flexShrink: 1 }}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        bounces={false}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 4 }}
      >
        {children}
      </ScrollView>
    </View>
  );
}

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
  symbol?: AppSymbol;
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

export function Group({ children }: { children: React.ReactNode }) {
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

export function GroupLabel({ children }: { children: string }) {
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
    <SheetScaffold title={currentMac?.macName ?? "Sessions"} onClose={() => navigation.goBack()}>
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
        <SheetRow first symbol="laptopcomputer" title="Switch computer…" tone="accent" onPress={() => {
            navigation.goBack();
            navigation.navigate("Connect");
          }}
        />
      </Group>
    </SheetScaffold>
  );
}

// ---- the session sheet: the chat header's title tap AND its preferences button ----

type Expanded = "model" | "effort" | "rename" | null;

/**
 * ONE sheet for a session (Round 4: the title tap and the preferences button used to open two
 * overlapping sheets). On top, what it is: the avatar ringed with its context use, its name,
 * project and status, and Project / Agent / Branch / Context rows. Below, everything about it
 * that is not a message: Interrupt and Files; its model, effort, name, keep-running pin and
 * auto-approve; its slash commands and skills (tap one to put it in the composer); its MCP
 * servers; and Compact / Clear / Stop. The options come from `sessionoptions`; an older computer
 * that never answers still gets the details, files and the actions.
 */
export function QuickActionsScreen({ navigation, route }: QuickActionsProps) {
  const { palette: p } = useTheme();
  const { interrupt, prompt, view, sessionOptions, sessionSet, sessionAction, context, sessionLive } = useLive();
  const { sessionId, running, agent, projectId, name, branch } = route.params;
  const project = view?.projects.find((x) => x.sessions.some((s) => s.id === sessionId)) ?? view?.projects.find((x) => x.id === projectId) ?? null;
  const session = project?.sessions.find((s) => s.id === sessionId) ?? null;
  const silo = !!session?.silo;
  const [autoApprove, setAutoApprove] = useState<boolean>(session?.autoApprove === true);
  const [opts, setOpts] = useState<SessionOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState("");
  const [query, setQuery] = useState("");
  const [keepRunning, setKeepRunning] = useState<boolean>(session?.keepRunning === true);

  const load = useCallback(() => {
    setLoadError(null);
    sessionOptions(sessionId).then((r) => {
      if (r.ok) {
        setOpts(r.options);
        setKeepRunning(r.options.keepRunning);
        setAutoApprove(r.options.autoApprove);
      } else setLoadError(r.error);
    });
  }, [sessionId, sessionOptions]);
  useEffect(() => {
    if (!silo) load();
  }, [load, silo]);

  const set = async (patch: SessionSetPatch, fallback: string): Promise<boolean> => {
    setBusy(true);
    const r = await sessionSet(sessionId, patch);
    setBusy(false);
    setNote({ text: r.note ?? (r.ok ? fallback : "Your computer didn't make that change."), ok: r.ok });
    if (r.ok) {
      setOpts((o) =>
        o
          ? {
              ...o,
              model: patch.model ?? o.model,
              effort: patch.effort ?? o.effort,
              keepRunning: patch.keepRunning ?? o.keepRunning,
              autoApprove: patch.autoApprove ?? o.autoApprove,
            }
          : o,
      );
      setExpanded(null);
    }
    return r.ok;
  };

  const sessionName = session?.name ?? name ?? "Session";
  // `opts.model`/`effort` are PINS (null when unpinned): the sheet shows what is ACTIVE -- the
  // pin, else the model the session reports (transcript, then view); an unpinned effort is
  // "Default". Never a dash.
  const active = activeModel({ pinned: opts?.model, live: context?.model ?? session?.model ?? null, models: opts?.models });
  const model = active.id;
  const effort = opts?.effort ?? session?.effort ?? null;
  const agentId = session?.agent ?? agent;
  const color = project ? accentFor(project) : null;
  const ring = contextRing(context ? context.fraction : null);
  const needs = session ? isNeeds(session) : false;
  const working = !needs && (running || sessionLive.status === "running" || session?.status === "running");
  const status = needs ? "Needs you" : working ? "Working" : session?.stopped ? "Stopped" : "Idle";
  const statusColor = needs ? p.amber : working ? p.green : p.textMid;
  const avatarState = needs ? "needsInput" : working ? "running" : session?.stopped ? undefined : "idle";
  const infoRows: { symbol: AppSymbol; title: string; value: string; mono?: boolean; tint?: string }[] = [
    { symbol: "folder", title: "Project", value: project?.name ?? "—", tint: color ?? undefined },
    { symbol: "cpu", title: "Agent", value: agentInfo(agentId).label },
    ...(session?.branch ? [{ symbol: "arrow.triangle.branch" as const, title: "Branch", value: session.branch, mono: true }] : []),
    ...(ring ? [{ symbol: "gauge.with.dots.needle.33percent" as const, title: "Context", value: `${ring.percent}% used` }] : []),
  ];
  const commands = opts ? filterCommands(opts.commands, query) : [];
  const shown = commands.slice(0, COMMANDS_SHOWN);
  const renamed = renameValue(rename, sessionName);
  const saveName = () => {
    if (renamed) set({ name: renamed }, `Renamed to ${renamed}`);
  };

  const insert = projectId
    ? (cmd: string) =>
        navigation.popTo(
          "Chat",
          { sessionId, projectId, name: name ?? sessionName, branch: branch ?? null, insert: { command: cmd, nonce: Date.now() } },
          { merge: true },
        )
    : undefined;
  const runNow = (cmd: string) => {
    const go = () => {
      prompt(sessionId, `/${cmd}`);
      navigation.goBack();
    };
    if (cmd !== "clear") return go();
    Alert.alert(CLEAR_CONFIRM.title, CLEAR_CONFIRM.message, [
      { text: "Cancel", style: "cancel" },
      { text: CLEAR_CONFIRM.action, style: "destructive", onPress: go },
    ]);
  };

  const actions = quickActionsFor(running, agent);
  const runAction = (a: QuickAction) => {
    // Interrupt goes through the provider so the open feed marks the interruption.
    // Compact / Clear go through `prompt`, which holds a slash command's Enter until Claude
    // Code's command menu has drawn (`submitDelayMs`).
    if (a.id === "stop") interrupt(sessionId);
    else prompt(sessionId, `/${a.id}`);
    navigation.goBack();
  };
  const stopSession = () =>
    Alert.alert("Stop this session?", "The agent's process ends. The conversation stays on your computer, and opening the session again resumes it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: async () => {
          const r = await sessionAction("stop", [sessionId]);
          if (!r.ok) return setNote({ text: r.error, ok: false });
          const skipped = r.skipped.find((x) => x.id === sessionId);
          if (skipped) return setNote({ text: skipped.reason, ok: false });
          navigation.goBack();
        },
      },
    ]);
  const interruptAction = actions.find((a) => a.id === "stop");
  const steer = actions.filter((a) => a.id !== "stop");

  return (
    <SheetScaffold title="Session" onClose={() => navigation.goBack()}>
      <View style={{ alignItems: "center", gap: 6, marginBottom: 16, paddingHorizontal: 24 }}>
        <AgentAvatar agent={agentId} projectColor={color} state={avatarState} size={64} ground={p.panelBg} context={ring ? ring.fraction : null} />
        <Text style={{ fontSize: TYPE.title3, fontWeight: "600", color: p.textBright, textAlign: "center" }} numberOfLines={2}>
          {sessionName}
        </Text>
        <Text style={{ fontSize: TYPE.footnote, textAlign: "center" }} numberOfLines={1}>
          {project ? <Text style={{ color: color ?? p.textMid, fontWeight: "600" }}>{project.name}</Text> : null}
          {project ? <Text style={{ color: p.textDim }}>{"  ·  "}</Text> : null}
          <Text style={{ color: statusColor }}>{status}</Text>
          {autoApprove ? <Text style={{ color: p.amber }}>{"  ·  auto-approve on"}</Text> : null}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
          <InfoChip symbol="sparkles" text={active.label} label={`Model ${active.label}`} />
          <InfoChip symbol="gauge.with.dots.needle.33percent" text={effortText(effort)} label={`Effort ${effortText(effort)}`} />
        </View>
      </View>

      <Group>
        {infoRows.map((r, i) => (
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
              <Icon name={r.symbol} size={17} color={r.tint ?? p.textMid} />
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

      {note ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            marginHorizontal: 16,
            marginBottom: 12,
            flexDirection: "row",
            gap: 8,
            alignItems: "flex-start",
            padding: 10,
            borderRadius: 10,
            backgroundColor: note.ok ? p.selectionBg : p.pillNeedsBg,
          }}
        >
          <Icon name={note.ok ? "checkmark.circle.fill" : "info.circle"} size={15} color={note.ok ? p.green : p.pillNeedsText} />
          <Text style={{ flex: 1, color: note.ok ? p.textBright : p.pillNeedsText, fontSize: TYPE.footnote }}>{note.text}</Text>
        </View>
      ) : null}

      <Group>
        {interruptAction ? (
          <SheetRow
            first
            symbol="stop.circle"
            title="Interrupt"
            detail="Stop the current turn (Esc on your computer)"
            tone="destructive"
            onPress={() => runAction(interruptAction)}
          />
        ) : null}
        <SheetRow
          first={!interruptAction}
          symbol="folder"
          title="Files"
          detail={silo ? "Private: its files stay on your computer" : "Browse, read and edit this session's files"}
          tone="accent"
          disabled={silo}
          onPress={() => {
            navigation.goBack();
            navigation.navigate("Files", { sessionId, path: "", title: sessionName });
          }}
        />
      </Group>

      <GroupLabel>Session</GroupLabel>
      {silo ? (
        <Group>
          <SheetRow first symbol="lock.fill" title="Private session" detail="Change its settings on your computer." />
        </Group>
      ) : (
        <Group>
          <SheetRow
            first
            symbol="sparkles"
            title="Model"
            trailing={active.label}
            detail={opts && !opts.modelLive ? "Applies at the next start" : undefined}
            disabled={!opts || opts.models.length === 0 || busy}
            onPress={() => setExpanded((e) => (e === "model" ? null : "model"))}
          />
          {expanded === "model" && opts
            ? opts.models.map((m) => (
                <SheetRow
                  key={m.id}
                  title={m.label}
                  detail={m.label !== m.id ? m.id : undefined}
                  selected={m.id === model}
                  disabled={busy}
                  onPress={() =>
                    m.id === model
                      ? setExpanded(null)
                      : set({ model: m.id }, opts.modelLive ? `Switched to ${m.label}` : `${m.label} applies at the next start`)
                  }
                />
              ))
            : null}
          <SheetRow
            symbol="gauge.with.dots.needle.33percent"
            title="Effort"
            trailing={effortText(effort)}
            detail={opts && opts.efforts.length > 0 ? "Applies at the next start" : undefined}
            disabled={!opts || opts.efforts.length === 0 || busy}
            onPress={() => setExpanded((e) => (e === "effort" ? null : "effort"))}
          />
          {expanded === "effort" && opts
            ? opts.efforts.map((e) => (
                <SheetRow
                  key={e}
                  title={effortName(e)}
                  selected={e === effort}
                  disabled={busy}
                  onPress={() => (e === effort ? setExpanded(null) : set({ effort: e }, `Effort ${effortName(e)} applies at the next start`))}
                />
              ))
            : null}
          <SheetRow
            symbol="pencil"
            title="Rename"
            trailing={sessionName}
            disabled={busy}
            onPress={() => {
              setRename(sessionName);
              setExpanded((e) => (e === "rename" ? null : "rename"));
            }}
          />
          {expanded === "rename" ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: p.border,
              }}
            >
              <TextInput
                value={rename}
                onChangeText={setRename}
                maxLength={MAX_NAME}
                autoFocus
                placeholder="Session name"
                placeholderTextColor={p.textDim}
                selectionColor={p.accent}
                keyboardAppearance={p.appearance}
                returnKeyType="done"
                accessibilityLabel="New session name"
                onSubmitEditing={saveName}
                style={{ flex: 1, minHeight: MIN_TOUCH, color: p.textBright, fontSize: TYPE.body, paddingHorizontal: 10, borderRadius: 10, backgroundColor: p.panelBg }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save name"
                accessibilityState={{ disabled: !renamed || busy }}
                disabled={!renamed || busy}
                onPress={saveName}
                style={{ minHeight: MIN_TOUCH, paddingHorizontal: 14, justifyContent: "center", borderRadius: 10, backgroundColor: p.accent, opacity: renamed && !busy ? 1 : 0.4 }}
              >
                <Text style={{ color: p.meText, fontWeight: "600", fontSize: TYPE.callout }}>Save</Text>
              </Pressable>
            </View>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              minHeight: MIN_TOUCH + 6,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: p.border,
            }}
          >
            <View style={{ width: 24, alignItems: "center" }}>
              <Icon name="pin" size={19} color={p.textBright} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: TYPE.body, color: p.textBright }}>Keep running</Text>
              <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>Never stopped for being idle</Text>
            </View>
            <Switch
              value={keepRunning}
              disabled={busy}
              accessibilityLabel="Keep running"
              trackColor={{ true: p.accent, false: p.selectionBg }}
              onValueChange={async (v) => {
                setKeepRunning(v);
                const ok = await set({ keepRunning: v }, v ? "Kept running: it won't be stopped for being idle" : "It can be stopped when idle again");
                if (!ok) setKeepRunning(!v);
              }}
            />
          </View>
          {opts?.autoApproveSupported ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: MIN_TOUCH + 6,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: p.border,
              }}
            >
              <View style={{ width: 24, alignItems: "center" }}>
                <Icon name="bolt" size={19} color={autoApprove ? p.amber : p.textBright} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: TYPE.body, color: p.textBright }}>Auto-approve</Text>
                <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>Allow every request automatically – commands and file edits included.</Text>
              </View>
              <Switch
                value={autoApprove}
                disabled={busy}
                accessibilityLabel="Auto-approve"
                trackColor={{ true: p.amber, false: p.selectionBg }}
                onValueChange={async (v) => {
                  setAutoApprove(v);
                  const ok = await set({ autoApprove: v }, v ? "Auto-approve on: every request is allowed" : "Auto-approve off: requests ask you again");
                  if (!ok) setAutoApprove(!v);
                }}
              />
            </View>
          ) : null}
        </Group>
      )}

      {!silo && loadError ? (
        <Group>
          <SheetRow first symbol="info.circle" title="Couldn't load this session's options" detail={loadError} trailing="Retry" onPress={load} />
        </Group>
      ) : null}

      {opts && opts.commands.length > 0 ? (
        <>
          <GroupLabel>Commands & skills</GroupLabel>
          <Group>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, minHeight: MIN_TOUCH }}>
              <Icon name="magnifyingglass" size={16} color={p.textMid} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={`Search ${opts.commands.length} commands and skills`}
                placeholderTextColor={p.textDim}
                selectionColor={p.accent}
                keyboardAppearance={p.appearance}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Search commands and skills"
                style={{ flex: 1, minHeight: MIN_TOUCH, color: p.textBright, fontSize: TYPE.body }}
              />
            </View>
            {shown.map((c) => (
              <CommandRow
                key={c.name}
                c={c}
                onInsert={insert ? () => insert(c.name) : undefined}
                onRun={canRunNow(c) ? () => runNow(c.name) : undefined}
              />
            ))}
            {commands.length === 0 ? <SheetRow title="Nothing matches" detail="Try another word." disabled /> : null}
            {commands.length > shown.length ? (
              <SheetRow title={`${commands.length - shown.length} more`} detail="Search to narrow the list." disabled />
            ) : null}
          </Group>
        </>
      ) : null}

      {opts && opts.mcps.length > 0 ? (
        <>
          <GroupLabel>MCP servers</GroupLabel>
          <Group>
            {opts.mcps.map((m, i) => (
              <SheetRow key={m.name} first={i === 0} symbol="server.rack" title={m.name} detail={m.source || undefined} trailing={m.enabled ? "On" : "Off"} />
            ))}
          </Group>
        </>
      ) : null}

      <GroupLabel>Actions</GroupLabel>
      <Group>
        {steer.map((a, i) => (
          <SheetRow
            key={a.id}
            first={i === 0}
            symbol={a.symbol}
            title={a.title}
            detail={a.detail}
            tone={a.destructive ? "destructive" : "plain"}
            onPress={() => {
              const c = a.confirm;
              if (!c) return runAction(a);
              Alert.alert(c.title, c.message, [
                { text: "Cancel", style: "cancel" },
                { text: c.action, style: "destructive", onPress: () => runAction(a) },
              ]);
            }}
          />
        ))}
        <SheetRow
          first={steer.length === 0}
          symbol="power"
          title="Stop session"
          detail={session?.stopped ? "Already stopped" : "End the agent's process; the conversation is kept"}
          tone="destructive"
          disabled={!!session?.stopped}
          onPress={stopSession}
        />
      </Group>
    </SheetScaffold>
  );
}

const COMMANDS_SHOWN = 40;
const CLEAR_CONFIRM = QUICK_ACTIONS.find((a) => a.id === "clear")!.confirm!;

/** One command or skill: tap puts `/name ` in the composer; a no-argument built-in can also run now. */
function CommandRow({ c, onInsert, onRun }: { c: CommandOption; onInsert?: () => void; onRun?: () => void }) {
  const { palette: p } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }}>
      <Pressable
        onPress={onInsert}
        disabled={!onInsert}
        accessibilityRole="button"
        accessibilityLabel={`/${c.name}, ${kindTag(c.kind)}. ${c.description}. Put in the message`}
        style={({ pressed }) => ({
          flex: 1,
          minHeight: MIN_TOUCH + 6,
          paddingHorizontal: 16,
          paddingVertical: 8,
          justifyContent: "center",
          backgroundColor: pressed ? p.selectionBg : "transparent",
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={c.kind === "skill" ? "sparkles" : "terminal"} size={14} color={p.textMid} />
          <Text style={{ color: p.accent, fontFamily: MONO, fontSize: 14, flexShrink: 1 }} numberOfLines={1}>
            /{c.name}
          </Text>
          <Text style={{ color: p.textDim, fontSize: TYPE.micro }}>{kindTag(c.kind)}</Text>
        </View>
        {c.description ? (
          <Text style={{ color: p.textMid, fontSize: TYPE.footnote, marginTop: 2 }} numberOfLines={2}>
            {c.description}
          </Text>
        ) : null}
      </Pressable>
      {onRun ? (
        <Pressable
          onPress={onRun}
          accessibilityRole="button"
          accessibilityLabel={`Run /${c.name} now`}
          hitSlop={6}
          style={({ pressed }) => ({
            marginRight: 12,
            paddingHorizontal: 12,
            minHeight: 32,
            justifyContent: "center",
            borderRadius: 16,
            backgroundColor: pressed ? p.border : p.selectionBg,
          })}
        >
          <Text style={{ color: p.textBright, fontSize: TYPE.footnote, fontWeight: "600" }}>Run</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A small labelled chip under the sheet's title: the active model, the effort. */
function InfoChip({ symbol, text, label }: { symbol: AppSymbol; text: string; label: string }) {
  const { palette: p } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 180, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 12, backgroundColor: p.selectionBg }}
    >
      <Icon name={symbol} size={12} color={p.textMid} />
      <Text style={{ flexShrink: 1, fontSize: TYPE.footnote, fontWeight: "600", color: p.textBright }} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}
