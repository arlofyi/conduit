/**
 * Settings' "App" card (Android): the installed version, the newest phone release on GitHub,
 * and the button that downloads and installs it. Hidden where in-app updates do not exist.
 */
import React from "react";
import { ActivityIndicator, Linking, Switch, Text, View } from "react-native";
import { useAppUpdate } from "../data/AppUpdateProvider";
import { usePrefs } from "../data/PrefsProvider";
import { sizeLabel } from "../logic/update";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";
import { Card, Row, SectionLabel } from "./form";

/** The first lines of the release notes, as plain text. */
function notesPreview(notes: string): string {
  return notes
    .split("\n")
    // Plain text: list/heading markers, emphasis, code ticks, and links shown as their label.
    .map((l) =>
      l
        .replace(/^[-*#>\s]+/, "")
        .replace(/\*\*|__|`/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 6)
    .join("\n");
}

export function UpdateCard() {
  const { palette: p } = useTheme();
  const { prefs, setPrefs } = usePrefs();
  const u = useAppUpdate();
  if (!u.available || !u.installed) return null;
  const busy = u.phase === "checking" || u.phase === "downloading";
  const r = u.release;
  const status =
    u.phase === "checking"
      ? "Checking…"
      : u.phase === "downloading"
        ? u.progress !== null
          ? `Downloading… ${Math.round(u.progress * 100)}%`
          : "Downloading…"
        : u.phase === "handedOff"
          ? "Android's installer is open"
        : u.phase === "current"
          ? "Up to date"
          : r
            ? `Build ${r.build} is available`
            : u.phase === "error"
              ? "Couldn't check"
              : "Not checked yet";
  return (
    <>
      <SectionLabel>App</SectionLabel>
      <Card>
        <Row first title="Version" value={`${u.installed.version} (build ${u.installed.build})`} />
        <Row
          title={status}
          subtitle={u.error ?? undefined}
          right={busy ? <ActivityIndicator color={p.accent} /> : undefined}
          value={busy ? undefined : "Check now"}
          tone={busy ? undefined : "accent"}
          disabled={busy}
          onPress={() => void u.check()}
        />
        {r ? (
          <>
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 4 }}>
              <Text style={{ color: p.textBright, fontSize: TYPE.subhead, fontWeight: "600" }}>{r.title}</Text>
              {r.notes ? <Text style={{ color: p.textMid, fontSize: TYPE.footnote, lineHeight: 18 }}>{notesPreview(r.notes)}</Text> : null}
            </View>
            <Row
              title={`Update to build ${r.build}`}
              subtitle={["Downloads from GitHub, then Android asks you to install it", sizeLabel(r.apkSize)].filter(Boolean).join(" · ")}
              tone="accent"
              disabled={busy}
              onPress={() => void u.install()}
            />
            {u.phase === "handedOff" ? (
              <Row
                title="Open the installer again"
                subtitle="If you closed it or it didn't appear. Uses the APK already downloaded."
                tone="accent"
                onPress={u.reopenInstaller}
              />
            ) : null}
            <Row title="See the release on GitHub" tone="dim" onPress={() => void Linking.openURL(r.pageUrl)} />
          </>
        ) : null}
        <Row
          title="Check automatically"
          subtitle="When the app opens, at most every 6 hours"
          right={
            <Switch
              value={prefs.updateCheck}
              onValueChange={(v) => setPrefs({ updateCheck: v })}
              trackColor={{ true: p.accent, false: p.selectionBg }}
              accessibilityLabel="Check for updates automatically"
            />
          }
        />
      </Card>
    </>
  );
}
