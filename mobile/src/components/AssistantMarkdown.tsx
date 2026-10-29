/**
 * An assistant message as the desktop's chat mode renders it (`.hq-assistant` in
 * src/theme.css): markdown prose at the desktop's proportions, code in SF Mono's stand-in
 * (Menlo) inside a horizontally scrolling block so long lines never wrap mid-token, and each
 * `★ Insight` block lifted into the desktop's callout card (`.hq-insight`).
 */
import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import { splitInsights } from "../logic/markdown";
import { hq } from "../theme/hq";
import type { Palette } from "../theme/palettes";
import { useTheme } from "../theme/ThemeContext";
import { MONO, TYPE } from "../theme/type";

/** Body size: the desktop's 14px prose scaled to the phone's reading distance (HIG callout). */
const BODY = TYPE.callout;
const LEAD = 22;

function trimFence(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

function makeRules(p: Palette): RenderRules {
  const h = hq(p);
  const block = (key: string, content: string) => (
    <ScrollView
      key={key}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{
        // a ScrollView defaults to flexGrow 1, which inside a list cell grows without bound
        flexGrow: 0,
        marginVertical: 6,
        backgroundColor: h.code,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: p.border,
      }}
      contentContainerStyle={{ paddingHorizontal: 11, paddingVertical: 9 }}
    >
      <Text selectable style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: p.textBright }}>
        {trimFence(content)}
      </Text>
    </ScrollView>
  );
  return {
    fence: (node) => block(node.key, node.content),
    code_block: (node) => block(node.key, node.content),
  };
}

function makeStyles(p: Palette) {
  const h = hq(p);
  return StyleSheet.create({
    body: { color: p.textBright, fontSize: BODY, lineHeight: LEAD },
    paragraph: { marginTop: 0, marginBottom: 8 },
    heading1: { color: p.textBright, fontSize: 19, lineHeight: 24, fontWeight: "700", marginTop: 6, marginBottom: 6 },
    heading2: { color: p.textBright, fontSize: 17, lineHeight: 22, fontWeight: "700", marginTop: 6, marginBottom: 4 },
    heading3: { color: p.textBright, fontSize: BODY, fontWeight: "700", marginTop: 4, marginBottom: 2 },
    heading4: { color: h.ink2, fontSize: BODY, fontWeight: "600" },
    strong: { fontWeight: "700", color: p.textBright },
    em: { fontStyle: "italic" },
    link: { color: p.accent, textDecorationLine: "none" },
    bullet_list: { marginBottom: 6 },
    ordered_list: { marginBottom: 6 },
    list_item: { marginVertical: 2 },
    bullet_list_icon: { color: p.textMid, marginLeft: 2, marginRight: 8, lineHeight: LEAD },
    ordered_list_icon: { color: p.textMid, marginRight: 6, lineHeight: LEAD, fontVariant: ["tabular-nums"] },
    code_inline: {
      fontFamily: MONO,
      fontSize: 13.5,
      color: p.textBright,
      backgroundColor: h.code,
      borderRadius: 4,
      paddingHorizontal: 3,
      borderWidth: 0,
    },
    blockquote: {
      backgroundColor: "transparent",
      borderLeftWidth: 1,
      borderLeftColor: h.line2,
      paddingLeft: 10,
      paddingVertical: 0,
      marginLeft: 0,
      marginVertical: 4,
    },
    hr: { backgroundColor: p.border, height: StyleSheet.hairlineWidth, marginVertical: 10 },
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: p.border, borderRadius: 6, marginVertical: 6 },
    thead: { backgroundColor: h.code },
    th: { padding: 6 },
    td: { padding: 6 },
    tr: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.border },
    text: { fontSize: BODY },
  });
}

const rulesCache = new Map<Palette, { rules: RenderRules; styles: ReturnType<typeof makeStyles> }>();
function themed(p: Palette) {
  let v = rulesCache.get(p);
  if (!v) {
    v = { rules: makeRules(p), styles: makeStyles(p) };
    rulesCache.set(p, v);
  }
  return v;
}

export function AssistantMarkdown({ text }: { text: string }) {
  const { palette: p } = useTheme();
  const { rules, styles } = themed(p);
  const h = hq(p);
  const segments = useMemo(() => splitInsights(text), [text]);
  return (
    <View>
      {segments.map((seg, i) =>
        seg.kind === "md" ? (
          <Markdown key={i} style={styles} rules={rules} mergeStyle>
            {seg.text}
          </Markdown>
        ) : (
          <View
            key={i}
            style={{
              marginVertical: 6,
              borderWidth: 1,
              borderColor: h.roseLine,
              backgroundColor: h.insightBg,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingTop: 9,
              paddingBottom: 2,
              gap: 4,
            }}
          >
            <Text style={{ fontSize: 11, letterSpacing: 0.66, color: p.accent, fontWeight: "600" }}>★ INSIGHT</Text>
            <Markdown style={styles} rules={rules} mergeStyle>
              {seg.text}
            </Markdown>
          </View>
        ),
      )}
    </View>
  );
}
