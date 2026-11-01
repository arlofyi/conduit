/**
 * Settings → Diagnostics: the local counters, the last few errors, and the log's two actions.
 * Everything shown here lives only on this phone (data/diagnostics.ts); "Share log" is the one
 * way it leaves, and only when the reader picks where it goes.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import { clearLog, diagLog, getCounters, subscribeDiagnostics } from "../data/diagnostics";
import type { Counters } from "../logic/diagLog";
import { shareDiagnostics } from "./ErrorBoundary";
import { Card, Row, SectionLabel } from "./form";

/** how many recent errors the card lists (the file keeps more) */
const SHOWN_ERRORS = 5;

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(at).toLocaleDateString();
}

export function DiagnosticsCard() {
  const [c, setC] = useState<Counters>(() => getCounters());
  useEffect(() => subscribeDiagnostics(() => setC(getCounters())), []);
  const now = Date.now();
  const both = (run: number, life: number) => `${run} · ${life} total`;

  const share = useCallback(() => {
    shareDiagnostics().catch((e: unknown) => {
      diagLog("warn", "ui", "share.failed", e);
      Alert.alert("Couldn't share the log", e instanceof Error ? e.message : String(e));
    });
  }, []);
  const confirmClear = useCallback(
    () =>
      Alert.alert("Clear the log?", "The diagnostics log and counters on this phone are deleted. Nothing else changes.", [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: clearLog },
      ]),
    [],
  );

  return (
    <>
      <SectionLabel>Diagnostics</SectionLabel>
      <Card>
        <Row
          first
          title="Kept on this phone only"
          subtitle="Nothing is sent anywhere. Counts are this run · all time."
          tone="dim"
        />
        <Row title="Connections" value={both(c.run.connects, c.lifetime.connects)} />
        <Row title="Reconnects" value={both(c.run.reconnects, c.lifetime.reconnects)} />
        <Row title="Connection failures" value={both(c.run.connectionFailures, c.lifetime.connectionFailures)} />
        <Row title="Messages sent" value={both(c.run.messagesSent, c.lifetime.messagesSent)} />
        <Row title="Banners shown" value={both(c.run.notificationsPosted, c.lifetime.notificationsPosted)} />
        <Row title="App starts" value={String(c.lifetime.appStarts)} />
        <Row title="Errors" value={both(c.run.errorsLogged, c.lifetime.errorsLogged)} />
        <Row title="Last error" value={c.lastErrorAt ? ago(c.lastErrorAt, now) : "Never"} />
        {c.recentErrors.slice(0, SHOWN_ERRORS).map((e, i) => (
          <Row
            key={`${e.at}-${i}`}
            title={`${e.source} · ${e.event}`}
            subtitle={e.detail ? `${ago(e.at, now)} — ${e.detail}` : ago(e.at, now)}
            tone="dim"
          />
        ))}
        <Row title="Share log…" tone="accent" onPress={share} />
        <Row title="Clear log" tone="danger" onPress={confirmClear} />
      </Card>
    </>
  );
}
