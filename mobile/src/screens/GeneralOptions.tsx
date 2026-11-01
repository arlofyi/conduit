/**
 * General chat options, as two sheets over the Chats (general) tab:
 *
 * - "+" (GeneralNew): which PROFILE the chat is listed under, what it SEES (everything in that
 *   profile by default, every profile, or a picked mix), and how it runs: agent, model,
 *   effort, deep research, MCP servers. Then create.
 * - a chat's settings button (GeneralSettings): the same run options for THAT chat. The agent
 *   is fixed per chat, so it is shown and not offered.
 *
 * The choices come from the computer (`rootchatoptions`). An older desktop never answers; the
 * sheet then offers Claude on its defaults, which is all that desktop can run.
 */
import { StackActions } from "@react-navigation/native";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useLive } from "../bridge/LiveProvider";
import { AgentMarkGlyph } from "../components/AgentAvatar";
import { Icon } from "../components/Glass";
import { useListSelection } from "../data/ListSelection";
import { agentInfo } from "../logic/agents";
import { ALL_PROFILES, resolveProfile } from "../logic/chatList";
import { glyphInk, mix } from "../logic/color";
import {
  agentLabel,
  agentOption,
  createProfileId,
  createSettings,
  defaultSettings,
  emptyChatInfo,
  MCP_EXPLAINER,
  newChatScope,
  pickAgent,
  profileChoices,
  RESEARCH_EXPLAINER,
  SCOPE_EXPLAINER,
  scopeSummary,
  settingsOf,
  settingsPatch,
  toggleMcp,
  type ChatSettings,
  type RootChatOptions,
  type Scope,
  type ScopeMode,
} from "../logic/general";
import type { GeneralNewProps, GeneralSettingsProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";
import { ScopeEditor } from "./GeneralScopeScreen";
import { Group, GroupLabel, SheetRow, SheetScaffold } from "./Sheets";

// ---- "+" : a new general chat ----

export function GeneralNewScreen({ navigation }: GeneralNewProps) {
  const { palette: p } = useTheme();
  const { view, conn, createRootChat, rootChatOptions, loadRootChatOptions } = useLive();
  const { profileSel } = useListSelection();
  const ready = conn.phase === "ready";

  useEffect(() => {
    void loadRootChatOptions();
  }, [loadRootChatOptions]);

  // Default profile: the one the list shows, or the computer's active one under "All profiles".
  const sel = view ? resolveProfile(view, profileSel === undefined ? view.activeProfileId : profileSel) : null;
  const [profileId, setProfileId] = useState<string | null>(() => createProfileId(sel ?? ALL_PROFILES, view));
  const profiles = useMemo(() => profileChoices(view), [view]);
  const profileName = profiles.find((x) => x.id === profileId)?.name ?? "Default";

  const [mode, setMode] = useState<ScopeMode>("profile");
  const [custom, setCustom] = useState<Scope>(() => newChatScope("profile", profileId, { allProfiles: false, profiles: [], projects: [] }));
  const scope = newChatScope(mode, profileId, custom);

  const opts = rootChatOptions;
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  // The options arrive after the sheet opens: start from their defaults once.
  useEffect(() => {
    if (opts && !settings) setSettings(defaultSettings(opts));
  }, [opts, settings]);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = ready && !creating && settings !== null && (mode !== "custom" || custom.allProfiles || custom.profiles.length + custom.projects.length > 0);

  const create = async () => {
    if (!canCreate || !settings) return;
    setCreating(true);
    setError(null);
    // An older desktop: send the frame it always took (no options).
    const r = await createRootChat(profileId, scope, opts?.live ? createSettings(settings) : undefined);
    setCreating(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    navigation.dispatch(StackActions.replace("GeneralChat", { chatId: r.chat.id, title: r.chat.title }));
  };

  return (
    <SheetScaffold title="New chat" onClose={() => navigation.goBack()}>
      <Label>Profile</Label>
      <ChipRow>
        {profiles.map((pr) => (
          <Chip
            key={pr.id ?? "default"}
            label={pr.name}
            on={pr.id === profileId}
            onPress={() => {
              setProfileId(pr.id);
              // A picked mix that was just "this profile" follows the new profile.
              setCustom((c) => (c.profiles.length === 1 && c.profiles[0] === profileId && c.projects.length === 0 && !c.allProfiles ? newChatScope("profile", pr.id, c) : c));
            }}
          />
        ))}
      </ChipRow>
      <Hint>{`Listed under ${profileName} on your phone and your computer.`}</Hint>

      <Label>What it sees</Label>
      <Group>
        <SheetRow first symbol={mode === "profile" ? "checkmark.circle.fill" : "circle"} title={`All projects in ${profileName}`} selected={mode === "profile"} onPress={() => setMode("profile")} />
        <SheetRow symbol={mode === "all" ? "checkmark.circle.fill" : "circle"} title="All profiles" detail="Every project on your computer" selected={mode === "all"} onPress={() => setMode("all")} />
        <SheetRow
          symbol={mode === "custom" ? "checkmark.circle.fill" : "circle"}
          title="Pick profiles and projects"
          detail={mode === "custom" ? `Sees: ${scopeSummary(custom, view)}` : undefined}
          selected={mode === "custom"}
          onPress={() => setMode("custom")}
        />
      </Group>
      {mode === "custom" ? (
        <>
          <Hint>{SCOPE_EXPLAINER}</Hint>
          <ScopeEditor scope={custom} onChange={setCustom} />
        </>
      ) : null}

      {opts && settings ? (
        <RunOptions opts={opts} settings={settings} onChange={setSettings} agentFixed={false} />
      ) : (
        <LoadingOptions />
      )}

      {settings ? <Hint>{emptyChatInfo(settings.agent)}</Hint> : null}
      {error ? <Text style={{ marginHorizontal: 32, marginBottom: 10, fontSize: TYPE.footnote, color: p.red }}>{error}</Text> : null}
      <PrimaryButton label={creating ? "Starting…" : "Start chat"} busy={creating} disabled={!canCreate} onPress={create} />
    </SheetScaffold>
  );
}

// ---- a chat's settings ----

export function GeneralSettingsScreen({ navigation, route }: GeneralSettingsProps) {
  const { palette: p } = useTheme();
  const { chatId } = route.params;
  const { conn, rootChats, rootChatOptions, loadRootChatOptions, setRootChatSettings } = useLive();
  const chat = rootChats?.find((c) => c.id === chatId) ?? null;
  const initial = useMemo(() => (chat ? settingsOf(chat) : null), [chat]);
  const [settings, setSettings] = useState<ChatSettings | null>(initial);
  useEffect(() => {
    if (!settings && initial) setSettings(initial);
  }, [initial, settings]);
  useEffect(() => {
    void loadRootChatOptions();
  }, [loadRootChatOptions]);

  const opts = rootChatOptions;
  const patch = initial && settings ? settingsPatch(initial, settings) : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const older = opts !== null && !opts.live;
  const canSave = conn.phase === "ready" && !saving && patch !== null && !older;

  const save = async () => {
    if (!canSave || !patch) return;
    setSaving(true);
    setError(null);
    const r = await setRootChatSettings(chatId, patch);
    setSaving(false);
    if (r.ok) navigation.goBack();
    else setError(r.error);
  };

  return (
    <SheetScaffold title="Chat settings" onClose={() => navigation.goBack()}>
      {!chat || !settings ? (
        <Hint>This chat isn't on your computer any more.</Hint>
      ) : opts ? (
        <>
          <RunOptions opts={opts} settings={settings} onChange={setSettings} agentFixed />
          {older ? <Hint>Update Conduit on your computer to change these from the phone.</Hint> : null}
          <Hint>Changes apply from the next message.</Hint>
        </>
      ) : (
        <LoadingOptions />
      )}
      {error ? <Text style={{ marginHorizontal: 32, marginBottom: 10, fontSize: TYPE.footnote, color: p.red }}>{error}</Text> : null}
      <PrimaryButton label="Save" busy={saving} disabled={!canSave} onPress={save} />
    </SheetScaffold>
  );
}

// ---- the shared run options: agent, model, effort, deep research, MCP servers ----

function RunOptions({
  opts,
  settings,
  onChange,
  agentFixed,
}: {
  opts: RootChatOptions;
  settings: ChatSettings;
  onChange: (s: ChatSettings) => void;
  agentFixed: boolean;
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
      {agentFixed ? (
        <Group>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: MIN_TOUCH + 6, paddingHorizontal: 16 }}>
            <AgentBadge agent={settings.agent} />
            <Text style={{ flex: 1, fontSize: TYPE.body, color: p.textBright }}>{agentLabel(opts, settings.agent)}</Text>
            <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>Fixed for this chat</Text>
          </View>
        </Group>
      ) : (
        <ChipRow>
          {opts.agents.map((a) => (
            <Chip
              key={a.id}
              label={a.label}
              on={a.id === settings.agent}
              lead={<AgentMarkGlyph agent={a.id} size={14} color={glyphInk(agentInfo(a.id).tint, p.textBright, p.panelBg)} />}
              onPress={() => onChange(pickAgent(settings, opts, a.id))}
            />
          ))}
        </ChipRow>
      )}

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
