import { useIsFocused } from "@react-navigation/native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IS_SIMULATOR_OR_DEV, useLive, type PairTarget } from "../bridge/LiveProvider";
import type { LoopbackFound } from "../bridge/probe";
import type { WireMac } from "../bridge/protocol";
import { BigTitle, Button, Card, Notice, Para, Row, ScreenHeader, SectionLabel } from "../components/form";
import { connErrorText, qrErrorText } from "../logic/connCopy";
import { isLoopbackMac, parseManualAddress } from "../logic/macs";
import { parseQr } from "../logic/pairing";
import type { ConnectProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, MONO, TYPE } from "../theme/type";

type Mode = "menu" | "scan" | "address";

export function ConnectScreen({ navigation }: ConnectProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const live = useLive();
  const { currentMac, conn, macs, notice, clearNotice, discover, discovered, pair, selectMac } = live;
  const [mode, setMode] = useState<Mode>("menu");
  const [error, setError] = useState<string | null>(null);

  const startPair = useCallback(
    (target: PairTarget) => {
      setError(null);
      clearNotice();
      pair(target);
      setMode("menu");
      navigation.navigate("Pair");
    },
    [clearNotice, navigation, pair],
  );

  // Discovery needs an authenticated socket, so it is only offered with a Mac connected.
  const ready = conn.phase === "ready" && !!currentMac;
  useEffect(() => {
    if (ready) discover();
  }, [ready, discover]);

  const otherSaved = macs.filter((m) => m.deviceId !== currentMac?.deviceId);
  // A Mac this phone is already paired with is listed under "Paired" (or is the current
  // one), never offered for pairing again.
  const isPaired = (m: WireMac) =>
    macs.some((s) => (!!m.dnsName && m.dnsName === s.dnsName) || (!!m.ip && m.ip === s.ip));
  const tailnetMacs = (discovered ?? []).filter((m) => !isPaired(m));

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <ScreenHeader onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <BigTitle>Connect to your Mac</BigTitle>
        <Para>
          Conduit reaches your Mac through Tailscale, so it works from anywhere, not only on your home Wi-Fi. Turn
          Tailscale on on this phone, signed in to the same tailnet as your Mac.
        </Para>

        {notice ? <Notice text={connErrorText(notice)} /> : null}
        {error ? <Notice text={error} /> : null}

        {mode === "scan" ? (
          <Scanner
            onCancel={() => setMode("menu")}
            onCode={(text) => {
              const r = parseQr(text);
              if (!r.ok) {
                setError(qrErrorText(r.reason));
                setMode("menu");
                return;
              }
              startPair({ kind: "qr", qr: r.qr });
            }}
          />
        ) : mode === "address" ? (
          <AddressForm
            onCancel={() => setMode("menu")}
            onSubmit={(host, port) => {
              const r = parseManualAddress(host, port);
              if (!r.ok) {
                setError(r.error);
                return;
              }
              startPair({ kind: "request", endpoint: r.endpoint });
            }}
          />
        ) : (
          <View style={{ gap: 10, marginTop: 24 }}>
            <Button
              label="Scan QR code"
              onPress={() => {
                setError(null);
                setMode("scan");
              }}
            />
            <Button
              label="Enter address"
              kind="secondary"
              onPress={() => {
                setError(null);
                setMode("address");
              }}
            />
            <Text style={{ color: p.textDim, fontSize: TYPE.footnote, textAlign: "center", marginTop: 2 }}>
              On your Mac: Conduit → Settings → Mobile → Pair a phone
            </Text>
          </View>
        )}

        {ready ? (
          <>
            <SectionLabel>Macs on your tailnet</SectionLabel>
            {discovered === null ? (
              <ActivityIndicator color={p.textDim} style={{ alignSelf: "flex-start" }} />
            ) : tailnetMacs.length === 0 ? (
              <Para style={{ color: p.textDim }}>No other Macs running Conduit on your tailnet.</Para>
            ) : (
              <Card>
                {tailnetMacs.map((m, i) => (
                  <Row
                    key={`${m.dnsName}|${m.ip}|${m.port}`}
                    first={i === 0}
                    title={m.name}
                    subtitle={m.conduitVersion ? `Conduit ${m.conduitVersion}` : m.dnsName}
                    disabled={!m.online}
                    tone={m.online ? undefined : "dim"}
                    accessibilityLabel={`${m.name}, ${m.online ? "online" : "offline"}`}
                    right={
                      <Text style={{ color: m.online ? p.green : p.textDim, fontSize: TYPE.footnote }}>
                        {m.online ? "online" : "offline"}
                      </Text>
                    }
                    onPress={
                      m.online
                        ? () =>
                            startPair({
                              kind: "request",
                              endpoint: { macName: m.name, dnsName: m.dnsName, ip: m.ip, port: m.port },
                            })
                        : undefined
                    }
                  />
                ))}
              </Card>
            )}
          </>
        ) : null}

        {otherSaved.length > 0 ? (
          <>
            <SectionLabel>Paired with this phone</SectionLabel>
            <Card>
              {otherSaved.map((m, i) => (
                <Row
                  key={m.deviceId}
                  first={i === 0}
                  title={m.macName}
                  subtitle={isLoopbackMac(m) ? `This Mac (simulator) · port ${m.port}` : m.dnsName || m.ip}
                  onPress={() => {
                    clearNotice();
                    selectMac(m.deviceId);
                  }}
                />
              ))}
            </Card>
          </>
        ) : null}

        {IS_SIMULATOR_OR_DEV ? <LoopbackSection /> : null}
      </ScrollView>
    </View>
  );
}

/** Camera viewfinder for the pairing QR. One-shot: the first decoded code wins. */
function Scanner({ onCode, onCancel }: { onCode: (text: string) => void; onCancel: () => void }) {
  const { palette: p } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);
  // Only one camera preview may be live at a time: unmount it when the screen loses focus.
  const focused = useIsFocused();

  const onScanned = useCallback(
    (r: BarcodeScanningResult) => {
      if (scanned.current) return;
      scanned.current = true;
      onCode(r.data);
    },
    [onCode],
  );

  let body: React.ReactNode;
  if (!permission) {
    body = <ActivityIndicator color={p.textDim} />;
  } else if (!permission.granted) {
    body = permission.canAskAgain ? (
      <View style={{ gap: 12, padding: 16 }}>
        <Para>Conduit needs the camera to scan the pairing code shown on your Mac.</Para>
        <Button label="Allow camera" onPress={() => requestPermission()} />
      </View>
    ) : (
      <View style={{ gap: 12, padding: 16 }}>
        <Para>Camera access is off. Turn it on in Settings to scan the code, or enter the address instead.</Para>
        <Button label="Open Settings" onPress={() => Linking.openSettings()} />
      </View>
    );
  } else if (focused) {
    body = (
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={scanned.current ? undefined : onScanned}
      />
    );
  }

  const granted = !!permission?.granted;
  return (
    <View style={{ marginTop: 24, gap: 10 }}>
      <View
        style={{
          aspectRatio: granted ? 1 : undefined,
          borderRadius: 16,
          overflow: "hidden",
          backgroundColor: p.sidebarBg,
          justifyContent: "center",
        }}
      >
        {body}
      </View>
      <Button label="Cancel" kind="secondary" onPress={onCancel} />
    </View>
  );
}

function AddressForm({ onSubmit, onCancel }: { onSubmit: (host: string, port: string) => void; onCancel: () => void }) {
  const { palette: p } = useTheme();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8455");
  const input = {
    minHeight: MIN_TOUCH + 4,
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: p.sidebarBg,
    color: p.textBright,
    fontSize: TYPE.body,
    fontFamily: MONO,
  } as const;
  return (
    <View style={{ marginTop: 24, gap: 10 }}>
      <Text style={{ color: p.textMid, fontSize: TYPE.footnote }}>Tailscale name or IP</Text>
      <TextInput
        value={host}
        onChangeText={setHost}
        placeholder="my-mac.tailnet.ts.net"
        placeholderTextColor={p.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="Tailscale name or IP"
        style={input}
      />
      <Text style={{ color: p.textMid, fontSize: TYPE.footnote }}>Port</Text>
      <TextInput
        value={port}
        onChangeText={setPort}
        keyboardType="number-pad"
        accessibilityLabel="Port"
        style={input}
        maxLength={5}
      />
      <Button label="Request pairing" onPress={() => onSubmit(host, port)} disabled={!host.trim()} />
      <Button label="Cancel" kind="secondary" onPress={onCancel} />
    </View>
  );
}

/** Simulator/dev: list every Conduit answering on loopback. Never auto-picks — the
 * installed Conduit answers there too, so the developer chooses. */
function LoopbackSection() {
  const { palette: p } = useTheme();
  const { probeLoopback, addLoopback } = useLive();
  const [found, setFound] = useState<LoopbackFound[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // The probe takes seconds; the screen may be gone (e.g. a pick switched Macs) by then.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const scan = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await probeLoopback();
      if (mounted.current) setFound(r);
    } catch {
      if (mounted.current) setFailed("Couldn't probe loopback.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const pick = async (f: LoopbackFound) => {
    try {
      await addLoopback(f);
    } catch {
      if (mounted.current) setFailed(`Couldn't connect to ${f.macName}.`);
    }
  };

  return (
    <>
      <SectionLabel>This Mac (simulator)</SectionLabel>
      <Button label="Find Conduit on this Mac" kind="secondary" busy={busy} onPress={scan} />
      {failed ? <Notice text={failed} /> : null}
      {found && found.length === 0 ? (
        <Para style={{ color: p.textDim, marginTop: 10 }}>Nothing answered on 127.0.0.1:8455–8474.</Para>
      ) : null}
      {found && found.length > 0 ? (
        <View style={{ marginTop: 10 }}>
          <Card>
            {found.map((f, i) => (
              <Row
                key={f.port}
                first={i === 0}
                title={f.macName}
                subtitle={`Conduit ${f.conduitVersion} · port ${f.port}`}
                onPress={() => pick(f)}
              />
            ))}
          </Card>
        </View>
      ) : null}
    </>
  );
}
