/**
 * "+" on Chats: start a session from the phone — pick the project, pick the agent, type the
 * first message. Sends the bridge's existing `spawn`; the Mac creates the session, opens its
 * tab and hands it the message; on `spawned` this sheet becomes that chat.
 *
 * Agents: only Claude can be started here, because only Claude's conversation reaches the
 * phone (the bridge reads its transcript). The other adapters are listed, disabled, as
 * "Opens on your Mac only". The Mac budgets spawns per phone (10 an hour).
 *
 * Start is disabled while a spawn is pending, and a timed-out spawn is never retried by
 * itself: the Mac may have started it, and a second press is the reader's call.
 */
import { StackActions } from "@react-navigation/native";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLive } from "../bridge/LiveProvider";
import { AgentMarkGlyph } from "../components/AgentAvatar";
import { useListSelection } from "../data/ListSelection";
import { accentFor } from "../logic/accent";
import { AGENTS, agentInfo, chatOnPhone } from "../logic/agents";
import { glyphInk, mix } from "../logic/color";
import type { NewChatProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";
import { SheetScaffold } from "./Sheets";

export function NewChatScreen({ navigation }: NewChatProps) {
  const { palette: p } = useTheme();
  const { view, spawn, spawnState, resetSpawn, conn } = useLive();
  const { filter } = useListSelection();
  const projects = useMemo(() => view?.projects ?? [], [view]);

  const [projectId, setProjectId] = useState<string | null>(() =>
    projects.some((x) => x.id === filter) ? filter : (projects[0]?.id ?? null),
  );
  // Claude first and the only one selectable: it is the agent whose chat the phone can show.
  // The others are listed so the reader knows they exist, and start on the Mac.
  const agents = useMemo(() => {
    const used = new Set(projects.flatMap((x) => x.sessions.map((s) => s.agent)));
    const rank = (id: string) => (chatOnPhone(id) ? 2 : used.has(id) ? 1 : 0);
    return [...AGENTS].sort((a, b) => rank(b.id) - rank(a.id));
  }, [projects]);
  const [agent, setAgent] = useState("claude");
  const [text, setText] = useState("");

  // A previous attempt's answer must not open a chat now.
  useEffect(() => {
    resetSpawn();
  }, [resetSpawn]);

  useEffect(() => {
    if (spawnState.phase !== "spawned") return;
    const s = spawnState;
    resetSpawn();
    navigation.dispatch(
      StackActions.replace("Chat", { sessionId: s.sessionId, projectId: s.projectId, name: s.name, branch: null }),
    );
  }, [spawnState, resetSpawn, navigation]);

  const pending = spawnState.phase === "pending";
  const ready = conn.phase === "ready";
  const canStart = ready && !pending && projectId !== null && chatOnPhone(agent) && text.trim().length > 0;
  const project = projects.find((x) => x.id === projectId) ?? null;

  return (
    <SheetScaffold title="New chat" onClose={() => navigation.goBack()}>
      <Label>Project</Label>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentInsetAdjustmentBehavior="never" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 4 }}>
        {projects.map((x) => {
          const on = x.id === projectId;
          const c = accentFor(x);
          return (
            <Pressable
              key={x.id}
              onPress={() => setProjectId(x.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                height: 34,
                paddingHorizontal: 13,
                borderRadius: 17,
                borderWidth: 1,
                borderColor: on ? mix(c, p.panelBg, 0.6) : p.border,
                backgroundColor: on ? mix(c, p.panelBg, 0.16) : "transparent",
              }}
            >
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c }} />
              <Text maxFontSizeMultiplier={1.6} style={{ fontSize: TYPE.subhead, color: on ? p.textBright : p.textMid, fontWeight: on ? "600" : "400" }}>{x.name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <Label>Agent</Label>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentInsetAdjustmentBehavior="never" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 4 }}>
        {agents.map((a) => {
          const on = a.id === agent;
          const usable = chatOnPhone(a.id);
          const ink = glyphInk(a.tint, p.textBright, p.panelBg);
          return (
            <Pressable
              key={a.id}
              onPress={() => usable && setAgent(a.id)}
              disabled={!usable}
              accessibilityRole="button"
              accessibilityLabel={usable ? a.label : `${a.label}, opens on your Mac only`}
              accessibilityState={{ selected: on, disabled: !usable }}
              style={{
                opacity: usable ? 1 : 0.5,
                width: 84,
                paddingVertical: 10,
                alignItems: "center",
                gap: 7,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: on ? mix(a.tint, p.panelBg, 0.6) : p.border,
                backgroundColor: on ? mix(a.tint, p.panelBg, 0.14) : p.sidebarBg,
              }}
            >
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: mix(a.tint, p.panelBg, 0.15),
                }}
              >
                <AgentMarkGlyph agent={a.id} size={20} color={ink} />
              </View>
              <Text maxFontSizeMultiplier={1.6} style={{ fontSize: TYPE.caption, color: on ? p.textBright : p.textMid, fontWeight: on ? "600" : "400" }} numberOfLines={1}>
                {a.label.replace(/ (CLI|Code|Agent)$/, "")}
              </Text>
              {usable ? null : (
                <Text maxFontSizeMultiplier={1.4} style={{ fontSize: 10, color: p.textDim, textAlign: "center", marginTop: -3 }} numberOfLines={2}>
                  Opens on your Mac only
                </Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      <Label>First message</Label>
      <View style={{ marginHorizontal: 16 }}>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder={`What should ${agentInfo(agent).label} do${project ? ` in ${project.name}` : ""}?`}
          placeholderTextColor={p.textMid}
          accessibilityLabel="First message"
          selectionColor={p.accent}
          keyboardAppearance={p.appearance}
          style={{
            minHeight: 92,
            maxHeight: 180,
            borderRadius: 14,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: p.border,
            backgroundColor: p.sidebarBg,
            paddingHorizontal: 14,
            paddingTop: 11,
            paddingBottom: 11,
            color: p.textBright,
            fontSize: TYPE.callout,
            lineHeight: 21,
            textAlignVertical: "top",
          }}
        />
        {spawnState.phase === "failed" ? (
          <Text style={{ marginTop: 8, fontSize: TYPE.footnote, color: p.red }}>{spawnState.message}</Text>
        ) : null}
        <Pressable
          onPress={() => projectId && spawn(projectId, text, agent)}
          disabled={!canStart}
          accessibilityRole="button"
          accessibilityLabel="Start chat"
          accessibilityState={{ disabled: !canStart, busy: pending }}
          style={({ pressed }) => ({
            marginTop: 14,
            height: MIN_TOUCH + 4,
            borderRadius: (MIN_TOUCH + 4) / 2,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: 8,
            backgroundColor: canStart ? p.accent : p.selectionBg,
            transform: [{ scale: pressed ? 0.98 : 1 }],
          })}
        >
          {pending ? <ActivityIndicator color={p.meText} /> : null}
          <Text style={{ fontSize: TYPE.body, fontWeight: "600", color: canStart || pending ? p.meText : p.textDim }}>
            {pending ? "Starting…" : "Start chat"}
          </Text>
        </Pressable>
      </View>
    </SheetScaffold>
  );
}

function Label({ children }: { children: string }) {
  const { palette: p } = useTheme();
  return <Text style={{ marginHorizontal: 20, marginTop: 6, marginBottom: 8, fontSize: TYPE.footnote, color: p.textMid }}>{children}</Text>;
}
