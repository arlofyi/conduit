import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { CompositeScreenProps, NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Agent } from "./data/types";

export type TabParamList = {
  Chats: undefined;
  Settings: undefined;
};

/** Root stack. With no current Mac only Connect/Pair exist; otherwise Tabs is first and
 * Chat/Connect/Pair push over it. */
export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  Chat: { agent: Agent };
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
/** the Chats tab renders ProjectsScreen until Task 5 replaces it */
export type ProjectsProps = ChatsProps;
export type ChatProps = NativeStackScreenProps<RootStackParamList, "Chat">;
export type ConnectProps = NativeStackScreenProps<RootStackParamList, "Connect">;
export type PairProps = NativeStackScreenProps<RootStackParamList, "Pair">;
