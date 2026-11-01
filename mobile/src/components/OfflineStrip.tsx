/**
 * Thin lines under a screen's top bar: "offline, showing what was saved at 2:05 PM" with a Retry,
 * and the one-time "While you were away" summary after a long gap.
 */
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BACKOFF_START_MS, canRetry } from "../bridge/connection";
import { useLive } from "../bridge/LiveProvider";
import { connStatus } from "../logic/connCopy";
import { offlineLine } from "../logic/offlineCache";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";
import { Icon } from "./Glass";

export interface OfflineLine {
  text: string;
  /** the first attempt of a launch reads "connecting" (amber), not "offline" (red) */
  tone: "bad" | "busy";
  /** set when a Retry means anything (between attempts, or retrying a refusal) */
  onRetry?: () => void;
}

/** The offline line for a screen showing data saved at `savedAt` (null: live data, or none);
 * null while connected. Re-reads the clock every 30 s so "last seen" stays true. */
export function useOfflineLine(savedAt: number | null): OfflineLine | null {
  const { conn, lastSeen, currentMac, hello, retryNow } = useLive();
  const [now, setNow] = useState(() => Date.now());
  const ready = conn.phase === "ready";
  useEffect(() => {
    if (ready) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [ready]);
  const macName = hello?.macName ?? currentMac?.macName ?? "your computer";
  const firstTry = lastSeen === null && conn.backoffMs === BACKOFF_START_MS && conn.phase !== "failed" && conn.phase !== "idle";
  const text = offlineLine({
    ready,
    reason: !!conn.error && conn.error.kind !== "closed",
    statusText: connStatus(conn, macName).text,
    savedAt,
    lastSeen,
    macName,
    firstTry,
    now,
  });
  if (text === null) return null;
  return { text, tone: firstTry ? "busy" : "bad", onRetry: canRetry(conn) ? retryNow : undefined };
}

export function OfflineStrip({
  text,
  tone = "bad",
  onPress,
  onRetry,
  inset = 16,
}: {
  text: string;
  tone?: "bad" | "busy";
  /** the line itself (e.g. open Settings) */
  onPress?: () => void;
  /** a Retry button: dial now instead of waiting out the backoff */
  onRetry?: () => void;
  inset?: number;
}) {
  const { palette: p } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: inset, paddingRight: inset - 4, paddingVertical: 4 }}>
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? "button" : "text"}
        accessibilityLiveRegion="polite"
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 7, minHeight: 28 }}
      >
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tone === "busy" ? p.amber : p.red }} />
        <Text style={{ flex: 1, fontSize: TYPE.footnote, color: p.textMid }} numberOfLines={2}>
          {text}
        </Text>
      </Pressable>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry the connection now"
          hitSlop={8}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, minHeight: 28, opacity: pressed ? 0.6 : 1 })}
        >
          <Icon name="arrow.clockwise" size={13} color={p.accent} />
          <Text style={{ fontSize: TYPE.footnote, color: p.accent, fontWeight: "600" }}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** "Since 2:05 PM: 2 finished, 1 needs you", dismissible; a tap acts (e.g. shows what needs you). */
export function CatchUpLine({ text, onPress, onDismiss, inset = 16 }: { text: string; onPress?: () => void; onDismiss: () => void; inset?: number }) {
  const { palette: p } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginHorizontal: inset - 6,
        marginBottom: 6,
        paddingLeft: 10,
        paddingRight: 6,
        paddingVertical: 6,
        borderRadius: 10,
        backgroundColor: p.selectionBg,
      }}
    >
      <Pressable
        onPress={onPress ?? onDismiss}
        accessibilityRole="button"
        accessibilityLabel={`While you were away. ${text}`}
        accessibilityLiveRegion="polite"
        style={{ flex: 1, gap: 1 }}
      >
        <Text style={{ fontSize: TYPE.caption, color: p.textMid, fontWeight: "600" }}>While you were away</Text>
        <Text style={{ fontSize: TYPE.footnote, color: p.textBright }} numberOfLines={2}>
          {text}
        </Text>
      </Pressable>
      <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss"
        style={{ minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="xmark" size={13} color={p.textMid} />
      </Pressable>
    </View>
  );
}
