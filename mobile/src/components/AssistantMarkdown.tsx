/**
 * An assistant message as the desktop's chat mode renders it (`.hq-assistant` in
 * src/theme.css): markdown prose at the desktop's proportions, code in SF Mono's stand-in
 * (Menlo) inside a horizontally scrolling block so long lines never wrap mid-token, and each
 * `★ Insight` block lifted into the desktop's callout card (`.hq-insight`).
 */
import React, { useMemo } from "react";
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown, { MarkdownIt, type RenderRules } from "react-native-markdown-display";
import { safeLink } from "../logic/links";
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

// Module-level so every render passes the SAME parser and handler list: the library's own
// defaults are rebuilt per render, which throws away its memoised parser each time.
const MARKDOWN = MarkdownIt({ typographer: true });
/** No image is ever fetched: a reply's image URL is attacker-choosable (a read web page can
 * plant one) and loading it would tell that server the phone opened the chat. */
const NO_IMAGE_HANDLERS: string[] = [];

/** Open a reply's link only for http(s)/mailto, and only after the reader has seen its host. */
function confirmOpen(href: string | undefined): void {
  const v = safeLink(href);
  if (!v.ok) return;
  Alert.alert("Open this link?", v.host, [
    { text: "Cancel", style: "cancel" },
    { text: "Open", onPress: () => Linking.openURL(v.url).catch(() => undefined) },
  ]);
}

/** The library's own handler opens any URL it is handed; this one never lets it (returns false). */
function onLinkPress(url: string): boolean {
  confirmOpen(url);
  return false;
}

/** Props that never change, as one object (the typings omit `allowedImageHandlers`, which the
 * runtime takes; the `image` rule below would ignore it anyway). */
const STABLE_PROPS = { markdownit: MARKDOWN, onLinkPress, allowedImageHandlers: NO_IMAGE_HANDLERS };

function makeRules(p: Palette): RenderRules {
  const h = hq(p);
  // A link the phone will not open reads as the plain words it wraps, never as a link.
  const link: NonNullable<RenderRules["link"]> = (node, children, _parent, styles) =>
    safeLink(node.attributes.href).ok ? (
      <Text key={node.key} style={styles.link} accessibilityRole="link" onPress={() => confirmOpen(node.attributes.href)}>
        {children}
      </Text>
    ) : (
      <Text key={node.key}>{children}</Text>
    );
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
    link,
    blocklink: link,
    // Never load an image: say what it was, quietly.
    image: (node) => {
      const alt = typeof node.attributes.alt === "string" ? node.attributes.alt.trim() : "";
      return (
        <Text key={node.key} style={{ color: p.textDim, fontStyle: "italic" }}>
          {alt ? `[${alt}]` : "[image]"}
        </Text>
      );
    },
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

/** Memoised on `text`: an older reply never re-parses because a new one arrived. */
export const AssistantMarkdown = React.memo(function AssistantMarkdown({ text }: { text: string }) {
  const { palette: p } = useTheme();
  const { rules, styles } = themed(p);
  const h = hq(p);
  const segments = useMemo(() => splitInsights(text), [text]);
  const md = (key: React.Key | undefined, body: string) => (
    <Markdown
      key={key}
      style={styles}
      rules={rules}
      mergeStyle
      {...STABLE_PROPS}
    >
      {body}
    </Markdown>
  );
  return (
    <View>
      {segments.map((seg, i) =>
        seg.kind === "md" ? (
          md(i, seg.text)
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
            {md(undefined, seg.text)}
          </View>
        ),
      )}
    </View>
  );
});
