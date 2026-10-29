import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PALETTES, THEME_ORDER } from "../theme/palettes";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";

/** Three-swatch control that cycles the Warm schemes; active one is ringed. */
export function ThemeButton() {
  const { themeId, cycle } = useTheme();
  return (
    <Pressable
      onPress={cycle}
      hitSlop={10}
      accessibilityLabel="Switch theme"
      style={{ flexDirection: "row", gap: 4, alignItems: "center", paddingVertical: 6, paddingLeft: 6 }}
    >
      {THEME_ORDER.map((id) => {
        const active = id === themeId;
        return (
          <View
            key={id}
            style={{
              width: active ? 13 : 10,
              height: active ? 13 : 10,
              borderRadius: 7,
              backgroundColor: PALETTES[id].accent,
              borderWidth: active ? 1.5 : StyleSheet.hairlineWidth,
              borderColor: active ? PALETTES[id].textBright : PALETTES[id].border,
            }}
          />
        );
      })}
    </Pressable>
  );
}

/** Amber "needs you" pill. */
export function NeedsPill({ label = "needs you" }: { label?: string }) {
  const { palette: p } = useTheme();
  return (
    <View
      style={{
        backgroundColor: p.pillNeedsBg,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 20,
      }}
    >
      <Text style={{ color: p.pillNeedsText, fontSize: TYPE.caption, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}
