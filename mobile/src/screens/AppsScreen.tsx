import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useMemo } from "react";
import { Linking, PermissionsAndroid, Platform, ScrollView, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { Icon } from "../components/Glass";
import { Card, Para, Row, SectionLabel } from "../components/form";
import { START_REFUSED, usePortMirror } from "../data/PortMirrorProvider";
import { portRows, type PortRow } from "../logic/ports";
import type { AppsProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { TYPE, tabBarClearance } from "../theme/type";

/** How often the list is re-read while this tab is in front. A dev server started on the
 * computer shows up within this; pull-free, so it need not be fast. */
const FOCUS_POLL_MS = 15_000;

/** Android 13+ asks before an app may post notifications; the mirror's ongoing notification is
 * how the user sees (and stops) it, so ask first. A refusal does not block mirroring. */
async function askForNotifications() {
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) return;
  try {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  } catch {
    // no prompt possible: mirror anyway
  }
}

const STOP_COPY: Record<string, string> = {
  unauthorized: "Your computer refused this phone. Pair again, or check Settings → Mobile on your computer.",
  stopped: "Stopped from the notification.",
  [START_REFUSED]: "Couldn't start mirroring from the background; open the app and try again.",
};

export function AppsScreen(_props: AppsProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { webPorts, refreshPorts, conn } = useLive();
  const mirror = usePortMirror();

  useFocusEffect(
    useCallback(() => {
      refreshPorts();
      const t = setInterval(refreshPorts, FOCUS_POLL_MS);
      return () => clearInterval(t);
    }, [refreshPorts]),
  );

  const rows = useMemo(
    () => portRows(webPorts, mirror.on, mirror.status.ports),
    [webPorts, mirror.on, mirror.status],
  );

  const toggle = async (v: boolean) => {
    if (v) await askForNotifications();
    mirror.setOn(v);
  };

  const open = (r: PortRow) => {
    if (r.url) Linking.openURL(r.url).catch(() => {});
  };

  const stateText = (r: PortRow): string =>
    r.state === "ready" ? "Open" : r.state === "starting" ? "Starting…" : r.state === "inUse" ? "Port busy on phone" : "";

  let body: React.ReactNode;
  if (!mirror.available) {
    body = (
      <Para style={{ marginTop: 16 }}>
        Opening your computer's web apps is available on Android for now. iPhone and iPad suspend apps in the
        background, so Safari could not reach them yet.
      </Para>
    );
  } else if (webPorts && !webPorts.enabled) {
    body = <Para style={{ marginTop: 16 }}>Turned off on your computer (Settings → Mobile).</Para>;
  } else {
    body = (
      <>
        <Card>
          <Row
            first
            title="Mirror to this phone"
            subtitle={mirror.on ? "Open them at the same localhost address" : "Turn on to open these on this phone"}
            accessibilityLabel="Mirror to this phone"
            right={
              <Switch
                value={mirror.on}
                onValueChange={toggle}
                trackColor={{ true: p.accent, false: p.selectionBg }}
                accessibilityLabel="Mirror to this phone"
              />
            }
          />
        </Card>
        {mirror.lastStop ? (
          <Para style={{ marginTop: 8, color: p.amber }}>{STOP_COPY[mirror.lastStop] ?? mirror.lastStop}</Para>
        ) : null}

        <SectionLabel>On your computer</SectionLabel>
        {rows.length === 0 ? (
          <Para>
            {webPorts === null
              ? conn.phase === "ready"
                ? "Looking…"
                : "Not connected to your computer."
              : "No web apps running. Start a dev server, a container or anything that serves HTTP on your computer and it shows up here."}
          </Para>
        ) : (
          <Card>
            {rows.map((r, i) => (
              <Row
                key={r.port}
                first={i === 0}
                title={r.title}
                subtitle={
                  // "Port busy on phone" alone does not say what to do about it
                  r.state === "inUse"
                    ? [r.subtitle, "Another app on this phone is using this port; close it and turn mirroring off and on"].filter(Boolean).join(" · ")
                    : (r.subtitle ?? undefined)
                }
                onPress={r.url ? () => open(r) : undefined}
                accessibilityLabel={r.url ? `Open ${r.title}` : r.title}
                right={
                  r.state === "off" ? undefined : (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text
                        style={{
                          color: r.state === "ready" ? p.accent : r.state === "inUse" ? p.amber : p.textMid,
                          fontSize: TYPE.subhead,
                        }}
                      >
                        {stateText(r)}
                      </Text>
                      {r.state === "ready" ? <Icon name="arrow.up.right.square" size={16} color={p.accent} /> : null}
                    </View>
                  )
                }
              />
            ))}
          </Card>
        )}
        <Para style={{ marginTop: 16, fontSize: TYPE.footnote }}>
          Nothing changes on your computer: apps keep listening on localhost, and only this paired phone can reach them,
          through Conduit. While mirroring, other apps on this phone can reach these ports too.
        </Para>
      </>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 4 }}>
        <Text style={{ fontSize: TYPE.title, fontWeight: "700", color: p.textBright }}>Apps</Text>
      </View>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: tabBarClearance(32, insets.bottom, Platform.OS) }}>
        {body}
      </ScrollView>
    </View>
  );
}
