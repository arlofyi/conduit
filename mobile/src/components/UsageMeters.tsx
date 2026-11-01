/**
 * Small usage and effort indicators: a bar, a ring, and stepped effort bars. Plain Views and
 * react-native-svg only. Colour is CONSUMPTION (logic/usage.ts `severity`): a meter nearly
 * spent is red, whatever the label reads. Each carries its meaning in an accessibility label
 * so nothing rests on hue alone.
 */
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { UsageBadge } from "../logic/sessionHeader";
import { pickWindows, resetCopy, severity, sourceNote, usedLabel, type Severity, type UsageRow } from "../logic/usage";
import type { Palette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";
import { GlassSurface } from "./Glass";

export function severityColor(p: Palette, s: Severity): string {
  return s === "bad" ? p.red : s === "warn" ? p.amber : p.green;
}

/** A thin horizontal meter. `fraction` null draws an empty track (unknown / uncapped). */
export function UsageBar({ fraction, width, height = 5, used }: { fraction: number | null; width?: number | `${number}%`; height?: number; used?: number }) {
  const { palette: p } = useTheme();
  const f = fraction === null ? 0 : Math.min(1, Math.max(0, fraction));
  const color = severityColor(p, severity(used ?? f));
  return (
    <View style={{ width: width ?? "100%", height, borderRadius: height / 2, backgroundColor: p.selectionBg, overflow: "hidden" }}>
      {fraction !== null ? <View style={{ width: `${Math.round(f * 100)}%`, height, backgroundColor: color }} /> : null}
    </View>
  );
}

/** A ring gauge; `label` (if any) is drawn in its middle. */
export function UsageRing({ used, size = 22, stroke = 3, label }: { used: number | null; size?: number; stroke?: number; label?: string }) {
  const { palette: p } = useTheme();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = used === null ? 0 : Math.min(1, Math.max(0, used));
  const color = severityColor(p, severity(f));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={p.selectionBg} strokeWidth={stroke} fill="none" />
        {used !== null && f > 0 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={`${c} ${c}`}
            strokeDashoffset={c * (1 - f)}
            strokeLinecap="round"
          />
        ) : null}
      </Svg>
      {label ? (
        <Text allowFontScaling={false} style={{ fontSize: Math.max(8, Math.round(size * 0.3)), fontWeight: "700", color: p.textMid, fontVariant: ["tabular-nums"] }}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

/** Stepped bars rising left to right, `filled` of `steps` lit (signal-strength style).
 * `outlined` draws every bar as an outline: the agent's default effort (nothing pinned). */
export function EffortBars({
  filled,
  steps,
  height = 12,
  color,
  outlined = false,
}: {
  filled: number;
  steps: number;
  height?: number;
  color?: string;
  outlined?: boolean;
}) {
  const { palette: p } = useTheme();
  const ink = color ?? p.accent;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 1.5, height }}>
      {Array.from({ length: steps }, (_, i) => (
        <View
          key={i}
          style={{
            width: outlined ? 3.5 : 3,
            height: Math.max(3, Math.round(((i + 1) / steps) * height)),
            borderRadius: 1,
            backgroundColor: outlined ? "transparent" : i < filled ? ink : p.selectionBg,
            borderWidth: outlined ? 1 : 0,
            borderColor: outlined ? p.textDim : undefined,
          }}
        />
      ))}
    </View>
  );
}

/**
 * The chat header's usage gauge: a button exactly the size of the glass buttons beside it, a
 * ring filled to the window's used fraction with the percent inside and the window ("5h") under
 * it, so it reads as usage rather than as another control. Unknown usage draws an empty ring
 * with "--", never a healthy 0 %.
 */
export function HeaderUsageGauge({ badge, size = 38, onPress }: { badge: UsageBadge | null; size?: number; onPress: () => void }) {
  const { palette: p } = useTheme();
  const stroke = 3;
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const f = badge ? Math.min(1, Math.max(0, badge.used)) : 0;
  const color = badge ? severityColor(p, badge.tone) : p.textDim;
  const slop = Math.max(0, (MIN_TOUCH - size) / 2);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={slop}
      accessibilityRole="button"
      accessibilityLabel={badge ? badge.a11y : "Usage: not known yet"}
      accessibilityHint="Shows this account's usage windows"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] })}
    >
      <GlassSurface interactive style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center" }}>
        <Svg width={size} height={size} style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={p.selectionBg} strokeWidth={stroke} fill="none" />
          {badge && f > 0 ? (
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              stroke={color}
              strokeWidth={stroke}
              fill="none"
              strokeDasharray={`${c} ${c}`}
              strokeDashoffset={c * (1 - f)}
              strokeLinecap={f >= 1 ? "butt" : "round"}
            />
          ) : null}
        </Svg>
        <Text
          allowFontScaling={false}
          style={{ fontSize: badge && badge.percent >= 100 ? 9 : 10.5, lineHeight: 12, fontWeight: "700", color: p.textBright, fontVariant: ["tabular-nums"] }}
        >
          {badge ? `${badge.percent}%` : "--"}
        </Text>
        <Text allowFontScaling={false} style={{ fontSize: 7.5, lineHeight: 9, fontWeight: "600", color: p.textMid, letterSpacing: 0.3 }}>
          {badge ? badge.caption : "use"}
        </Text>
      </GlassSurface>
    </Pressable>
  );
}

/** The popover the header gauge opens: the compact windows of the session's account with their
 * bars and reset times. Tapping anywhere closes it. */
export function UsagePopover({ row, top, onClose, now }: { row: UsageRow | null; top: number; onClose: () => void; now: number }) {
  const { palette: p } = useTheme();
  const { fiveHour, week } = pickWindows(row);
  const windows = [fiveHour, week].filter((w): w is NonNullable<typeof w> => w !== null);
  const note = row ? sourceNote(row.source) : null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Close usage" onPress={onClose} style={StyleSheet.absoluteFill}>
      <View
        accessible
        accessibilityLiveRegion="polite"
        style={{
          position: "absolute",
          top,
          right: 10,
          width: 236,
          padding: 12,
          gap: 10,
          borderRadius: 14,
          backgroundColor: p.sidebarBg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: p.border,
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 8,
        }}
      >
        <Text style={{ fontSize: TYPE.footnote, fontWeight: "600", color: p.textBright }} numberOfLines={1}>
          {row ? `Usage · ${row.label}${row.plan ? ` (${row.plan})` : ""}` : "Usage"}
        </Text>
        {windows.length === 0 ? (
          <Text style={{ fontSize: TYPE.footnote, color: p.textMid }}>Your computer has not reported usage for this agent yet.</Text>
        ) : (
          windows.map((w) => {
            const reset = resetCopy(w.resetsAt, now);
            return (
              <View key={w.kind + w.label} style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ fontSize: TYPE.footnote, color: p.textBright }}>{w.label}</Text>
                  <Text style={{ fontSize: TYPE.footnote, color: p.textMid, fontVariant: ["tabular-nums"] }}>{usedLabel(w)}</Text>
                </View>
                <UsageBar fraction={w.used} height={5} />
                {reset ? <Text style={{ fontSize: TYPE.micro, color: p.textDim }}>{reset}</Text> : null}
              </View>
            );
          })
        )}
        {note ? <Text style={{ fontSize: TYPE.micro, color: p.textDim }}>{note}</Text> : null}
      </View>
    </Pressable>
  );
}

/**
 * A compact labelled gauge for the Settings rows: a ring with the percent in it, and beside it
 * what the ring measures ("5h" / "week") over the word "used", so the direction is never a guess
 * (founder report: a bare bar did not say whether it was usage left or usage spent).
 */
export function MiniGauge({ caption, used }: { caption: string; used: number | null }) {
  const { palette: p } = useTheme();
  const percent = used === null ? null : Math.round(Math.min(1, Math.max(0, used)) * 100);
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
      accessible
      accessibilityLabel={percent === null ? `${caption}: not reported` : `${caption}: ${percent}% used`}
    >
      <UsageRing used={used} size={34} stroke={3.5} label={percent === null ? "--" : `${percent}%`} />
      <View>
        <Text style={{ fontSize: TYPE.footnote, fontWeight: "600", color: p.textBright }}>{caption}</Text>
        <Text style={{ fontSize: TYPE.caption, color: p.textDim }}>used</Text>
      </View>
    </View>
  );
}
