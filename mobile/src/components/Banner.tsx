import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { BANNER_MS, type Banner as BannerData } from "../logic/banner";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";

/**
 * The in-app banner (spec §9): drops from the top for BANNER_MS when a session newly needs you.
 * Which sessions raise one, and when, is decided in `logic/banner.ts`; this only draws it.
 * A tap opens the chat (a private session's banner just dismisses: it cannot be opened here).
 */
export function Banner({ onOpen }: { onOpen: (b: BannerData) => void }) {
  const { banner, dismissBanner } = useLive();
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const y = useRef(new Animated.Value(-160)).current;

  const id = banner?.id ?? null;
  useEffect(() => {
    if (!id) return;
    y.setValue(-160);
    Animated.timing(y, { toValue: 0, duration: 220, useNativeDriver: true }).start();
    const t = setTimeout(() => {
      Animated.timing(y, { toValue: -160, duration: 200, useNativeDriver: true }).start(({ finished }) => {
        if (finished) dismissBanner();
      });
    }, BANNER_MS);
    return () => clearTimeout(t);
  }, [id, y, dismissBanner]);

  if (!banner) return null;
  const needs = banner.kind !== "finished";
  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        top: insets.top + 6,
        transform: [{ translateY: y }],
        zIndex: 10,
        elevation: 10,
      }}
    >
      <Pressable
        onPress={() => {
          dismissBanner();
          if (banner.openable) onOpen(banner);
        }}
        accessibilityRole={banner.openable ? "button" : "alert"}
        accessibilityLabel={`${banner.title}. ${banner.text}${banner.openable ? ". Open chat" : ""}`}
        accessibilityLiveRegion="polite"
        style={{
          backgroundColor: p.sidebarBg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: needs ? p.amber : p.border,
          borderLeftWidth: needs ? 3 : StyleSheet.hairlineWidth,
          borderRadius: 14,
          paddingHorizontal: 13,
          paddingVertical: 10,
          shadowColor: "#000",
          shadowOpacity: 0.35,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 6 },
        }}
      >
        <Text style={{ fontSize: TYPE.footnote, fontWeight: "700", color: p.textBright }} numberOfLines={1}>
          {banner.title}
        </Text>
        <Text
          style={{ fontSize: TYPE.footnote, color: needs ? p.pillNeedsText : p.textMid, marginTop: 2 }}
          numberOfLines={2}
        >
          {banner.text}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
