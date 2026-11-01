/**
 * Starting and setting up a general chat:
 *
 * - "+" asks ONLY for the agent (GeneralNew, a compact chooser), and only when there is more
 *   than one; the chat opens at once with NOTHING attached. `useStartChat` is the one way a
 *   chat is created, shared with the Chats tab, which skips the sheet when there is no choice.
 * - a chat's settings (GeneralSettings): what is ATTACHED (profiles / projects -- the chat
 *   knows only about those), then model, effort, deep research and MCP servers. The agent is
 *   fixed per chat, so it is shown and not offered. Everything applies from the next message.
 *
 * Both sheets are `TallSheet`s: capped below the screen height with their body in a scroll
 * view and the action pinned under it. A fitted native sheet grows with its content, so a
 * plain scroll view inside one is never shorter than what it holds and never scrolls -- a long
 * MCP list pushed the old new-chat sheet's button off screen with no way to reach it.
 *
 * The choices come from the computer (`rootchatoptions`). An older desktop never answers; the
 * phone then starts Claude on its defaults, which is all that desktop can run.
 */
import { StackActions } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { AgentMarkGlyph } from "../components/AgentAvatar";
import { GlassCircle, Icon } from "../components/Glass";
import { useListSelection } from "../data/ListSelection";
import { secureBackend } from "../data/secureBackend";
import { agentInfo } from "../logic/agents";
import { ALL_PROFILES, resolveProfile } from "../logic/chatList";
import { glyphInk, mix } from "../logic/color";
import {
  agentLabel,
  agentOption,
  ATTACH_EXPLAINER,
  attachedItems,
  attachedSummary,
  createProfileId,
  detach,
  editableScope,
  MCP_EXPLAINER,
  needsAgentChoice,
  NEW_CHAT_SCOPE,
  preferredAgent,
  RESEARCH_EXPLAINER,
  sameScope,
  settingsOf,
  settingsPatch,
  startAgents,
  startSettings,
  toggleMcp,
  type ChatSettings,
  type RootChat,
  type RootChatOptions,
  type Scope,
} from "../logic/general";
import type { GeneralNewProps, GeneralSettingsProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";
import { ScopeEditor } from "./GeneralScopeScreen";
import { Group, GroupLabel, SheetRow } from "./Sheets";

// ---- starting a chat ----

/** SecureStore key: the agent "+" started a chat on last time, pre-selected next time. */
const LAST_AGENT_KEY = "generalChatAgent";

async function readLastAgent(): Promise<string | null> {
  try {
    return await secureBackend.get(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}

/** The last-picked agent; undefined until it has been read. */
function useLastAgent(): string | null | undefined {
  const [agent, setAgent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void readLastAgent().then((a) => {
      if (live) setAgent(a);
    });
    return () => {
      live = false;
    };
  }, []);
  return agent;
}

/**
 * Create a general chat on `agent` with nothing attached, listed under the profile the list
 * shows (the computer's active one under "All profiles"), then hand it to `onStarted`.
 */
export function useStartChat(onStarted: (chat: RootChat) => void) {
  const { view, conn, createRootChat, rootChatOptions } = useLive();
  const { profileSel } = useListSelection();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const sel = view ? resolveProfile(view, profileSel === undefined ? view.activeProfileId : profileSel) : null;
  const ready = conn.phase === "ready";

  const start = useCallback(
    async (agent: string) => {
      if (busy.current || !ready) return;
      busy.current = true;
      setStarting(true);
      setError(null);
      secureBackend.set(LAST_AGENT_KEY, agent).catch(() => {
        // not remembered: the chooser just pre-selects Claude next time
      });
      const r = await createRootChat(createProfileId(sel ?? ALL_PROFILES, view), NEW_CHAT_SCOPE, startSettings(rootChatOptions, agent));
      busy.current = false;
      setStarting(false);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onStarted(r.chat);
    },
    [ready, createRootChat, sel, view, rootChatOptions, onStarted],
  );
  return { start, starting, error, ready };
}

/** "+" on the Chats tab when there is an agent to choose (or the options are still coming). */
export function GeneralNewScreen({ navigation }: GeneralNewProps) {
  const { palette: p } = useTheme();
  const { rootChatOptions, loadRootChatOptions } = useLive();
  const lastAgent = useLastAgent();
  const onStarted = useCallback(
    (chat: RootChat) => navigation.dispatch(StackActions.replace("GeneralChat", { chatId: chat.id, title: chat.title })),
    [navigation],
  );
  const { start, starting, error, ready } = useStartChat(onStarted);

  // A live answer may already be here (the Chats tab asks on focus); otherwise ask now. No
  // answer within a few seconds leaves FALLBACK_OPTIONS: Claude alone.
  const optionsLive = rootChatOptions?.live === true;
  useEffect(() => {
    if (!optionsLive) void loadRootChatOptions();
  }, [optionsLive, loadRootChatOptions]);

  const opts = rootChatOptions;
  const agents = startAgents(opts);
  const preselected = lastAgent === undefined ? null : preferredAgent(opts, lastAgent);
  const choosing = opts !== null && needsAgentChoice(opts);

  // Nothing to choose: start at once.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!opts || choosing || autoStarted.current || !ready) return;
    autoStarted.current = true;
    void start(agents[0].id);
  }, [opts, choosing, agents, ready, start]);

  return (
    <TallSheet title="New chat" onClose={() => navigation.goBack()}>
      {!choosing ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 32, marginVertical: 14 }}>
            {error ? null : <ActivityIndicator color={p.textMid} />}
            <Text style={{ flex: 1, fontSize: TYPE.footnote, color: error ? p.red : p.textMid }}>
              {error ?? (opts ? "Starting the chat…" : "Asking your computer which agents it has…")}
            </Text>
          </View>
          {error ? <PrimaryButton label="Try again" busy={starting} disabled={starting || !ready} onPress={() => void start(agents[0].id)} /> : null}
        </>
      ) : (
        <>
          <GroupLabel>Which agent answers?</GroupLabel>
          <Group>
            {agents.map((a, i) => (
              <AgentRow
                key={a.id}
                first={i === 0}
                agent={a.id}
                label={a.label}
                detail={a.id === "antigravity" ? "Reads and answers. Can't start work on your computer." : "Can also propose work for you to approve."}
                selected={a.id === preselected}
                busy={starting && a.id === preselected}
                disabled={starting || !ready}
                onPress={() => void start(a.id)}
              />
            ))}
          </Group>
          {error ? (
            <Text style={{ marginHorizontal: 32, marginBottom: 12, fontSize: TYPE.footnote, color: p.red }}>{error}</Text>
          ) : (
            <Hint>The chat starts with no projects attached. Attach them, or change the model and effort, from the chat once it's open.</Hint>
          )}
        </>
      )}
    </TallSheet>
  );
}

function AgentRow({
  agent,
  label,
  detail,
  selected,
  busy,
  disabled,
  first,
  onPress,
}: {
  agent: string;
  label: string;
  detail: string;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  first: boolean;
  onPress: () => void;
}) {
  const { palette: p } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Start a chat with ${label}`}
      accessibilityState={{ selected, disabled, busy }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: MIN_TOUCH + 14,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: pressed ? p.selectionBg : "transparent",
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: p.border,
        opacity: disabled && !busy ? 0.6 : 1,
      })}
    >
      <AgentBadge agent={agent} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ fontSize: TYPE.body, color: p.textBright, fontWeight: selected ? "600" : "400" }}>{label}</Text>
        <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>{detail}</Text>
      </View>
      {busy ? (
        <ActivityIndicator color={p.accent} />
      ) : selected ? (
        <Icon name="checkmark" size={16} color={p.accent} />
      ) : (
        <Icon name="chevron.right" size={14} color={p.textMid} />
      )}
    </Pressable>
  );
}

// ---- a chat's settings: what it has attached, and how it runs ----

export function GeneralSettingsScreen({ navigation, route }: GeneralSettingsProps) {
  const { palette: p } = useTheme();
  const { chatId, attach } = route.params;
  const { view, conn, rootChats, rootChatOptions, loadRootChatOptions, setRootChatSettings, setRootChatScope } = useLive();
  const chat = rootChats?.find((c) => c.id === chatId) ?? null;
  const initial = useMemo(() => (chat ? settingsOf(chat) : null), [chat]);
  const [settings, setSettings] = useState<ChatSettings | null>(initial);
  useEffect(() => {
    if (!settings && initial) setSettings(initial);
  }, [initial, settings]);
  useEffect(() => {
    void loadRootChatOptions();
  }, [loadRootChatOptions]);

  // What the chat has attached, as edited here (saved together with the rest).
  // undefined until the chat is known (the list can arrive after the sheet opens).
  const savedScope = chat?.scope ?? null;
  const [draftScope, setScope] = useState<Scope | null | undefined>(chat ? savedScope : undefined);
  useEffect(() => {
    if (draftScope === undefined && chat) setScope(chat.scope ?? null);
  }, [chat, draftScope]);
  const scope = draftScope === undefined ? savedScope : draftScope;
  const [picking, setPicking] = useState(attach === true);
  const scopeChanged = chat !== null && !sameScope(scope, savedScope);

  const opts = rootChatOptions;
  const patch = initial && settings ? settingsPatch(initial, settings) : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const older = opts !== null && !opts.live;
  const runChanged = patch !== null && !older;
  const canSave = conn.phase === "ready" && !saving && (runChanged || scopeChanged);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    if (runChanged && patch) {
      const r = await setRootChatSettings(chatId, patch);
      if (!r.ok) {
        setSaving(false);
        setError(r.error);
        return;
      }
    }
    if (scopeChanged) {
      const r = await setRootChatScope(chatId, scope === null ? null : editableScope(scope));
      if (!r.ok) {
        setSaving(false);
        setError(r.error);
        return;
      }
    }
    setSaving(false);
    navigation.goBack();
  };

  const items = attachedItems(scope, view);
  const footer = chat ? (
    <>
      {error ? <Text style={{ marginHorizontal: 32, marginBottom: 8, fontSize: TYPE.footnote, color: p.red }}>{error}</Text> : null}
      <PrimaryButton label="Save" busy={saving} disabled={!canSave} onPress={save} />
    </>
  ) : null;

  return (
    <TallSheet title="Chat settings" onClose={() => navigation.goBack()} footer={footer}>
      {!chat || !settings ? (
        <Hint>This chat isn't on your computer any more.</Hint>
      ) : (
        <>
          <GroupLabel>Attached</GroupLabel>
          <Hint>{ATTACH_EXPLAINER}</Hint>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginHorizontal: 16, marginBottom: 10 }}>
            {items.length === 0 ? (
              <Text style={{ marginHorizontal: 16, fontSize: TYPE.subhead, color: p.textMid }}>Nothing attached yet.</Text>
            ) : (
              items.map((it) => <AttachedChip key={it.key} label={it.label} onRemove={() => setScope(detach(scope, it))} />)
            )}
          </View>
          <Group>
            <SheetRow
              first
              symbol={picking ? "chevron.up" : "paperclip"}
              title={picking ? "Hide the list" : items.length === 0 ? "Attach profiles or projects" : "Change what's attached"}
              detail={picking ? undefined : attachedSummary(scope, view)}
              tone="accent"
              onPress={() => setPicking((v) => !v)}
            />
          </Group>
          {picking ? <ScopeEditor scope={editableScope(scope ?? NEW_CHAT_SCOPE)} onChange={setScope} /> : null}

          {opts ? (
            <>
              <RunOptions opts={opts} settings={settings} onChange={setSettings} />
              {older ? <Hint>Update Conduit on your computer to change the model and the rest from the phone.</Hint> : null}
            </>
          ) : (
            <LoadingOptions />
          )}
        </>
      )}
    </TallSheet>
  );
}

function AttachedChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const { palette: p } = useTheme();
  return (
    <Pressable
      onPress={onRemove}
      accessibilityRole="button"
      accessibilityLabel={`Detach ${label}`}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 34,
        maxWidth: "100%",
        paddingLeft: 12,
        paddingRight: 9,
        borderRadius: 17,
        borderWidth: 1,
        borderColor: mix(p.accent, p.panelBg, 0.6),
        backgroundColor: pressed ? p.selectionBg : mix(p.accent, p.panelBg, 0.16),
      })}
    >
      <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={{ flexShrink: 1, fontSize: TYPE.subhead, color: p.textBright, fontWeight: "600" }}>
        {label}
      </Text>
      <Icon name="xmark" size={12} color={p.textMid} />
    </Pressable>
  );
}

/**
 * A fitted sheet that can hold more than a screen: capped at 88% of the window, header and
 * footer pinned, the body between them scrolls. On a 360x800 dp phone that leaves ~560 dp of
 * scrolling body between a ~60 dp header and a ~70 dp footer.
 */
function TallSheet({ title, onClose, footer, children }: { title: string; onClose: () => void; footer?: React.ReactNode; children: React.ReactNode }) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const bottom = Math.max(insets.bottom, 16) + 4;
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
        contentContainerStyle={{ paddingTop: 4, paddingBottom: footer ? 8 : bottom }}
      >
        {children}
      </ScrollView>
      {footer ? (
        <View style={{ paddingTop: 10, paddingBottom: bottom, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }}>{footer}</View>
      ) : null}
    </View>
  );
}

// ---- a chat's run options: agent (fixed), model, effort, deep research, MCP servers ----

function RunOptions({
  opts,
  settings,
  onChange,
}: {
  opts: RootChatOptions;
  settings: ChatSettings;
  onChange: (s: ChatSettings) => void;
}) {
  const { palette: p } = useTheme();
  const agent = agentOption(opts, settings.agent);
  const models = agent?.models ?? [];
  const efforts = agent?.efforts ?? [];
  // A chat's own model may be one the list no longer names: keep it choosable.
  const modelChoices = settings.model && !models.some((m) => m.id === settings.model) ? [...models, { id: settings.model, label: settings.model }] : models;
  const effortChoices = settings.effort && !efforts.includes(settings.effort) ? [...efforts, settings.effort] : efforts;

  return (
    <>
      <Label>Agent</Label>
      <Group>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: MIN_TOUCH + 6, paddingHorizontal: 16 }}>
          <AgentBadge agent={settings.agent} />
          <Text style={{ flex: 1, fontSize: TYPE.body, color: p.textBright }}>{agentLabel(opts, settings.agent)}</Text>
          <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>Fixed for this chat</Text>
        </View>
      </Group>

      {modelChoices.length > 0 ? (
        <>
          <Label>Model</Label>
          <ChipRow>
            <Chip label="Default" on={settings.model === null} onPress={() => onChange({ ...settings, model: null })} />
            {modelChoices.map((m) => (
              <Chip key={m.id} label={m.label} on={settings.model === m.id} onPress={() => onChange({ ...settings, model: m.id })} />
            ))}
          </ChipRow>
        </>
      ) : null}

      {effortChoices.length > 0 ? (
        <>
          <Label>Effort</Label>
          <ChipRow>
            <Chip label="Default" on={settings.effort === null} onPress={() => onChange({ ...settings, effort: null })} />
            {effortChoices.map((e) => (
              <Chip key={e} label={e} on={settings.effort === e} onPress={() => onChange({ ...settings, effort: e })} />
            ))}
          </ChipRow>
        </>
      ) : null}

      {opts.live ? (
        <>
          <View style={{ height: 8 }} />
          <Group>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: MIN_TOUCH + 6, paddingHorizontal: 16, paddingVertical: 8 }}>
              <View style={{ width: 24, alignItems: "center" }}>
                <Icon name="magnifyingglass" size={19} color={p.textBright} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: TYPE.body, color: p.textBright }}>Deep research</Text>
                <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>{RESEARCH_EXPLAINER}</Text>
              </View>
              <Switch
                value={settings.research}
                onValueChange={(v) => onChange({ ...settings, research: v })}
                trackColor={{ true: p.accent, false: p.selectionBg }}
                accessibilityLabel="Deep research"
              />
            </View>
          </Group>

          <GroupLabel>MCP servers</GroupLabel>
          <Hint>{MCP_EXPLAINER}</Hint>
          {opts.mcps.length > 0 ? (
            <Group>
              {opts.mcps.map((m, i) => {
                const on = settings.mcps.includes(m.name);
                return (
                  <SheetRow key={m.name} first={i === 0} symbol={on ? "checkmark.square.fill" : "square"} title={m.name} onPress={() => onChange(toggleMcp(settings, m.name))} />
                );
              })}
            </Group>
          ) : (
            <Hint>No MCP servers are set up on your computer.</Hint>
          )}
        </>
      ) : null}
    </>
  );
}

// ---- small pieces ----

function LoadingOptions() {
  const { palette: p } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 32, marginVertical: 14 }}>
      <ActivityIndicator color={p.textMid} />
      <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>Asking your computer what this chat can use…</Text>
    </View>
  );
}

function AgentBadge({ agent }: { agent: string }) {
  const { palette: p } = useTheme();
  const tint = agentInfo(agent).tint;
  return (
    <View style={{ width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: mix(tint, p.panelBg, 0.15) }}>
      <AgentMarkGlyph agent={agent} size={16} color={glyphInk(tint, p.textBright, p.panelBg)} />
    </View>
  );
}

function Label({ children }: { children: string }) {
  const { palette: p } = useTheme();
  return <Text style={{ marginHorizontal: 32, marginTop: 6, marginBottom: 8, fontSize: TYPE.footnote, color: p.textMid }}>{children}</Text>;
}

function Hint({ children }: { children: string }) {
  const { palette: p } = useTheme();
  return <Text style={{ marginHorizontal: 32, marginBottom: 12, fontSize: TYPE.footnote, color: p.textMid, lineHeight: 18 }}>{children}</Text>;
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      style={{ flexGrow: 0, marginBottom: 8 }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 4 }}
    >
      {children}
    </ScrollView>
  );
}

function Chip({ label, on, onPress, lead }: { label: string; on: boolean; onPress: () => void; lead?: React.ReactNode }) {
  const { palette: p } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        height: 34,
        paddingHorizontal: 13,
        borderRadius: 17,
        borderWidth: 1,
        borderColor: on ? mix(p.accent, p.panelBg, 0.6) : p.border,
        backgroundColor: on ? mix(p.accent, p.panelBg, 0.16) : pressed ? p.selectionBg : "transparent",
      })}
    >
      {lead}
      <Text maxFontSizeMultiplier={1.6} style={{ fontSize: TYPE.subhead, color: on ? p.textBright : p.textMid, fontWeight: on ? "600" : "400" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function PrimaryButton({ label, busy, disabled, onPress }: { label: string; busy: boolean; disabled: boolean; onPress: () => void }) {
  const { palette: p } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      style={({ pressed }) => ({
        marginHorizontal: 16,
        marginTop: 4,
        minHeight: MIN_TOUCH,
        borderRadius: 22,
        flexDirection: "row",
        gap: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: p.accent,
        opacity: disabled && !busy ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={p.meText} /> : null}
      <Text style={{ color: p.meText, fontWeight: "600", fontSize: TYPE.callout }}>{label}</Text>
    </Pressable>
  );
}
