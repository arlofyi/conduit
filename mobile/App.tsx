import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  StackActions,
  createNavigationContainerRef,
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
import { ReduceMotionProvider } from "./src/components/ReduceMotion";
import type { Banner as BannerData } from "./src/logic/banner";
import { PrefsProvider, usePrefs } from "./src/data/PrefsProvider";
import type { RootStackParamList, TabParamList } from "./src/navigation";
import { ChatScreen } from "./src/screens/ChatScreen";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { PairScreen } from "./src/screens/PairScreen";
import { ChatsScreen } from "./src/screens/ChatsScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { NewChatScreen } from "./src/screens/NewChatScreen";
import { ChatsMenuScreen, QuickActionsScreen, SessionInfoScreen } from "./src/screens/Sheets";
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
const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** A banner tap opens its chat. Over another chat it REPLACES it (one chat streams at a time,
 * and a stack of chats would leave the one below detached); elsewhere it pushes as usual. */
function openFromBanner(b: BannerData) {
  if (!navigationRef.isReady()) return;
  const params = { sessionId: b.sessionId, projectId: b.projectId, name: b.name, branch: b.branch };
  if (navigationRef.getCurrentRoute()?.name === "Chat") navigationRef.dispatch(StackActions.replace("Chat", params));
  else navigationRef.navigate("Chat", params);
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
  const settingsIcon = useTabIcon("gearshape");
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
        component={ChatsScreen}
        options={{
          tabBarIcon: chatsIcon,
          tabBarBadge: needs > 0 ? needs : undefined,
        }}
      />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: settingsIcon }} />
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
  const navTheme: Theme = {
    ...base,
    colors: {
      ...base.colors,
      background: palette.panelBg,
      card: palette.sidebarBg,
      text: palette.textBright,
      border: palette.border,
      primary: palette.accent,
    },
  };

  // Hold the first frame until we know which Mac (if any) to open on and which theme.
  if (!loaded || !prefsLoaded) return <View style={{ flex: 1, backgroundColor: palette.panelBg }} />;

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme}>
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
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="Connect" component={ConnectScreen} />
            <Stack.Screen name="Pair" component={PairScreen} />
            <Stack.Screen name="NewChat" component={NewChatScreen} options={sheet} />
            <Stack.Screen name="ChatsMenu" component={ChatsMenuScreen} options={sheet} />
            <Stack.Screen name="QuickActions" component={QuickActionsScreen} options={sheet} />
            <Stack.Screen name="SessionInfo" component={SessionInfoScreen} options={sheet} />
          </Stack.Group>
        ) : (
          <Stack.Group navigationKey="no-mac">
            <Stack.Screen name="Connect" component={ConnectScreen} />
            <Stack.Screen name="Pair" component={PairScreen} />
          </Stack.Group>
        )}
      </Stack.Navigator>
      {currentMac && <Banner onOpen={openFromBanner} />}
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PrefsProvider>
          <ThemeProvider>
            <ReduceMotionProvider>
              <LiveProvider>
                <ListSelectionProvider>
                  <Inner />
                </ListSelectionProvider>
              </LiveProvider>
            </ReduceMotionProvider>
          </ThemeProvider>
        </PrefsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
