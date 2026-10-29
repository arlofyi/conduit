/** Small building blocks shared by the Connect / Pair / Settings screens. */

import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";

/** Top bar with an optional back chevron and a title. */
export function ScreenHeader({ title, onBack }: { title?: string; onBack?: () => void }) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + 4,
        paddingHorizontal: 8,
        minHeight: insets.top + MIN_TOUCH + 4,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
      }}
    >
      {onBack ? (
        <Pressable
          onPress={onBack}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{ width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: p.accent, fontSize: 30, lineHeight: 32 }}>‹</Text>
        </Pressable>
      ) : (
        <View style={{ width: 8 }} />
      )}
      {title ? (
        <Text style={{ color: p.textBright, fontSize: TYPE.headline, fontWeight: "600" }} numberOfLines={1}>
          {title}
        </Text>
      ) : null}
    </View>
  );
}

export function BigTitle({ children }: { children: React.ReactNode }) {
  const { palette: p } = useTheme();
  return (
    <Text style={{ color: p.textBright, fontSize: TYPE.title, fontWeight: "700", marginBottom: 8 }}>{children}</Text>
  );
}

export function Para({ children, style }: { children: React.ReactNode; style?: object }) {
  const { palette: p } = useTheme();
  return <Text style={[{ color: p.textMid, fontSize: TYPE.subhead, lineHeight: 21 }, style]}>{children}</Text>;
}

/** Uppercase section label. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  const { palette: p } = useTheme();
  return (
    <Text
      style={{
        color: p.textDim,
        fontSize: TYPE.footnote,
        fontWeight: "700",
        letterSpacing: 0.5,
        textTransform: "uppercase",
        marginTop: 24,
        marginBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}

/** A grouped list of rows. */
export function Card({ children }: { children: React.ReactNode }) {
  const { palette: p } = useTheme();
  return (
    <View
      style={{
        backgroundColor: p.sidebarBg,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: p.border,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}

/** One row: title (+ optional subtitle) on the left, a value or accessory on the right. */
export function Row({
  title,
  subtitle,
  value,
  right,
  onPress,
  disabled,
  tone,
  first,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  tone?: "accent" | "danger" | "dim";
  first?: boolean;
  accessibilityLabel?: string;
}) {
  const { palette: p } = useTheme();
  const color =
    tone === "accent" ? p.accent : tone === "danger" ? p.red : tone === "dim" ? p.textDim : p.textBright;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={disabled ? { disabled: true } : undefined}
      style={({ pressed }) => ({
        minHeight: MIN_TOUCH + 6,
        paddingHorizontal: 14,
        paddingVertical: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        backgroundColor: pressed ? p.selectionBg : "transparent",
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: p.border,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color, fontSize: TYPE.body }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: p.textDim, fontSize: TYPE.footnote, marginTop: 2 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={{ color: p.textMid, fontSize: TYPE.subhead, flexShrink: 1 }} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  kind = "primary",
  busy,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary";
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const { palette: p } = useTheme();
  const primary = kind === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          minHeight: MIN_TOUCH + 4,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          paddingHorizontal: 16,
          backgroundColor: primary ? p.accent : p.selectionBg,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={primary ? p.meText : p.textBright} /> : null}
      <Text style={{ color: primary ? p.meText : p.textBright, fontSize: TYPE.headline, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A tinted message box (errors and notices). */
export function Notice({ text, tone = "bad" }: { text: string; tone?: "bad" | "info" }) {
  const { palette: p } = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        marginTop: 16,
        padding: 12,
        borderRadius: 10,
        backgroundColor: tone === "bad" ? p.pillNeedsBg : p.selectionBg,
      }}
    >
      <Text style={{ color: tone === "bad" ? p.pillNeedsText : p.textMid, fontSize: TYPE.subhead }}>{text}</Text>
    </View>
  );
}
