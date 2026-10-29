import React from "react";
import { Alert, ScrollView, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { Card, Row, SectionLabel } from "../components/form";
import { usePrefs } from "../data/PrefsProvider";
import type { Prefs } from "../data/prefs";
import { connStatus } from "../logic/connCopy";
import { isLoopbackMac } from "../logic/macs";
import type { SettingsProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";

/** `ws://host:port` → `host:port` */
const hostPort = (url: string) => url.replace(/^wss?:\/\//, "");

export function SettingsScreen({ navigation }: SettingsProps) {
  const { palette: p, cycle } = useTheme();
  const insets = useSafeAreaInsets();
  const { currentMac, conn, address, hello, forget } = useLive();
  const { prefs, setPrefs } = usePrefs();

  const macName = hello?.macName ?? currentMac?.macName ?? "—";
  const status = connStatus(conn, macName);
  const route = !currentMac
    ? "—"
    : isLoopbackMac(currentMac)
      ? "This Mac (simulator)"
      : `Tailscale · ${currentMac.dnsName || currentMac.ip}`;

  const confirmForget = () => {
    if (!currentMac) return;
    Alert.alert(
      `Forget ${currentMac.macName}?`,
      "This phone will need to pair again to reach it. To also remove the phone on the Mac, use Settings → Mobile there.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Forget", style: "destructive", onPress: () => forget() },
      ],
    );
  };

  const toggle = (key: keyof Omit<Prefs, "theme">, title: string, first?: boolean) => (
    <Row
      first={first}
      title={title}
      accessibilityLabel={title}
      right={
        <Switch
          value={prefs[key]}
          onValueChange={(v) => setPrefs({ [key]: v })}
          trackColor={{ true: p.accent, false: p.selectionBg }}
          accessibilityLabel={title}
        />
      }
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 4 }}>
        <Text style={{ fontSize: TYPE.title, fontWeight: "700", color: p.textBright }}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 32 }}>
        <SectionLabel>Connection</SectionLabel>
        <Card>
          <Row first title="Mac" value={macName} />
          <Row title="Address" value={address ? hostPort(address) : "—"} />
          <Row title="Route" value={route} />
          <Row
            title="Status"
            right={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: status.tone === "ok" ? p.green : status.tone === "busy" ? p.amber : p.red,
                  }}
                />
                <Text style={{ color: p.textMid, fontSize: TYPE.subhead, flexShrink: 1 }} numberOfLines={2}>
                  {status.tone === "ok" ? "Connected" : status.text}
                </Text>
              </View>
            }
          />
          <Row title="Switch Mac…" tone="accent" onPress={() => navigation.navigate("Connect")} />
          <Row title="Forget this Mac" tone="danger" onPress={confirmForget} disabled={!currentMac} />
        </Card>

        <SectionLabel>Notify me when</SectionLabel>
        <Card>
          {toggle("notifyQuestion", "A session asks a question", true)}
          {toggle("notifyPermission", "A permission is needed")}
          {toggle("notifyFinished", "A session finishes")}
        </Card>

        <SectionLabel>Appearance</SectionLabel>
        <Card>
          <Row first title="Theme" value={p.label} onPress={cycle} accessibilityLabel={`Theme, ${p.label}. Tap to change.`} />
        </Card>
      </ScrollView>
    </View>
  );
}
