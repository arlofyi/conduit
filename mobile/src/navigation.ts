import type { NativeBottomTabScreenProps } from "@react-navigation/bottom-tabs/unstable";
import type { CompositeScreenProps, NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type TabParamList = {
  Chats: undefined;
  Settings: undefined;
};

/** Root stack. With no current Mac only Connect/Pair exist; otherwise Tabs is first and
 * Chat/Connect/Pair push over it, and the four sheets present over whatever is showing. */
export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  /** what the list knows about the session; the chat fills in the rest once attached */
  Chat: { sessionId: string; projectId: string; name: string; branch: string | null };
  Connect: undefined;
  Pair: undefined;
  /** "+" on Chats: start a session */
  NewChat: undefined;
  /** "…" on Chats: profile + Switch Mac */
  ChatsMenu: undefined;
  /** "+" in the composer */
  QuickActions: { sessionId: string; running: boolean; agent: string };
  /** tap the chat header */
  SessionInfo: { sessionId: string; projectId: string };
};

export type ChatsProps = CompositeScreenProps<
  NativeBottomTabScreenProps<TabParamList, "Chats">,
  NativeStackScreenProps<RootStackParamList>
>;
export type SettingsProps = CompositeScreenProps<
  NativeBottomTabScreenProps<TabParamList, "Settings">,
  NativeStackScreenProps<RootStackParamList>
>;
export type ChatProps = NativeStackScreenProps<RootStackParamList, "Chat">;
export type ConnectProps = NativeStackScreenProps<RootStackParamList, "Connect">;
export type PairProps = NativeStackScreenProps<RootStackParamList, "Pair">;
export type NewChatProps = NativeStackScreenProps<RootStackParamList, "NewChat">;
export type ChatsMenuProps = NativeStackScreenProps<RootStackParamList, "ChatsMenu">;
export type QuickActionsProps = NativeStackScreenProps<RootStackParamList, "QuickActions">;
export type SessionInfoProps = NativeStackScreenProps<RootStackParamList, "SessionInfo">;
