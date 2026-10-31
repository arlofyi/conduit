/**
 * Liquid Glass where iOS renders it, a system material otherwise — never a flat strip.
 *
 *   iOS 26+:  expo-glass-effect `GlassView` (the real UIGlassEffect).
 *   older iOS: expo-blur `BlurView` with the system chrome material (HIG: system materials,
 *             not hand-rolled translucency).
 *   Android:  an opaque raised surface (expo-blur's Android blur needs a BlurTargetView
 *             around the content, which the keep-it-simple chat list does not have).
 *
 * Glass is used only where content actually passes beneath it: the floating composer
 * controls, the chat header, the list's top-bar buttons.
 */
import { BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import React from "react";
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH } from "../theme/type";
import { androidSymbolFor, type AppSymbol } from "./androidSymbols";

let glassOk: boolean | null = null;
/** Checked once: both the compile-time availability and the runtime API (some iOS 26 betas lack it). */
export function hasLiquidGlass(): boolean {
  if (glassOk === null) {
    try {
      glassOk = Platform.OS === "ios" && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
    } catch {
      glassOk = false;
    }
  }
  return glassOk;
}

export function GlassSurface({
  style,
  children,
  interactive = false,
  tint,
}: {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  interactive?: boolean;
  /** optional colour wash (e.g. the accent on a primary control) */
  tint?: string;
}) {
  const { palette: p } = useTheme();
  const scheme = p.appearance;
  if (hasLiquidGlass()) {
    return (
      <GlassView
        style={[{ overflow: "hidden" }, style]}
        glassEffectStyle="regular"
        isInteractive={interactive}
        tintColor={tint}
        colorScheme={scheme}
      >
        {children}
      </GlassView>
    );
  }
  if (Platform.OS === "ios") {
    return (
      <BlurView
        style={[{ overflow: "hidden" }, style]}
        tint={scheme === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
        intensity={90}
      >
        {tint ? <View style={[StyleSheet.absoluteFill, { backgroundColor: tint, opacity: 0.5 }]} /> : null}
        {children}
      </BlurView>
    );
  }
  return (
    <View
      style={[
        { overflow: "hidden", backgroundColor: tint ?? p.sidebarBg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A bar-wide material (chat header): the system chrome material, which on iOS 26 is glass. */
export function MaterialBar({ style, children }: { style?: StyleProp<ViewStyle>; children?: React.ReactNode }) {
  const { palette: p } = useTheme();
  if (Platform.OS === "ios") {
    return (
      <BlurView
        style={style}
        tint={p.appearance === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
        intensity={100}
      >
        {/* a whisper of the warm panel so the bar belongs to the theme, not to iOS grey */}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: p.panelBg, opacity: 0.55 }]} />
        {children}
      </BlurView>
    );
  }
  return <View style={[{ backgroundColor: p.sidebarBg }, style]}>{children}</View>;
}

/** An SF Symbol on iOS, its Material Symbol on Android (see androidSymbols.ts), tinted. */
export function Icon({
  name,
  size = 20,
  color,
  weight = "regular",
}: {
  name: AppSymbol;
  size?: number;
  color: string;
  weight?: "ultraLight" | "thin" | "light" | "regular" | "medium" | "semibold" | "bold";
}) {
  if (Platform.OS === "android") {
    // Regular weight only: each Material weight is its own ~1 MB font in the bundle.
    return <SymbolView name={{ android: androidSymbolFor(name) }} size={size} tintColor={color} style={{ width: size, height: size }} />;
  }
  return <SymbolView name={name} size={size} tintColor={color} weight={weight} resizeMode="scaleAspectFit" style={{ width: size, height: size }} />;
}

/** A round glass button with one symbol (WhatsApp iOS 26's top-bar circles). */
export function GlassCircle({
  symbol,
  onPress,
  label,
  size = 40,
  primary = false,
  disabled = false,
  symbolSize = 18,
}: {
  symbol: AppSymbol;
  onPress: () => void;
  label: string;
  size?: number;
  /** filled with the accent: the screen's primary action */
  primary?: boolean;
  disabled?: boolean;
  symbolSize?: number;
}) {
  const { palette: p } = useTheme();
  const slop = Math.max(0, (MIN_TOUCH - size) / 2);
  const inner = <Icon name={symbol} size={symbolSize} color={primary ? p.meText : p.textBright} weight="semibold" />;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={slop}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.7 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] })}
    >
      {primary ? (
        <View
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: p.accent, alignItems: "center", justifyContent: "center" }}
        >
          {inner}
        </View>
      ) : (
        <GlassSurface interactive style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center" }}>
          {inner}
        </GlassSurface>
      )}
    </Pressable>
  );
}
