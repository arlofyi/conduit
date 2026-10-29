import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LiveProvider, useLive } from "./src/bridge/LiveProvider";
import { PrefsProvider, usePrefs } from "./src/data/PrefsProvider";
import type { RootStackParamList, TabParamList } from "./src/navigation";
import { ChatScreen } from "./src/screens/ChatScreen";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { PairScreen } from "./src/screens/PairScreen";
import { ProjectsScreen } from "./src/screens/ProjectsScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";
import { TYPE } from "./src/theme/type";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function Tabs() {
  const { palette } = useTheme();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textDim,
        tabBarStyle: { backgroundColor: palette.sidebarBg, borderTopColor: palette.border },
        // text-only tabs, as in the prototype
        tabBarIcon: () => null,
        tabBarIconStyle: { display: "none" },
        tabBarLabelStyle: { fontSize: TYPE.subhead, fontWeight: "600" },
        tabBarLabelPosition: "beside-icon",
      }}
    >
      {/* Task 5 replaces ProjectsScreen with the Chats list. */}
      <Tab.Screen name="Chats" component={ProjectsScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

function Inner() {
  const { palette } = useTheme();
  const { loaded: prefsLoaded } = usePrefs();
  const { loaded, currentMac } = useLive();
  const base = palette.appearance === "dark" ? DarkTheme : DefaultTheme;
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
    <NavigationContainer theme={navTheme}>
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
          </Stack.Group>
        ) : (
          <Stack.Group navigationKey="no-mac">
            <Stack.Screen name="Connect" component={ConnectScreen} />
            <Stack.Screen name="Pair" component={PairScreen} />
          </Stack.Group>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PrefsProvider>
          <ThemeProvider>
            <LiveProvider>
              <Inner />
            </LiveProvider>
          </ThemeProvider>
        </PrefsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
