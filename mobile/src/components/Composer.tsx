/**
 * WhatsApp's composer, in Conduit's materials: a thin "+" (quick actions) outside the field, a
 * slim glass pill that grows upward to about five lines and SHRINKS back (the height is owned
 * here and derived by `composerHeight`, because iOS's self-sizing field kept its tall height
 * after a send), and a round send button bottom-aligned with the last line — always present,
 * dimmed while there is nothing to send. Nothing sits behind it but the conversation, which
 * scrolls under the floating controls.
 */
import React, { useCallback, useRef, useState } from "react";
import { Pressable, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { COMPOSER, composerHeight } from "../logic/composer";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";
import { GlassCircle, GlassSurface, Icon } from "./Glass";

/** Pill padding above + below the text (the field's own content height excludes it). */
const PAD_V = 8;

export function Composer({
  name,
  onSend,
  onActions,
  bottomInset,
  onHeight,
}: {
  /** the session's name, for the accessibility label */
  name: string;
  onSend: (text: string) => void;
  onActions: () => void;
  bottomInset: number;
  /** the bar's full height, so the list can keep its last message clear of it */
  onHeight: (h: number) => void;
}) {
  const { palette: p } = useTheme();
  const [draft, setDraft] = useState("");
  const [content, setContent] = useState<number | null>(null);
  const input = useRef<TextInput>(null);
  const height = composerHeight(draft, content);
  const canSend = draft.trim().length > 0;

  // Measured from an invisible mirror of the text, not from the field's onContentSizeChange:
  // with an explicit height, Fabric does not report a size change for a programmatic value
  // (a cleared draft, a restored one), and that event was the unreliable half of the old bug.
  const onMirror = useCallback((e: LayoutChangeEvent) => {
    setContent(Math.ceil(e.nativeEvent.layout.height) + PAD_V * 2);
  }, []);

  const send = () => {
    if (!canSend) return;
    onSend(draft);
    setDraft("");
    // Forget the old reading too: the next keystroke must start from one line, not resurrect it.
    setContent(null);
  };

  return (
    <View
      onLayout={(e) => onHeight(e.nativeEvent.layout.height)}
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        gap: 8,
        paddingHorizontal: 10,
        paddingTop: 8,
        paddingBottom: Math.max(bottomInset, 10),
      }}
    >
      <GlassCircle symbol="plus" label="Quick actions: stop, compact, clear" onPress={onActions} size={COMPOSER.min} symbolSize={17} />
      <GlassSurface style={{ flex: 1, borderRadius: COMPOSER.min / 2, minHeight: COMPOSER.min }}>
        <Text
          onLayout={onMirror}
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={{ position: "absolute", left: 14, right: 14, top: 0, opacity: 0, fontSize: TYPE.callout, lineHeight: 21 }}
        >
          {/* a trailing newline needs a character after it to take up its line */}
          {draft.endsWith("\n") ? `${draft} ` : draft || " "}
        </Text>
        <TextInput
          ref={input}
          value={draft}
          onChangeText={setDraft}
          multiline
          scrollEnabled={height >= COMPOSER.max}
          placeholder="Message"
          placeholderTextColor={p.textMid}
          accessibilityLabel={`Message ${name}`}
          selectionColor={p.accent}
          keyboardAppearance={p.appearance}
          style={{
            height,
            paddingHorizontal: 14,
            paddingTop: PAD_V,
            paddingBottom: PAD_V,
            color: p.textBright,
            fontSize: TYPE.callout,
            lineHeight: 21,
            textAlignVertical: "top",
          }}
        />
      </GlassSurface>
      <Pressable
        onPress={send}
        disabled={!canSend}
        accessibilityRole="button"
        accessibilityLabel="Send"
        accessibilityState={{ disabled: !canSend }}
        hitSlop={4}
        style={({ pressed }) => ({
          width: COMPOSER.min,
          height: COMPOSER.min,
          borderRadius: COMPOSER.min / 2,
          backgroundColor: canSend ? p.accent : p.selectionBg,
          alignItems: "center",
          justifyContent: "center",
          transform: [{ scale: pressed ? 0.92 : 1 }],
        })}
      >
        <Icon name="paperplane.fill" size={17} color={canSend ? p.meText : p.textDim} weight="semibold" />
      </Pressable>
    </View>
  );
}
