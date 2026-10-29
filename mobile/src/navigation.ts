import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { CompositeScreenProps, NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type TabParamList = {
  Chats: undefined;
  Settings: undefined;
};

/** Root stack. With no current Mac only Connect/Pair exist; otherwise Tabs is first and
 * Chat/Connect/Pair push over it. */
export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  /** what the list knows about the session; the chat fills in the rest once attached */
  Chat: { sessionId: string; projectId: string; name: string; branch: string | null };
  Connect: undefined;
  Pair: undefined;
};

export type ChatsProps = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, "Chats">,
  NativeStackScreenProps<RootStackParamList>
>;
export type SettingsProps = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, "Settings">,
  NativeStackScreenProps<RootStackParamList>
>;
export type ChatProps = NativeStackScreenProps<RootStackParamList, "Chat">;
export type ConnectProps = NativeStackScreenProps<RootStackParamList, "Connect">;
export type PairProps = NativeStackScreenProps<RootStackParamList, "Pair">;
