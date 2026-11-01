/**
 * One file of a session's directory: text in monospace (line numbers and wrapping optional),
 * markdown rendered the way assistant replies are (with a Source toggle), images drawn from a
 * cached download, and anything else offered as a download. A whole, non-secret text file can
 * be edited and saved; the save carries the stat it started from, so a file changed on the
 * computer meanwhile is a conflict, never silently overwritten.
 */
import { usePreventRemove } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import type { WireFsText } from "../bridge/protocol";
import { AssistantMarkdown } from "../components/AssistantMarkdown";
import { GlassCircle } from "../components/Glass";
import {
  baseName,
  canEdit,
  CONFLICT,
  fileKind,
  formatSize,
  fsErrorText,
  INLINE_IMAGE_MAX,
  languageOf,
  NEEDS_CONFIRM,
  SECRET_PROMPT,
  splitLines,
} from "../logic/files";
import type { FileViewProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, MONO, TYPE } from "../theme/type";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { DownloadStrip, FilesHeader, useShareDownload } from "./FilesScreen";
import { diag } from "../data/diagnostics";

type Doc = WireFsText;
type Load = { phase: "loading" } | { phase: "ok"; doc: Doc } | { phase: "error"; error: string };
type ImageState =
  | { phase: "idle" }
  | { phase: "loading"; received: number; total: number }
  | { phase: "ok"; uri: string }
  | { phase: "error"; error: string };

const CODE_SIZE = 13;
const CODE_LEAD = 19;

function Segmented({ value, options, onChange }: { value: string; options: { id: string; label: string }[]; onChange: (id: string) => void }) {
  const { palette: p } = useTheme();
  return (
    <View style={{ flexDirection: "row", backgroundColor: p.selectionBg, borderRadius: 9, padding: 2 }}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 7, backgroundColor: on ? p.panelBg : "transparent" }}
          >
            <Text style={{ fontSize: TYPE.footnote, fontWeight: on ? "600" : "400", color: on ? p.textBright : p.textMid }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Note({ text, tone = "info" }: { text: string; tone?: "info" | "warn" }) {
  const { palette: p } = useTheme();
  return (
    <View style={{ marginHorizontal: 12, marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: tone === "warn" ? p.pillNeedsBg : p.selectionBg }}>
      <Text style={{ fontSize: TYPE.footnote, color: tone === "warn" ? p.pillNeedsText : p.textMid }}>{text}</Text>
    </View>
  );
}

/** Lines in monospace, virtualized (a 1 MB file is tens of thousands of lines). */
function CodeView({ text, numbers, wrap }: { text: string; numbers: boolean; wrap: boolean }) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  // The code text scales with the system font size, so the gutter's digit width must too, or
  // large text wraps or clips the line numbers.
  const { fontScale } = useWindowDimensions();
  const lines = useMemo(() => splitLines(text), [text]);
  const gutter = Math.ceil(String(lines.length).length * 8 * fontScale) + 14;
  const list = (
    <FlatList
      data={lines}
      keyExtractor={(_l, i) => String(i)}
      initialNumToRender={80}
      maxToRenderPerBatch={80}
      windowSize={15}
      contentContainerStyle={{ paddingTop: 10, paddingBottom: 10 + insets.bottom, paddingRight: 12 }}
      renderItem={({ item, index }) => (
        <View style={{ flexDirection: "row" }}>
          {numbers ? (
            <Text
              style={{ width: gutter, paddingRight: 8, textAlign: "right", fontFamily: MONO, fontSize: CODE_SIZE, lineHeight: CODE_LEAD, color: p.textMid }}
            >
              {index + 1}
            </Text>
          ) : (
            <View style={{ width: 12 }} />
          )}
          <Text
            selectable
            style={{
              flex: wrap ? 1 : undefined,
              fontFamily: MONO,
              fontSize: CODE_SIZE,
              lineHeight: CODE_LEAD,
              color: p.textBright,
            }}
          >
            {item || " "}
          </Text>
        </View>
      )}
    />
  );
  if (wrap) return list;
  return (
    <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
      {list}
    </ScrollView>
  );
}

export function FileViewScreen({ navigation, route }: FileViewProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { sessionId, path } = route.params;
  const name = baseName(path) || path;
  const kind = fileKind(name);
  const { fsRead, fsWrite, fsDownload } = useLive();
  const download = useShareDownload(sessionId);

  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [image, setImage] = useState<ImageState>({ phase: "idle" });
  const [numbers, setNumbers] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [mdMode, setMdMode] = useState<"preview" | "source">("preview");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  /** the reader said yes to opening a secret: downloads of it need no second ask */
  const confirmed = useRef(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const doc = load.phase === "ok" ? load.doc : null;
  const dirty = editing && doc !== null && draft !== doc.content;

  const read = useCallback(
    async (confirm: boolean) => {
      setLoad({ phase: "loading" });
      setImage({ phase: "idle" });
      const r = await fsRead(sessionId, path, confirm);
      if (!live.current) return;
      if (r.ok) {
        const { ok: _ok, ...d } = r;
        setLoad({ phase: "ok", doc: d });
        return;
      }
      if (r.error === NEEDS_CONFIRM && !confirm) {
        Alert.alert(name, SECRET_PROMPT, [
          { text: "Cancel", style: "cancel", onPress: () => navigation.goBack() },
          {
            text: "Open",
            onPress: () => {
              confirmed.current = true;
              void read(true);
            },
          },
        ], { cancelable: true, onDismiss: () => navigation.goBack() });
        setLoad({ phase: "error", error: NEEDS_CONFIRM });
        return;
      }
      setLoad({ phase: "error", error: r.error });
    },
    [fsRead, sessionId, path, name, navigation],
  );

  useEffect(() => {
    void read(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An image is fetched whole into the cache once the read says how big it is.
  const imageWanted = kind === "image" && doc !== null && doc.size <= INLINE_IMAGE_MAX;
  useEffect(() => {
    if (!imageWanted || image.phase !== "idle") return;
    setImage({ phase: "loading", received: 0, total: doc?.size ?? 0 });
    void fsDownload(sessionId, path, {
      confirm: confirmed.current,
      isCancelled: () => !live.current,
      onProgress: (received, total) => live.current && setImage({ phase: "loading", received, total }),
    }).then((r) => {
      if (!live.current) return;
      if (r.ok) setImage({ phase: "ok", uri: r.uri });
      // (cancelled here means another download replaced it; unmounting returned above)
      else setImage({ phase: "error", error: r.error });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageWanted, image.phase]);

  // Leaving with unsaved edits asks first.
  usePreventRemove(dirty, ({ data }) => {
    Alert.alert("Discard your changes?", "They haven't been saved to your computer.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  // The editor clears the keyboard by hand on both platforms (no KeyboardAvoidingView here; on
  // Android edge-to-edge the window no longer resizes), as the chat composer does.
  // With it down, the editor's last lines clear the home indicator / gesture bar instead.
  const { keyboardUp, androidKeyboard, iosKeyboard } = useKeyboardInset();
  const kb = keyboardUp ? (Platform.OS === "ios" ? iosKeyboard : androidKeyboard) : insets.bottom;

  const startEdit = () => {
    if (!doc) return;
    setDraft(doc.content);
    setConflict(false);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (!dirty) {
      setEditing(false);
      return;
    }
    Alert.alert("Discard your changes?", undefined, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => setEditing(false) },
    ]);
  };

  const save = async () => {
    if (!doc || saving) return;
    setSaving(true);
    const content = draft;
    const r = await fsWrite(sessionId, path, content, { mtimeMs: doc.mtimeMs, size: doc.size });
    if (!live.current) return;
    setSaving(false);
    if (r.ok) {
      setConflict(false);
      setLoad({ phase: "ok", doc: { ...doc, content, mtimeMs: r.mtimeMs, size: r.size } });
      setEditing(false);
      Keyboard.dismiss();
      return;
    }
    if (r.error === CONFLICT) {
      setConflict(true);
      return;
    }
    diag.error("files", "edit.saveFailed", undefined, r.error);
    Alert.alert("Couldn't save", fsErrorText(r.error));
  };

  const reloadFromConflict = () => {
    Alert.alert("Reload from your computer?", "Your edits here will be discarded.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reload",
        style: "destructive",
        onPress: () => {
          setConflict(false);
          setEditing(false);
          void read(confirmed.current);
        },
      },
    ]);
  };

  const startDownload = () =>
    download.start(path, name, { size: doc?.size ?? null, sensitive: doc?.sensitive, confirmed: confirmed.current });

  const subtitle = doc
    ? [languageOf(name), formatSize(doc.size), doc.readOnly || doc.truncated ? "read-only" : null].filter(Boolean).join(" · ")
    : null;
  const showsText = doc !== null && !doc.binary && kind !== "image";
  const isMarkdown = kind === "markdown";

  const right = editing ? (
    <View style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
      <Pressable
        onPress={cancelEdit}
        hitSlop={8}
        accessibilityRole="button"
        disabled={saving}
        style={{ minHeight: MIN_TOUCH, marginVertical: -3, justifyContent: "center" }}
      >
        <Text style={{ color: p.textMid, fontSize: TYPE.subhead }}>Cancel</Text>
      </Pressable>
      <Pressable
        onPress={() => void save()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Save"
        accessibilityState={{ disabled: saving || !dirty, busy: saving }}
        disabled={saving || !dirty}
        style={{ minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, marginVertical: -3, alignItems: "center", justifyContent: "center" }}
      >
        {saving ? (
          <ActivityIndicator size="small" color={p.accent} />
        ) : (
          <Text style={{ color: dirty ? p.accent : p.textDim, fontSize: TYPE.subhead, fontWeight: "600" }}>Save</Text>
        )}
      </Pressable>
    </View>
  ) : (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {showsText && doc && canEdit(doc) ? (
        <GlassCircle symbol="pencil" label="Edit" onPress={startEdit} size={36} symbolSize={15} />
      ) : null}
      {doc ? <GlassCircle symbol="square.and.arrow.down" label="Save to phone or share" onPress={startDownload} size={36} symbolSize={15} /> : null}
    </View>
  );

  // The view toggles under the title: Preview/Source for markdown, numbers + wrap for code.
  const codeShown = showsText && !editing && (!isMarkdown || mdMode === "source");
  const toolbar =
    showsText && !editing ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 8 }}>
        {isMarkdown ? (
          <Segmented
            value={mdMode}
            onChange={(v) => setMdMode(v as "preview" | "source")}
            options={[
              { id: "preview", label: "Preview" },
              { id: "source", label: "Source" },
            ]}
          />
        ) : null}
        <View style={{ flex: 1 }} />
        {codeShown ? (
          <>
            <GlassCircle symbol="list.number" label={numbers ? "Hide line numbers" : "Show line numbers"} onPress={() => setNumbers((v) => !v)} size={32} symbolSize={14} primary={numbers} />
            <GlassCircle symbol="text.alignleft" label={wrap ? "Don't wrap lines" : "Wrap lines"} onPress={() => setWrap((v) => !v)} size={32} symbolSize={14} primary={wrap} />
          </>
        ) : null}
      </View>
    ) : null;

  let body: React.ReactNode;
  if (load.phase === "loading") {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={p.textMid} />
      </View>
    );
  } else if (load.phase === "error") {
    body =
      load.error === NEEDS_CONFIRM ? (
        <View style={{ flex: 1 }} />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 14 }}>
          <Text style={{ color: p.textMid, fontSize: TYPE.subhead, textAlign: "center" }}>{fsErrorText(load.error)}</Text>
          <Pressable onPress={() => void read(confirmed.current)} accessibilityRole="button" hitSlop={8}>
            <Text style={{ color: p.accent, fontSize: TYPE.subhead, fontWeight: "600" }}>Try again</Text>
          </Pressable>
        </View>
      );
  } else if (kind === "image") {
    const d = load.doc;
    body =
      d.size > INLINE_IMAGE_MAX ? (
        <Note text={`Too large to show here (${formatSize(d.size)}). Download it to open it in another app.`} />
      ) : image.phase === "ok" ? (
        <View style={{ flex: 1, padding: 12 }}>
          <Image source={{ uri: image.uri }} accessibilityLabel={name} resizeMode="contain" style={{ width: "100%", height: "100%" }} />
        </View>
      ) : image.phase === "error" ? (
        <Note tone="warn" text={fsErrorText(image.error)} />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
          <ActivityIndicator color={p.textMid} />
          {image.phase === "loading" && image.total > 0 ? (
            <Text style={{ color: p.textMid, fontSize: TYPE.footnote }}>{`${formatSize(image.received)} of ${formatSize(image.total)}`}</Text>
          ) : null}
        </View>
      );
  } else if (load.doc.binary) {
    body = <Note text="This isn't a text file. Download it to open it in another app." />;
  } else if (editing) {
    body = (
      <View style={{ flex: 1, paddingBottom: kb }}>
        {conflict ? (
          <View style={{ margin: 12, marginBottom: 0, padding: 12, borderRadius: 10, backgroundColor: p.pillNeedsBg, gap: 10 }}>
            <Text style={{ color: p.pillNeedsText, fontSize: TYPE.footnote }}>{fsErrorText(CONFLICT)}</Text>
            <View style={{ flexDirection: "row", gap: 18 }}>
              <Pressable onPress={reloadFromConflict} accessibilityRole="button" hitSlop={8}>
                <Text style={{ color: p.accent, fontSize: TYPE.subhead, fontWeight: "600" }}>Reload</Text>
              </Pressable>
              <Pressable onPress={() => setConflict(false)} accessibilityRole="button" hitSlop={8}>
                <Text style={{ color: p.textMid, fontSize: TYPE.subhead }}>Keep editing</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          textAlignVertical="top"
          scrollEnabled
          accessibilityLabel={`Edit ${name}`}
          style={{
            flex: 1,
            margin: 0,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontFamily: MONO,
            fontSize: CODE_SIZE,
            lineHeight: CODE_LEAD,
            color: p.textBright,
            backgroundColor: p.panelBg,
          }}
        />
      </View>
    );
  } else {
    const d = load.doc;
    const notes = (
      <>
        {d.truncated ? <Note text={`Showing the first ${formatSize(1024 * 1024)} of ${formatSize(d.size)}. Download the whole file to see the rest.`} /> : null}
        {d.sensitive ? <Note tone="warn" text="This looks like a secret. It can be read here but not changed." /> : null}
      </>
    );
    body =
      isMarkdown && mdMode === "preview" ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
          {notes}
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <AssistantMarkdown text={d.content} />
          </View>
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>
          {notes}
          <CodeView text={d.content} numbers={numbers} wrap={wrap} />
        </View>
      );
  }

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <FilesHeader title={name} subtitle={subtitle} onBack={() => navigation.goBack()} right={right} below={toolbar} />
      {body}
      {!editing ? <DownloadStrip progress={download.progress} onCancel={download.cancel} /> : null}
    </View>
  );
}
