/**
 * WhatsApp's composer, in Conduit's materials: a thin "+" (attach: photos, camera, a file)
 * outside the field, with the picked files as chips above it; a
 * slim glass pill that grows upward to about five lines and SHRINKS back (the height is owned
 * here and derived by `composerHeight`, because iOS's self-sizing field kept its tall height
 * after a send), and a round send button bottom-aligned with the last line — always present,
 * dimmed while there is nothing to send. Nothing sits behind it but the conversation, which
 * scrolls under the floating controls.
 */
import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Keyboard, Modal, Pressable, ScrollView, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { canSendWith, type Attachment } from "../logic/attachments";
import { COMPOSER, composerHeight, composerMetrics } from "../logic/composer";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";
import { GlassCircle, GlassSurface, Icon } from "./Glass";
import type { AppSymbol } from "./androidSymbols";

export type AttachSource = "photos" | "camera" | "file";

/** Pill padding above + below the text (the field's own content height excludes it). */
const PAD_V = 8;

export function Composer({
  name,
  onSend,
  attachments,
  onAttach,
  onRemoveAttachment,
  bottomInset,
  onHeight,
}: {
  /** the session's name, for the accessibility label */
  name: string;
  /** the typed text; the screen adds the attachments' references */
  onSend: (text: string) => void;
  attachments: readonly Attachment[];
  onAttach: (source: AttachSource) => void;
  onRemoveAttachment: (id: string) => void;
  bottomInset: number;
  /** the bar's full height, so the list can keep its last message clear of it */
  onHeight: (h: number) => void;
}) {
  const { palette: p } = useTheme();
  const [draft, setDraft] = useState("");
  const [content, setContent] = useState<number | null>(null);
  // One line of text as it is actually drawn (Dynamic Type can make it far taller than 21 pt).
  const [oneLine, setOneLine] = useState<number | null>(null);
  const input = useRef<TextInput>(null);
  const metrics = composerMetrics(oneLine, PAD_V);
  const height = composerHeight(draft, content, metrics);
  const canSend = canSendWith(draft, attachments);
  const [menuOpen, setMenuOpen] = useState(false);
  const [barH, setBarH] = useState(0);

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

  const openMenu = () => {
    Keyboard.dismiss();
    setMenuOpen(true);
  };
  const choose = (source: AttachSource) => {
    setMenuOpen(false);
    onAttach(source);
  };

  return (
    <View
      onLayout={(e) => {
        setBarH(e.nativeEvent.layout.height);
        onHeight(e.nativeEvent.layout.height);
      }}
      style={{ paddingTop: 8, paddingBottom: Math.max(bottomInset, 10) }}
    >
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 8, paddingHorizontal: 10, paddingBottom: 8 }}
        >
          {attachments.map((a) => (
            <AttachmentChip key={a.id} a={a} onRemove={() => onRemoveAttachment(a.id)} />
          ))}
        </ScrollView>
      ) : null}
      <AttachMenu open={menuOpen} bottom={barH + 6} onChoose={choose} onClose={() => setMenuOpen(false)} />
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 10 }}>
      <GlassCircle symbol="plus" label="Attach a photo or file" onPress={openMenu} size={COMPOSER.min} symbolSize={17} />
      <GlassSurface style={{ flex: 1, borderRadius: COMPOSER.min / 2, minHeight: metrics.min }}>
        <Text
          onLayout={(e) => setOneLine(e.nativeEvent.layout.height)}
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          numberOfLines={1}
          style={{ position: "absolute", left: 14, right: 14, top: 0, opacity: 0, fontSize: TYPE.callout, lineHeight: 21 }}
        >
          {" "}
        </Text>
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
          scrollEnabled={height >= metrics.max}
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
    </View>
  );
}

const SOURCES: { source: AttachSource; symbol: AppSymbol; label: string }[] = [
  { source: "photos", symbol: "photo.on.rectangle", label: "Photos" },
  { source: "camera", symbol: "camera", label: "Camera" },
  { source: "file", symbol: "doc", label: "File" },
];

/** The "+" menu: a small card above the composer; a tap anywhere else closes it. */
function AttachMenu({
  open,
  bottom,
  onChoose,
  onClose,
}: {
  open: boolean;
  bottom: number;
  onChoose: (s: AttachSource) => void;
  onClose: () => void;
}) {
  const { palette: p } = useTheme();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button">
        <View
          style={{
            position: "absolute",
            left: 10,
            bottom,
            minWidth: 200,
            borderRadius: 16,
            backgroundColor: p.sidebarBg,
            borderWidth: 1,
            borderColor: p.border,
            paddingVertical: 6,
            elevation: 8,
            shadowColor: "#000",
            shadowOpacity: 0.3,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
          }}
        >
          {SOURCES.map((s) => (
            <Pressable
              key={s.source}
              onPress={() => onChoose(s.source)}
              accessibilityRole="button"
              accessibilityLabel={s.label}
              android_ripple={{ color: p.selectionBg }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 14,
                paddingHorizontal: 16,
                minHeight: 48,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Icon name={s.symbol} size={22} color={p.accent} />
              <Text style={{ color: p.textBright, fontSize: TYPE.callout }}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

/** A picked file: thumbnail or document glyph, its name, upload state, and a remove button. */
function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const { palette: p } = useTheme();
  const failed = a.state === "failed";
  return (
    <Pressable
      onPress={failed ? () => Alert.alert(`Couldn't attach ${a.name}`, a.error ?? "") : undefined}
      accessibilityLabel={`${a.name}, ${a.state === "uploading" ? "uploading" : failed ? "failed" : "attached"}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        maxWidth: 220,
        paddingLeft: 4,
        paddingRight: 6,
        paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: p.sidebarBg,
        borderWidth: 1,
        borderColor: failed ? p.red : p.border,
      }}
    >
      {a.kind === "image" ? (
        <Image source={{ uri: a.uri }} style={{ width: 36, height: 36, borderRadius: 8, opacity: a.state === "uploading" ? 0.5 : 1 }} />
      ) : (
        <View style={{ width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: p.selectionBg }}>
          <Icon name="doc" size={20} color={p.textMid} />
        </View>
      )}
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ color: p.textBright, fontSize: TYPE.footnote }}>
          {a.name}
        </Text>
        {a.state !== "ready" ? (
          <Text numberOfLines={1} style={{ color: failed ? p.red : p.textDim, fontSize: TYPE.caption }}>
            {failed ? "Failed. Tap for why" : "Sending\u2026"}
          </Text>
        ) : null}
      </View>
      {a.state === "uploading" ? <ActivityIndicator size="small" color={p.textMid} /> : null}
      <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${a.name}`}>
        <Icon name="xmark.circle.fill" size={20} color={p.textMid} />
      </Pressable>
    </Pressable>
  );
}
