/**
 * The app's last line: a render error anywhere below shows a recoverable screen instead of
 * React Native's red (dev) or white (release) one. It sits OUTSIDE every provider, so it may
 * use nothing they supply -- no theme, no safe area, no live connection -- only the system
 * colour scheme and plain views. "Try again" remounts the whole tree (a fresh connection);
 * "Share log" hands the local diagnostics log to the share sheet.
 */
import * as Sharing from "expo-sharing";
import React from "react";
import { Appearance, Pressable, Share, Text, View } from "react-native";
import { diagLog, exportLog } from "../data/diagnostics";
import { PALETTES } from "../theme/palettes";

interface State {
  error: boolean;
  /** bumps on "Try again": a new key remounts the children from scratch */
  generation: number;
}

/** Share the exported log file; fall back to the text (tail) where file sharing is missing. */
export async function shareDiagnostics(): Promise<void> {
  const out = exportLog();
  if (!out) return;
  try {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(out.uri, { mimeType: "text/plain", dialogTitle: "Conduit diagnostics", UTI: "public.plain-text" });
      return;
    }
  } catch (e) {
    diagLog("warn", "ui", "share.fileFailed", e);
  }
  // The share sheet's text field is not for megabytes: the newest part is what matters.
  const MAX = 100_000;
  await Share.share({ message: out.text.length > MAX ? out.text.slice(-MAX) : out.text });
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: false, generation: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { error: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // the component stack names components, never their props or text
    const stack = (info.componentStack ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(" < ");
    diagLog("error", "ui", "renderError", error, stack ? `in ${stack}` : undefined);
  }

  private retry = () => {
    diagLog("info", "ui", "renderError.retry");
    this.setState((s) => ({ error: false, generation: s.generation + 1 }));
  };

  private share = () => {
    shareDiagnostics().catch((e: unknown) => diagLog("warn", "ui", "share.failed", e));
  };

  render() {
    if (!this.state.error) return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>;
    // the theme provider is below us (it may be what failed): the system scheme picks a palette
    const pal = PALETTES[Appearance.getColorScheme() === "light" ? "warm-light" : "warm-near-black"];
    const bg = pal.panelBg;
    const text = pal.textBright;
    const dim = pal.textMid;
    const accent = pal.accent;
    const button = (label: string, onPress: () => void, primary: boolean) => (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => ({
          minHeight: 48,
          borderRadius: 12,
          paddingHorizontal: 20,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: primary ? accent : "transparent",
          borderWidth: primary ? 0 : 1,
          borderColor: accent,
          opacity: pressed ? 0.7 : 1,
          marginTop: 12,
        })}
      >
        <Text style={{ color: primary ? pal.meText : accent, fontSize: 17, fontWeight: "600" }}>{label}</Text>
      </Pressable>
    );
    return (
      <View style={{ flex: 1, backgroundColor: bg, justifyContent: "center", paddingHorizontal: 28 }} accessibilityRole="alert">
        <Text style={{ color: text, fontSize: 24, fontWeight: "700" }}>Something went wrong</Text>
        <Text style={{ color: dim, fontSize: 16, marginTop: 10, lineHeight: 22 }}>
          Conduit hit an unexpected error. Nothing changed on your computer, and your sessions keep running there.
        </Text>
        <Text style={{ color: dim, fontSize: 14, marginTop: 8, lineHeight: 20 }}>
          The details are in a log kept only on this phone. Share it if you want someone to look at it.
        </Text>
        <View style={{ marginTop: 16 }}>
          {button("Try again", this.retry, true)}
          {button("Share log", this.share, false)}
        </View>
      </View>
    );
  }
}
