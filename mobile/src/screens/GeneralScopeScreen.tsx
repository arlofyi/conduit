/**
 * The scope sheet of a general chat: which projects it may see. Everything, or any mix of
 * whole profiles and single projects (grouped by profile). Save sends it to the computer.
 */
import React, { useState } from "react";
import { ActivityIndicator, Pressable, Switch, Text, View } from "react-native";
import { useLive } from "../bridge/LiveProvider";
import {
  editableScope,
  projectCover,
  sameScope,
  scopeGroups,
  scopeSummary,
  SCOPE_EXPLAINER,
  setAllProfiles,
  toggleProfile,
  toggleProject,
  type Scope,
} from "../logic/general";
import type { GeneralScopeProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";
import { Group, GroupLabel, SheetRow, SheetScaffold } from "./Sheets";

export function GeneralScopeScreen({ navigation, route }: GeneralScopeProps) {
  const { palette: p } = useTheme();
  const { chatId } = route.params;
  const { view, rootChats, setRootChatScope } = useLive();
  const chat = rootChats?.find((c) => c.id === chatId) ?? null;
  const [scope, setScope] = useState<Scope>(() => editableScope(chat?.scope ?? null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = view ? scopeGroups(view) : [];
  const unchanged = sameScope(scope, editableScope(chat?.scope ?? null));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const r = await setRootChatScope(chatId, scope);
    setSaving(false);
    if (r.ok) navigation.goBack();
    else setError(r.error);
  };

  return (
    <SheetScaffold title="What this chat sees" onClose={() => navigation.goBack()}>
      <Text style={{ marginHorizontal: 32, marginBottom: 12, fontSize: TYPE.footnote, color: p.textMid, lineHeight: 18 }}>
        {SCOPE_EXPLAINER}
      </Text>
      <Group>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: MIN_TOUCH + 6, paddingHorizontal: 16 }}>
          <Text style={{ flex: 1, fontSize: TYPE.body, color: p.textBright }}>All profiles</Text>
          <Switch
            value={scope.allProfiles}
            onValueChange={(v) => setScope((s) => setAllProfiles(s, v))}
            trackColor={{ true: p.accent, false: p.selectionBg }}
            accessibilityLabel="All profiles"
          />
        </View>
      </Group>
      {scope.allProfiles
        ? null
        : groups.map((g) => {
            const whole = scope.profiles.includes(g.profileId);
            return (
              <View key={g.profileId ?? "default"}>
                <GroupLabel>{g.name}</GroupLabel>
                <Group>
                  <SheetRow
                    first
                    symbol={whole ? "checkmark.square.fill" : "square"}
                    title={`All of ${g.name}`}
                    detail={`${g.projects.length} project${g.projects.length === 1 ? "" : "s"}, and any added later`}
                    selected={whole}
                    onPress={() => setScope((s) => toggleProfile(s, g.profileId))}
                  />
                  {g.projects.map((pr) => {
                    const cover = projectCover(scope, pr.id, g.profileId, view);
                    return (
                      <SheetRow
                        key={pr.id}
                        symbol={cover ? "checkmark.square.fill" : "square"}
                        title={pr.name}
                        disabled={cover === "profile"}
                        onPress={() => setScope((s) => toggleProject(s, pr.id))}
                      />
                    );
                  })}
                </Group>
              </View>
            );
          })}
      <Text style={{ marginHorizontal: 32, marginBottom: 10, fontSize: TYPE.footnote, color: error ? p.red : p.textMid }}>
        {error ?? `Sees: ${scopeSummary(scope, view)}`}
      </Text>
      <Pressable
        onPress={save}
        disabled={saving || unchanged}
        accessibilityRole="button"
        accessibilityState={{ disabled: saving || unchanged }}
        style={({ pressed }) => ({
          marginHorizontal: 16,
          minHeight: MIN_TOUCH,
          borderRadius: 22,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: p.accent,
          opacity: saving || unchanged ? 0.45 : pressed ? 0.8 : 1,
        })}
      >
        {saving ? <ActivityIndicator color={p.meText} /> : <Text style={{ color: p.meText, fontWeight: "600", fontSize: TYPE.callout }}>Save</Text>}
      </Pressable>
    </SheetScaffold>
  );
}
