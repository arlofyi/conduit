import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { unstable_getMaterialSymbolSourceAsync } from "expo-symbols";
import React, { useEffect, useMemo, useState } from "react";
import { LogBox, Platform, View, type ImageSourcePropType } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LiveProvider, useLive } from "./src/bridge/LiveProvider";
import { Banner } from "./src/components/Banner";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import { ReduceMotionProvider } from "./src/components/ReduceMotion";
import type { Banner as BannerData } from "./src/logic/banner";
import { PrefsProvider, usePrefs } from "./src/data/PrefsProvider";
import type { RootStackParamList, TabParamList } from "./src/navigation";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { AppUpdateProvider, useAppUpdate } from "./src/data/AppUpdateProvider";
import { ChatPane, FilesPane, FileViewPane, GeneralChatPane, GeneralTab, SessionsTab } from "./src/screens/Panes";
import { useIsSplit } from "./src/components/SplitFrame";
import { navigationRef, openChatPane, openGeneralPane } from "./src/navRef";
import { PairScreen } from "./src/screens/PairScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { AppsScreen } from "./src/screens/AppsScreen";
import { PortMirrorProvider, usePortMirror } from "./src/data/PortMirrorProvider";
import { BgWatchProvider, useBgWatch } from "./src/data/BgWatchProvider";
import { NewChatScreen } from "./src/screens/NewChatScreen";
import { CHAT_TARGET_PREFIX } from "./src/logic/watch";
import { GeneralNewScreen, GeneralSettingsScreen } from "./src/screens/GeneralOptions";
import { GeneralScopeScreen } from "./src/screens/GeneralScopeScreen";
import { ChatsMenuScreen, QuickActionsScreen } from "./src/screens/Sheets";
import { ListSelectionProvider, useListSelection } from "./src/data/ListSelection";
import { needsCount, resolveProfile } from "./src/logic/chatList";
import { openBySession } from "./src/logic/pending";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";
import { ANDROID_SYMBOLS, type AppSymbol } from "./src/components/androidSymbols";

/**
 * A native tab icon. iOS names an SF Symbol; Android's native tab bar takes only an image,
 * so the Material equivalent is rendered to one once (white, tinted by the bar). Until it
 * resolves the tab shows its label alone.
 */
function useTabIcon(sf: AppSymbol) {
  const [android, setAndroid] = useState<ImageSourcePropType | null>(null);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    let live = true;
    unstable_getMaterialSymbolSourceAsync(ANDROID_SYMBOLS[sf], 96, "#ffffff")
      .then((src) => live && setAndroid(src))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sf]);
  if (Platform.OS !== "android") return { type: "sfSymbol" as const, name: sf };
  return android ? { type: "image" as const, source: android } : undefined;
}

// React Native's own dev-only noise: a native-driven animation (the glyph pulse, a bubble's
// arrival) reports its final value back with no JS listener attached. Nothing is wrong, and in
// dev the toast it raises covers the composer. Only this exact message is filtered.
LogBox.ignoreLogs(["Sending `onAnimatedValueUpdate` with no listeners registered."]);

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createNativeBottomTabNavigator<TabParamList>();
/** A banner tap opens its chat (`openChatPane`: over another chat it REPLACES it, since one chat
 * streams at a time; in the split view it swaps the right pane). */
function openFromBanner(b: BannerData, split: boolean) {
  openChatPane({ sessionId: b.sessionId, projectId: b.projectId, name: b.name, branch: b.branch }, split);
}

/**
 * The NATIVE tab bar (UITabBarController via react-native-screens), so iOS 26 draws its own
 * Liquid Glass capsule floating over the content, with SF Symbols and a needs-you badge; older
 * iOS draws its standard translucent bar. Content scrolls under it.
 */
function Tabs() {
  const { palette } = useTheme();
  const { view, pending } = useLive();
  const { profileSel } = useListSelection();
  const profile = view ? resolveProfile(view, profileSel === undefined ? view.activeProfileId : profileSel) : null;
  // Pushed items count too: the poll never marks a held permission as needing you.
  const openPending = useMemo(() => openBySession(pending), [pending]);
  const needs = needsCount(view, profile, openPending);
  const chatsIcon = useTabIcon("bubble.left.and.bubble.right");
  const generalIcon = useTabIcon("sparkles");
  const appsIcon = useTabIcon("globe");
  const settingsIcon = useTabIcon("gearshape");
  // iOS has no port mirror yet, and a tab that can only say "not available" is noise.
  const { available: mirrorAvailable } = usePortMirror();
  // A newer phone app on GitHub: a dot on Settings, where the Update button is.
  const { release } = useAppUpdate();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textMid,
        tabBarBlurEffect: palette.appearance === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight",
        tabBarBadgeStyle: { backgroundColor: palette.amber, color: palette.meText },
      }}
    >
      <Tab.Screen
        name="Chats"
        component={SessionsTab}
        options={{
          // route names stay Chats/General; what the reader sees is Sessions/Chats
          title: "Sessions",
          tabBarIcon: chatsIcon,
          tabBarBadge: needs > 0 ? needs : undefined,
        }}
      />
      <Tab.Screen name="General" component={GeneralTab} options={{ title: "Chats", tabBarIcon: generalIcon }} />
      {mirrorAvailable && <Tab.Screen name="Apps" component={AppsScreen} options={{ tabBarIcon: appsIcon }} />}
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: settingsIcon, tabBarBadge: release ? "1" : undefined }} />
    </Tab.Navigator>
  );
}

/** Fitted native form sheet; transparent so iOS 26 gives it its own glass. */
const SHEET = {
  presentation: "formSheet" as const,
  sheetAllowedDetents: "fitToContents" as const,
  sheetGrabberVisible: true,
  sheetCornerRadius: 28,
  // Otherwise the sheet adopts the FIRST scroll view inside it as its content scroll view and
  // offsets it (the New chat sheet's project row rendered on top of the title).
  sheetExpandsWhenScrolledToEdge: false,
  gestureEnabled: true,
  contentStyle: { backgroundColor: "transparent" },
};

/** iOS draws its own glass behind a transparent sheet; Android has none, so a transparent
 * sheet showed the chat straight through its header (seen on a vivo X200 Pro). */
function sheetOptions(bg: string) {
  return Platform.OS === "android" ? { ...SHEET, contentStyle: { backgroundColor: bg } } : SHEET;
}

function Inner() {
  const { palette } = useTheme();
  const { loaded: prefsLoaded } = usePrefs();
  const { loaded, currentMac } = useLive();
  const base = palette.appearance === "dark" ? DarkTheme : DefaultTheme;
  const sheet = useMemo(() => sheetOptions(palette.sidebarBg), [palette.sidebarBg]);
  // Split view (tablet / wide window): the list stays put beside the detail pane, so a detail
  // screen fades in rather than sliding the whole window -- including the list -- over.
  const split = useIsSplit();
  const pane = useMemo(() => (split ? { animation: "fade" as const } : {}), [split]);
  // A tapped system notification (Android, screen off) opens its chat once navigation is up.
  const { openTarget, consumeOpenTarget } = useBgWatch();
  const [navReady, setNavReady] = useState(false);
  useEffect(() => {
    if (!openTarget || !currentMac || !navReady) return;
    consumeOpenTarget();
    // A finished general chat's notification names `chat:<id>`, not a session.
    if (openTarget.sessionId.startsWith(CHAT_TARGET_PREFIX)) {
      openGeneralPane({ chatId: openTarget.sessionId.slice(CHAT_TARGET_PREFIX.length), title: openTarget.name }, split);
      return;
    }
    openChatPane(openTarget, split);
  }, [openTarget, currentMac, navReady, consumeOpenTarget, split]);
  // Memoized: Inner re-renders on every LiveProvider frame, and a fresh theme object makes the
  // whole navigation tree re-render with it.
  const navTheme: Theme = useMemo(
    () => ({
      ...base,
      colors: {
        ...base.colors,
        background: palette.panelBg,
        card: palette.sidebarBg,
        text: palette.textBright,
        border: palette.border,
        primary: palette.accent,
      },
    }),
    [base, palette.panelBg, palette.sidebarBg, palette.textBright, palette.border, palette.accent],
  );

  // Hold the first frame until we know which Mac (if any) to open on and which theme.
  if (!loaded || !prefsLoaded) return <View style={{ flex: 1, backgroundColor: palette.panelBg }} />;

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme} onReady={() => setNavReady(true)}>
      <StatusBar style={palette.appearance === "dark" ? "light" : "dark"} />
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          // native iOS edge-swipe-back, extended to the full screen width
          gestureEnabled: true,
          fullScreenGestureEnabled: true,
          contentStyle: { backgroundColor: palette.panelBg },
        }}
      >
        {currentMac ? (
          // Keyed by Mac: switching, pairing or forgetting resets the stack to the new Mac's tabs.
          <Stack.Group navigationKey={currentMac.deviceId}>
            <Stack.Screen name="Tabs" component={Tabs} />
            <Stack.Screen name="Chat" component={ChatPane} options={pane} />
            <Stack.Screen name="Connect" component={ConnectScreen} />
            <Stack.Screen name="Pair" component={PairScreen} />
            <Stack.Screen name="Files" component={FilesPane} options={pane} />
            <Stack.Screen name="FileView" component={FileViewPane} options={pane} />
            <Stack.Screen name="GeneralChat" component={GeneralChatPane} options={pane} />
            <Stack.Screen name="GeneralScope" component={GeneralScopeScreen} options={sheet} />
            <Stack.Screen name="GeneralNew" component={GeneralNewScreen} options={sheet} />
            <Stack.Screen name="GeneralSettings" component={GeneralSettingsScreen} options={sheet} />
            <Stack.Screen name="NewChat" component={NewChatScreen} options={sheet} />
            <Stack.Screen name="ChatsMenu" component={ChatsMenuScreen} options={sheet} />
            <Stack.Screen name="QuickActions" component={QuickActionsScreen} options={sheet} />
          </Stack.Group>
        ) : (
          <Stack.Group navigationKey="no-mac">
            <Stack.Screen name="Connect" component={ConnectScreen} />
            <Stack.Screen name="Pair" component={PairScreen} />
          </Stack.Group>
        )}
      </Stack.Navigator>
      {currentMac && <Banner onOpen={(b) => openFromBanner(b, split)} />}
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <PrefsProvider>
            <ThemeProvider>
              <ReduceMotionProvider>
                <LiveProvider>
                  <PortMirrorProvider>
                    <BgWatchProvider>
                      <AppUpdateProvider>
                        <ListSelectionProvider>
                          <Inner />
                        </ListSelectionProvider>
                      </AppUpdateProvider>
                    </BgWatchProvider>
                  </PortMirrorProvider>
                </LiveProvider>
              </ReduceMotionProvider>
            </ThemeProvider>
          </PrefsProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
