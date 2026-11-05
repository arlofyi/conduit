import type { NativeBottomTabScreenProps } from "@react-navigation/bottom-tabs/unstable";
import type { CompositeScreenProps, NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type TabParamList = {
  Chats: undefined;
  /** the computer's root chat (HQ): a non-coding chat across projects */
  General: undefined;
  /** the computer's local web apps, mirrored to this phone's localhost */
  Apps: undefined;
  Settings: undefined;
};

/** Root stack. With no current Mac only Connect/Pair exist; otherwise Tabs is first and
 * Chat/Connect/Pair push over it, and the four sheets present over whatever is showing. */
export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  /** what the list knows about the session; the chat fills in the rest once attached */
  Chat: {
    sessionId: string;
    projectId: string;
    name: string;
    branch: string | null;
    /** set by the session sheet: put `/command ` into the composer (`nonce` makes a repeat count) */
    insert?: { command: string; nonce: number };
  };
  Connect: undefined;
  Pair: undefined;
  /** "+" on Chats: start a session */
  NewChat: undefined;
  /** "…" on Chats: profile + Switch computer */
  ChatsMenu: undefined;
  /** the ONE session sheet (the chat header's title tap and its preferences button): details,
   * files, session options, commands, MCP servers, compact / clear / stop.
   * `projectId`/`name`/`branch` let it hand a command back to the chat. */
  QuickActions: {
    sessionId: string;
    running: boolean;
    agent: string;
    projectId?: string;
    name?: string;
    branch?: string | null;
    /** open with a section expanded ("account": the chat's "this account is spent" banner) */
    focus?: "account";
  };
  /** one folder of a session's directory ("" = its root), pushed per folder; `title` names the root */
  Files: { sessionId: string; path: string; title?: string };
  /** one file of a session's directory */
  FileView: { sessionId: string; path: string; title?: string };
  /** one general chat; `title` until the list knows it */
  GeneralChat: { chatId: string; title?: string };
  /** the scope chip on a general chat: which projects it may see */
  GeneralScope: { chatId: string };
  /** "+" on the Chats (general) tab when there is an agent to choose: which agent, then the chat */
  GeneralNew: undefined;
  /** a general chat's settings: attached profiles/projects, model, effort, research, MCP
   * servers (agent read-only). `attach` opens with the attach picker expanded. */
  GeneralSettings: { chatId: string; attach?: boolean };
};

export type ChatsProps = CompositeScreenProps<
  NativeBottomTabScreenProps<TabParamList, "Chats">,
  NativeStackScreenProps<RootStackParamList>
>;
export type AppsProps = CompositeScreenProps<
  NativeBottomTabScreenProps<TabParamList, "Apps">,
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
export type FilesProps = NativeStackScreenProps<RootStackParamList, "Files">;
export type FileViewProps = NativeStackScreenProps<RootStackParamList, "FileView">;
export type GeneralProps = CompositeScreenProps<
  NativeBottomTabScreenProps<TabParamList, "General">,
  NativeStackScreenProps<RootStackParamList>
>;
export type GeneralChatProps = NativeStackScreenProps<RootStackParamList, "GeneralChat">;
export type GeneralScopeProps = NativeStackScreenProps<RootStackParamList, "GeneralScope">;
export type GeneralNewProps = NativeStackScreenProps<RootStackParamList, "GeneralNew">;
export type GeneralSettingsProps = NativeStackScreenProps<RootStackParamList, "GeneralSettings">;
