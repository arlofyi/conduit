/**
 * Settings' Usage card: one compact row per agent account (glyph, name, a 5 h and a week
 * gauge); a tap opens the row in place to show its plan, every window with its bar and reset
 * time, credit, models and how fresh the read is. Unknown is said, never drawn as 0 %.
 */
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { UsageState } from "../bridge/LiveProvider";
import { agentInfo } from "../logic/agents";
import { glyphInk } from "../logic/color";
import {
  moneyFraction,
  moneyLabel,
  pickWindows,
  resetCopy,
  sourceNote,
  updatedAgo,
  usedLabel,
  type UsageRow,
} from "../logic/usage";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";
import { AgentMarkGlyph } from "./AgentAvatar";
import { Card } from "./form";
import { Icon } from "./Glass";
import { MiniGauge, UsageBar } from "./UsageMeters";

/** Re-read the clock so "updated 12s ago" and reset times stay true while the screen is up. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function UsageSection({ usage, connected }: { usage: UsageState | null; connected: boolean }) {
  const { palette: p } = useTheme();
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow(15_000);
  if (!usage || usage.rows.length === 0) {
    const text = !connected
      ? "Connect to your computer to see usage."
      : usage
        ? "No agent account has reported usage on your computer yet."
        : "No usage reported yet.";
    return (
      <Card>
        <View style={{ minHeight: MIN_TOUCH + 6, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name="gauge.with.dots.needle.33percent" size={18} color={p.textDim} />
          <Text style={{ flex: 1, color: p.textMid, fontSize: TYPE.subhead }}>{text}</Text>
        </View>
      </Card>
    );
  }
  const toggle = (key: string) => setOpen((o) => (o === key ? null : key));
  return (
    <Card>
      {usage.rows.map((row, i) => (
        <UsageRowView key={row.key} row={row} first={i === 0} open={open === row.key} onToggle={() => toggle(row.key)} now={now} />
      ))}
    </Card>
  );
}

function UsageRowView({ row, first, open, onToggle, now }: { row: UsageRow; first: boolean; open: boolean; onToggle: () => void; now: number }) {
  const { palette: p } = useTheme();
  const info = agentInfo(row.agent);
  const { fiveHour, week } = pickWindows(row);
  const credit = !fiveHour && !week && row.money ? row.money : null;
  const sub = [row.label !== info.label ? row.label : null, row.plan].filter(Boolean).join(" · ");
  const a11y = [
    info.label,
    sub,
    fiveHour ? `5-hour ${usedLabel(fiveHour)}` : null,
    week ? `weekly ${usedLabel(week)}` : null,
    credit ? moneyLabel(credit) : null,
    !fiveHour && !week && !credit ? "no usage reported" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <View style={{ borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, borderTopColor: p.border }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({
          minHeight: MIN_TOUCH + 8,
          paddingHorizontal: 14,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          backgroundColor: pressed ? p.selectionBg : "transparent",
        })}
      >
        <View style={{ width: 24, alignItems: "center" }}>
          <AgentMarkGlyph agent={row.agent} size={18} color={glyphInk(info.tint, p.textBright, p.sidebarBg)} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: p.textBright, fontSize: TYPE.callout, fontWeight: "600" }} numberOfLines={1}>
            {info.id ? info.label : row.label}
          </Text>
          {sub ? (
            <Text style={{ color: p.textDim, fontSize: TYPE.caption, marginTop: 1 }} numberOfLines={1}>
              {sub}
            </Text>
          ) : null}
        </View>
        {credit ? (
          <Text style={{ color: p.textMid, fontSize: TYPE.footnote, fontVariant: ["tabular-nums"] }}>{moneyLabel(credit)}</Text>
        ) : (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <MiniGauge caption="5h" used={fiveHour?.used ?? null} />
            <MiniGauge caption="week" used={week?.used ?? null} />
          </View>
        )}
        <Icon name={open ? "chevron.up" : "chevron.down"} size={12} color={p.textDim} />
      </Pressable>
      {open ? <UsageDetail row={row} now={now} /> : null}
    </View>
  );
}

function UsageDetail({ row, now }: { row: UsageRow; now: number }) {
  const { palette: p } = useTheme();
  const fresh = [updatedAgo(row.updatedAt, now), sourceNote(row.source)].filter(Boolean).join(" · ");
  const line = { color: p.textMid, fontSize: TYPE.footnote } as const;
  return (
    <View style={{ paddingHorizontal: 14, paddingBottom: 12, paddingLeft: 48, gap: 10 }}>
      {row.plan ? (
        <Text style={line}>
          Plan <Text style={{ color: p.textBright, fontWeight: "600" }}>{row.plan}</Text>
        </Text>
      ) : null}
      {row.windows.length === 0 && !row.money ? <Text style={line}>No usage windows reported for this account.</Text> : null}
      {row.windows.map((w, i) => {
        const reset = resetCopy(w.resetsAt, now);
        return (
          <View key={`${w.kind}-${i}`} style={{ gap: 4 }} accessible accessibilityLabel={[w.label, usedLabel(w), reset].filter(Boolean).join(", ")}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ color: p.textBright, fontSize: TYPE.footnote, flexShrink: 1 }} numberOfLines={1}>
                {w.label}
              </Text>
              <Text style={{ color: p.textMid, fontSize: TYPE.footnote, fontVariant: ["tabular-nums"] }}>{usedLabel(w)}</Text>
            </View>
            <UsageBar fraction={w.used} height={5} />
            {reset ? <Text style={{ color: p.textDim, fontSize: TYPE.caption }}>{reset}</Text> : null}
          </View>
        );
      })}
      {row.money ? (
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ color: p.textBright, fontSize: TYPE.footnote }}>Credit</Text>
            <Text style={{ color: p.textMid, fontSize: TYPE.footnote, fontVariant: ["tabular-nums"] }}>{moneyLabel(row.money)}</Text>
          </View>
          {moneyFraction(row.money) !== null ? <UsageBar fraction={moneyFraction(row.money)} height={5} /> : null}
        </View>
      ) : null}
      {row.models.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: p.textDim, fontSize: TYPE.caption, textTransform: "uppercase", letterSpacing: 0.5 }}>Models</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {row.models.map((m) => (
              <View key={m} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: p.selectionBg }}>
                <Text style={{ color: p.textMid, fontSize: TYPE.caption }}>{m}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {fresh ? <Text style={{ color: p.textDim, fontSize: TYPE.caption }}>{fresh}</Text> : null}
    </View>
  );
}
