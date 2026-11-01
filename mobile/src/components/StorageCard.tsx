/**
 * Settings → Storage: keep chats on this phone for offline reading (default on), how much room
 * they take, and a way to delete them. Turning the switch off deletes them too.
 */
import { useIsFocused } from "@react-navigation/native";
import React, { useEffect } from "react";
import { Alert, Switch } from "react-native";
import { useLive } from "../bridge/LiveProvider";
import { usePrefs } from "../data/PrefsProvider";
import { formatBytes } from "../logic/attachments";
import { useTheme } from "../theme/ThemeContext";
import { Card, Row, SectionLabel } from "./form";

export function StorageCard() {
  const { palette: p } = useTheme();
  const { prefs, setPrefs } = usePrefs();
  const { storageBytes, refreshStorage, clearSavedChats } = useLive();
  const focused = useIsFocused();
  useEffect(() => {
    if (focused) refreshStorage();
  }, [focused, refreshStorage]);

  const title = "Keep chats on this phone";
  const size = storageBytes === null ? "…" : storageBytes === 0 ? "Nothing saved" : formatBytes(storageBytes);
  const confirmClear = () =>
    Alert.alert("Clear saved chats?", "The sessions list and chats saved for reading offline are deleted from this phone. Nothing changes on your computer.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: clearSavedChats },
    ]);

  return (
    <>
      <SectionLabel>Storage</SectionLabel>
      <Card>
        <Row
          first
          title={title}
          subtitle="Read your sessions and the chats you've opened with Tailscale off or no signal. Private sessions are never kept."
          accessibilityLabel={title}
          right={
            <Switch
              value={prefs.keepChats}
              onValueChange={(v) => setPrefs({ keepChats: v })}
              trackColor={{ true: p.accent, false: p.selectionBg }}
              accessibilityLabel={title}
            />
          }
        />
        <Row title="Saved on this phone" value={prefs.keepChats ? size : "Off"} />
        <Row title="Clear saved chats" tone="danger" onPress={confirmClear} disabled={!storageBytes} />
      </Card>
    </>
  );
}
