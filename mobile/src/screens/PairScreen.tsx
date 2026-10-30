import React, { useEffect } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLive } from "../bridge/LiveProvider";
import { BigTitle, Button, Notice, Para, ScreenHeader } from "../components/form";
import type { PairProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { MONO } from "../theme/type";

export function PairScreen({ navigation }: PairProps) {
  const { palette: p } = useTheme();
  const insets = useSafeAreaInsets();
  const { pairing, pair, cancelPairing } = useLive();

  // Leaving the screen abandons the attempt (closes the pairing socket).
  useEffect(() => () => cancelPairing(), [cancelPairing]);

  // Re-pairing while another Mac is current keeps the Tabs route: go back to it.
  const done = pairing?.phase === "done";
  useEffect(() => {
    if (!done) return;
    if (navigation.getState().routes.some((r) => r.name === "Tabs")) navigation.popTo("Tabs");
  }, [done, navigation]);

  if (!pairing) {
    return (
      <View style={{ flex: 1, backgroundColor: p.panelBg }}>
        <ScreenHeader onBack={() => navigation.goBack()} />
      </View>
    );
  }

  const digits = (pairing.code ?? "    ").split("");
  const failed = pairing.phase === "failed";
  const retry = () => {
    // A QR secret is single-use: go back and scan a fresh one. A request can be re-sent.
    if (pairing.target.kind === "request") pair(pairing.target);
    else navigation.goBack();
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBg }}>
      <ScreenHeader title={pairing.macName} onBack={() => navigation.goBack()} />
      <View style={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 24, flex: 1 }}>
        <BigTitle>Approve on your Mac</BigTitle>
        <Para>
          Your Mac is showing a pairing request. Check the code matches, then click Allow there. You only do this
          once per phone.
        </Para>

        <View
          accessible
          accessibilityLabel={pairing.code ? `Code ${pairing.code.split("").join(" ")}` : "Code not received yet"}
          style={{ flexDirection: "row", gap: 10, justifyContent: "center", marginTop: 32 }}
        >
          {digits.map((d, i) => (
            <View
              key={i}
              style={{
                width: 56,
                height: 68,
                borderRadius: 12,
                backgroundColor: p.sidebarBg,
                borderWidth: 1,
                borderColor: p.border,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: p.textBright, fontSize: 32, fontWeight: "700", fontFamily: MONO }}>
                {d.trim() ? d : "·"}
              </Text>
            </View>
          ))}
        </View>

        {failed ? (
          <>
            <Notice text={pairing.error ?? "Couldn't pair"} />
            <Button label="Try again" onPress={retry} style={{ marginTop: 16 }} />
          </>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 28 }}>
            <ActivityIndicator color={p.textDim} />
            <Text style={{ color: p.textMid }}>
              {pairing.phase === "connecting" ? `Reaching ${pairing.macName}…` : "Waiting for your Mac…"}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
