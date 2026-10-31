/**
 * The file browser: one folder of a session's directory per screen, pushed as the reader goes
 * deeper (so the system back gesture walks back up). The computer (`phone_fs.rs`) decides what
 * is listed: hidden names never are, links are shown but cannot be opened, and a secret
 * (`sensitive`) asks before it is read.
 */
import { useFocusEffect } from "@react-navigation/native";
import * as Sharing from "expo-sharing";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import type { WireFsEntry } from "../bridge/protocol";
import type { AppSymbol } from "../components/androidSymbols";
import { GlassCircle, Icon } from "../components/Glass";
import {
  CANCELLED,
  crumbs,
  DOWNLOAD_MAX,
  entryDetail,
  fileKind,
  formatSize,
  fsErrorText,
  joinPath,
  mimeOf,
  NEEDS_CONFIRM,
  SECRET_PROMPT,
  sortEntries,
} from "../logic/files";
import { listTime } from "../logic/time";
import type { FilesProps, RootStackParamList } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, TYPE } from "../theme/type";

// ---- shared by Files and FileView ----

/** The browser's top bar: back, a title (+ optional subtitle), trailing buttons. */
export function FilesHeader({
  title,
  subtitle,
  onBack,
  right,
  below,
}: {
  title: string;
  subtitle?: string | null;
  onBack: () => void;
  right?: React.ReactNode;
  below?: React.ReactNode;
}) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ backgroundColor: p.sidebarBg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border }}>
      <View style={{ paddingTop: insets.top + 4, paddingBottom: 8, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <GlassCircle symbol="chevron.left" label="Back" onPress={onBack} size={38} symbolSize={16} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" style={{ fontWeight: "600", fontSize: TYPE.callout, color: p.textBright }} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={{ fontSize: TYPE.caption, color: p.textMid, marginTop: 1 }} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
      </View>
      {below}
    </View>
  );
}

export type DownloadProgress = { name: string; received: number; total: number };

/**
 * Download a file into the phone's cache and open the share sheet on it ("Save to Files",
 * another app, AirDrop / Nearby Share). A secret asks first. One at a time: the computer runs
 * one download per connection.
 */
export function useShareDownload(sessionId: string) {
  const { fsDownload } = useLive();
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const cancelled = useRef(false);
  const busy = useRef(false);
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const run = useCallback(
    async (path: string, name: string, size: number | null, confirm: boolean) => {
      if (busy.current) return;
      if (size !== null && size > DOWNLOAD_MAX) {
        Alert.alert("Too large", `Files over ${formatSize(DOWNLOAD_MAX)} can't be downloaded to the phone.`);
        return;
      }
      busy.current = true;
      cancelled.current = false;
      setProgress({ name, received: 0, total: size ?? 0 });
      const r = await fsDownload(sessionId, path, {
        confirm,
        isCancelled: () => cancelled.current,
        onProgress: (received, total) => setProgress({ name, received, total }),
      });
      busy.current = false;
      setProgress(null);
      if (!r.ok) {
        if (r.error === CANCELLED) return;
        if (r.error === NEEDS_CONFIRM && !confirm) {
          Alert.alert(name, SECRET_PROMPT, [
            { text: "Cancel", style: "cancel" },
            { text: "Download", onPress: () => void run(path, name, size, true) },
          ]);
          return;
        }
        Alert.alert("Couldn't download", fsErrorText(r.error));
        return;
      }
      try {
        if (!(await Sharing.isAvailableAsync())) {
          Alert.alert("Downloaded", "Sharing isn't available on this phone.");
          return;
        }
        await Sharing.shareAsync(r.uri, { mimeType: mimeOf(r.name || name), dialogTitle: r.name || name });
      } catch (e) {
        Alert.alert("Couldn't share", e instanceof Error ? e.message : String(e));
      }
    },
    [fsDownload, sessionId],
  );

  const start = useCallback(
    (path: string, name: string, opts: { size?: number | null; sensitive?: boolean; confirmed?: boolean } = {}) => {
      const size = opts.size ?? null;
      if (opts.sensitive && !opts.confirmed) {
        Alert.alert(name, SECRET_PROMPT, [
          { text: "Cancel", style: "cancel" },
          { text: "Download", onPress: () => void run(path, name, size, true) },
        ]);
        return;
      }
      void run(path, name, size, !!opts.confirmed);
    },
    [run],
  );

  const cancel = useCallback(() => {
    cancelled.current = true;
  }, []);

  return { progress, start, cancel };
}

/** A thin strip at the bottom while a download runs. */
export function DownloadStrip({ progress, onCancel }: { progress: DownloadProgress | null; onCancel: () => void }) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  if (!progress) return null;
  const frac = progress.total > 0 ? Math.min(1, progress.received / progress.total) : 0;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: p.border,
        backgroundColor: p.sidebarBg,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: Math.max(insets.bottom, 10),
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <ActivityIndicator size="small" color={p.textMid} />
        <Text style={{ flex: 1, color: p.textBright, fontSize: TYPE.footnote }} numberOfLines={1}>
          {`Downloading ${progress.name}`}
          {progress.total > 0 ? `  ${formatSize(progress.received)} of ${formatSize(progress.total)}` : ""}
        </Text>
        <Pressable onPress={onCancel} hitSlop={10} accessibilityRole="button" accessibilityLabel="Cancel download">
          <Text style={{ color: p.accent, fontSize: TYPE.footnote, fontWeight: "600" }}>Cancel</Text>
        </Pressable>
      </View>
      <View style={{ height: 3, borderRadius: 2, backgroundColor: p.selectionBg, overflow: "hidden" }}>
        <View style={{ width: `${Math.round(frac * 100)}%`, height: 3, backgroundColor: p.accent }} />
      </View>
    </View>
  );
}

// ---- the folder screen ----

type ListState =
  | { phase: "loading" }
  | { phase: "ok"; entries: WireFsEntry[]; truncated: number }
  | { phase: "error"; error: string };

function iconFor(e: WireFsEntry): AppSymbol {
  if (e.link) return "link";
  if (e.dir) return "folder";
  const kind = fileKind(e.name);
  return kind === "image" ? "photo" : "doc.text";
}

export function FilesScreen({ navigation, route }: FilesProps) {
  const { palette: p } = useTheme();
  const { sessionId, path, title } = route.params;
  const { fsList, conn } = useLive();
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const download = useShareDownload(sessionId);
  const rootLabel = title || "Files";
  const trail = crumbs(path, rootLabel);
  const ready = conn.phase === "ready";

  const load = useCallback(async () => {
    const r = await fsList(sessionId, path);
    if (!live.current) return;
    // A failed refresh keeps what is already listed; only a first load shows the error.
    if (r.ok) setState({ phase: "ok", entries: sortEntries(r.entries), truncated: r.truncated });
    else setState((prev) => (prev.phase === "ok" ? prev : { phase: "error", error: r.error }));
  }, [fsList, sessionId, path]);

  // On focus: the first load, and fresh sizes after a save in the viewer.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // Back online after an error: try again by itself.
  useEffect(() => {
    if (ready && state.phase === "error") void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    if (live.current) setRefreshing(false);
  };

  /** Back to a folder already on the stack, else open it fresh. */
  const goToCrumb = (target: string) => {
    if (target === path) return;
    const st = navigation.getState();
    const here = st.index;
    for (let i = here - 1; i >= 0; i--) {
      const r = st.routes[i];
      if (r.name !== "Files") break;
      const prm = r.params as RootStackParamList["Files"];
      if (prm.sessionId === sessionId && prm.path === target) {
        navigation.pop(here - i);
        return;
      }
    }
    navigation.push("Files", { sessionId, path: target, title });
  };

  const open = (e: WireFsEntry) => {
    if (e.link) return;
    const to = joinPath(path, e.name);
    if (e.dir) navigation.push("Files", { sessionId, path: to, title });
    else navigation.push("FileView", { sessionId, path: to, title });
  };

  const more = (e: WireFsEntry) => {
    if (e.link || e.dir) return;
    Alert.alert(e.name, entryDetail(e, listTime(e.mtimeMs, Date.now())), [
      { text: "Cancel", style: "cancel" },
      { text: "Open", onPress: () => open(e) },
      {
        text: "Download to phone",
        onPress: () => download.start(joinPath(path, e.name), e.name, { size: e.size, sensitive: e.sensitive }),
      },
    ]);
  };

  const breadcrumb = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 8, alignItems: "center", gap: 2 }}
    >
      {trail.map((c, i) => {
        const last = i === trail.length - 1;
        return (
          <View key={c.path || "root"} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            {i > 0 ? <Icon name="chevron.right" size={11} color={p.textDim} /> : null}
            <Pressable
              onPress={() => goToCrumb(c.path)}
              disabled={last}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={last ? `${c.label}, current folder` : `Go to ${c.label}`}
              style={{ paddingHorizontal: 4, paddingVertical: 4 }}
            >
              <Text style={{ fontSize: TYPE.footnote, color: last ? p.textBright : p.accent, fontWeight: last ? "600" : "400" }} numberOfLines={1}>
                {c.label}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );

  let body: React.ReactNode;
  if (state.phase === "loading") {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
        <ActivityIndicator color={p.textMid} />
        <Text style={{ color: p.textMid, fontSize: TYPE.subhead }}>{ready ? "Loading…" : "Waiting for your computer…"}</Text>
      </View>
    );
  } else if (state.phase === "error") {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 14 }}>
        <Text style={{ color: p.textMid, fontSize: TYPE.subhead, textAlign: "center" }}>{fsErrorText(state.error)}</Text>
        <Pressable onPress={() => { setState({ phase: "loading" }); void load(); }} accessibilityRole="button" hitSlop={8}>
          <Text style={{ color: p.accent, fontSize: TYPE.subhead, fontWeight: "600" }}>Try again</Text>
        </Pressable>
      </View>
    );
  } else {
    const now = Date.now();
    body = (
      <FlatList
        data={state.entries}
        keyExtractor={(e) => e.name}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={p.textMid} />}
        contentContainerStyle={{ paddingBottom: 32 }}
        ListEmptyComponent={
          <Text style={{ color: p.textMid, fontSize: TYPE.subhead, textAlign: "center", marginTop: 48 }}>This folder is empty.</Text>
        }
        ListFooterComponent={
          state.truncated > 0 ? (
            <Text style={{ color: p.textDim, fontSize: TYPE.footnote, textAlign: "center", marginTop: 12 }}>
              {`${state.truncated} more not shown`}
            </Text>
          ) : null
        }
        renderItem={({ item: e, index }) => {
          const tint = e.dir ? p.accent : p.textMid;
          return (
            <Pressable
              onPress={() => open(e)}
              onLongPress={() => more(e)}
              disabled={!!e.link}
              accessibilityRole="button"
              accessibilityLabel={`${e.name}, ${e.dir ? "folder" : e.link ? "link, can't be opened" : formatSize(e.size)}${e.sensitive ? ", secret" : ""}`}
              accessibilityState={{ disabled: !!e.link }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: MIN_TOUCH + 8,
                paddingHorizontal: 16,
                paddingVertical: 8,
                backgroundColor: pressed ? p.selectionBg : "transparent",
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: p.border,
                opacity: e.link ? 0.45 : 1,
              })}
            >
              <View style={{ width: 26, alignItems: "center" }}>
                <Icon name={iconFor(e)} size={21} color={tint} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: TYPE.body, color: p.textBright }} numberOfLines={1}>
                  {e.name}
                </Text>
                <Text style={{ fontSize: TYPE.footnote, color: p.textDim, marginTop: 1 }} numberOfLines={1}>
                  {entryDetail(e, listTime(e.mtimeMs, now))}
                </Text>
              </View>
              {e.sensitive ? <Icon name="lock" size={15} color={p.amber} /> : null}
              {e.dir ? <Icon name="chevron.right" size={14} color={p.textDim} /> : null}
            </Pressable>
          );
        }}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <FilesHeader
        title={trail[trail.length - 1].label}
        onBack={() => navigation.goBack()}
        below={path ? breadcrumb : null}
        right={
          <GlassCircle symbol="arrow.clockwise" label="Refresh" onPress={() => void onRefresh()} size={38} symbolSize={16} />
        }
      />
      {body}
      <DownloadStrip progress={download.progress} onCancel={download.cancel} />
    </View>
  );
}
