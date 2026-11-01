/**
 * Small usage and effort indicators: a bar, a ring, and stepped effort bars. Plain Views and
 * react-native-svg only. Colour is CONSUMPTION (logic/usage.ts `severity`): a meter nearly
 * spent is red, whatever the label reads. Each carries its meaning in an accessibility label
 * so nothing rests on hue alone.
 */
import React from "react";
import { Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { severity, type Severity } from "../logic/usage";
import type { Palette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";

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

/** Stepped bars rising left to right, `filled` of `steps` lit (signal-strength style). */
export function EffortBars({ filled, steps, height = 12, color }: { filled: number; steps: number; height?: number; color?: string }) {
  const { palette: p } = useTheme();
  const ink = color ?? p.accent;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 1.5, height }}>
      {Array.from({ length: steps }, (_, i) => (
        <View
          key={i}
          style={{
            width: 3,
            height: Math.max(3, Math.round(((i + 1) / steps) * height)),
            borderRadius: 1,
            backgroundColor: i < filled ? ink : p.selectionBg,
          }}
        />
      ))}
    </View>
  );
}

/** A compact labelled gauge for the Settings rows: "5h" over a short bar with its percent. */
export function MiniGauge({ caption, used }: { caption: string; used: number | null }) {
  const { palette: p } = useTheme();
  return (
    <View style={{ width: 64, gap: 3 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: TYPE.micro, color: p.textDim }}>{caption}</Text>
        <Text style={{ fontSize: TYPE.micro, color: used === null ? p.textDim : p.textMid, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          {used === null ? "--" : `${Math.round(used * 100)}%`}
        </Text>
      </View>
      <UsageBar fraction={used} height={4} />
    </View>
  );
}
