/**
 * The desktop's AgentGlyph, sized for a phone list: the agent's real brand mark (tinted with
 * its colour bent toward the theme's ink, as `--glyph-ink`) on a plate washed with the
 * PROJECT's colour, ringed with the session's state. Running and needs-you breathe outward
 * exactly as the desktop's `glyph-pulse` does (2.4 s / 1.6 s, opacity + scale only, so it
 * stays on the native driver) and hold still under Reduce Motion — the ring alone still tells
 * the states apart.
 *
 * With `context` (0..1) the static ring becomes a context gauge: an arc from 12 o'clock
 * filled to the fraction of the context window used, green -> amber (70 %) -> red (90 %),
 * over a faint track. The pulse still carries the running / needs-you state.
 */
import React, { useEffect, useRef } from "react";
import { Animated, Easing, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { AGENT_MARKS, agentInfo, GLYPH_STATE_TITLE, pulsePeriod, type GlyphState } from "../logic/agents";
import { glyphInk, mix } from "../logic/color";
import { contextRing } from "../logic/sessionHeader";
import { useTheme } from "../theme/ThemeContext";
import { useReduceMotion } from "./ReduceMotion";

export { useReduceMotion };

export function AgentMarkGlyph({ agent, size, color }: { agent: string; size: number; color: string }) {
  const mark = AGENT_MARKS[agent];
  if (!mark) {
    return (
      <Text allowFontScaling={false} style={{ color, fontSize: Math.round(size * 0.82), fontWeight: "700", lineHeight: Math.round(size * 1.0) }}>
        {agentInfo(agent).letter}
      </Text>
    );
  }
  return (
    <Svg width={size} height={size} viewBox={mark.viewBox}>
      <Path d={mark.path} fill={color} fillRule={mark.evenOdd ? "evenodd" : "nonzero"} />
    </Svg>
  );
}

export function AgentAvatar({
  agent,
  projectColor,
  state,
  size = 52,
  ground,
  context,
}: {
  agent: string;
  /** the project's accent: the plate's wash */
  projectColor: string | null;
  state?: GlyphState;
  size?: number;
  /** the surface the avatar sits on (the ring's gap) */
  ground?: string;
  /** 0..1 of the context window used: draws the ring as a context gauge; null/absent = state ring */
  context?: number | null;
}) {
  const { palette: p } = useTheme();
  const reduce = useReduceMotion();
  const info = agentInfo(agent);
  const ink = glyphInk(info.tint, p.textBright, p.panelBg);
  const base = ground ?? p.panelBg;
  const plate = mix(projectColor ?? info.tint, base, 0.2);
  const plateEdge = mix(projectColor ?? info.tint, base, 0.42);
  const ring =
    state === "needsInput"
      ? p.amber
      : state === "done"
        ? mix(p.green, base, 0.8)
        : state === "running"
          ? ink
          : state === "idle"
            ? mix(ink, base, 0.45)
            : null;

  const period = pulsePeriod(state);
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // No stopAnimation() here: on a native-driven value it asks the native side for the value
    // back, which floods dev builds with "onAnimatedValueUpdate with no listeners".
    if (!period || reduce) return;
    pulse.setValue(0);
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: period, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [period, reduce, pulse]);
  // glyph-pulse: 0% opacity .6 scale .92 → 60% opacity 0 scale 1.28 → 100% back
  const opacity = pulse.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.6, 0, 0.6] });
  const scale = pulse.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.92, 1.28, 0.92] });

  const ringGap = 2;
  const ringW = state === "running" || state === "needsInput" ? 2 : 1.5;
  // Fixed footprint whatever the state, so a list's text column never shifts when a ring appears.
  const outer = size + (ringGap + 2) * 2;
  const gauge = contextRing(context);
  const stateLabel = state ? `${info.label}, ${GLYPH_STATE_TITLE[state]}` : info.label;
  const label = gauge ? `${stateLabel}, ${gauge.a11y}` : stateLabel;
  const gaugeW = Math.max(2.5, Math.round(size * 0.075 * 2) / 2);
  const gaugeR = (outer - gaugeW) / 2;
  const gaugeC = 2 * Math.PI * gaugeR;
  const gaugeColor = gauge ? (gauge.tone === "bad" ? p.red : gauge.tone === "warn" ? p.amber : p.green) : null;

  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ width: outer, height: outer, alignItems: "center", justifyContent: "center" }}
    >
      {ring && period ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: outer,
            height: outer,
            borderRadius: outer / 2,
            borderWidth: 1.5,
            borderColor: state === "needsInput" ? p.amber : ink,
            opacity: reduce ? 0.55 : opacity,
            transform: reduce ? [] : [{ scale }],
          }}
        />
      ) : null}
      {gauge && gaugeColor ? (
        <Svg pointerEvents="none" width={outer} height={outer} style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}>
          <Circle cx={outer / 2} cy={outer / 2} r={gaugeR} stroke={mix(p.textMid, base, 0.28)} strokeWidth={gaugeW} fill="none" />
          {gauge.fraction > 0 ? (
            <Circle
              cx={outer / 2}
              cy={outer / 2}
              r={gaugeR}
              stroke={gaugeColor}
              strokeWidth={gaugeW}
              fill="none"
              strokeDasharray={`${gaugeC} ${gaugeC}`}
              strokeDashoffset={gaugeC * (1 - gauge.fraction)}
              strokeLinecap={gauge.fraction >= 1 ? "butt" : "round"}
            />
          ) : null}
        </Svg>
      ) : ring ? (
        <View
          pointerEvents="none"
          style={{ position: "absolute", width: outer, height: outer, borderRadius: outer / 2, borderWidth: ringW, borderColor: ring }}
        />
      ) : null}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: plate,
          borderWidth: 1,
          borderColor: plateEdge,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <AgentMarkGlyph agent={agent} size={Math.round(size * 0.5)} color={ink} />
      </View>
    </View>
  );
}
