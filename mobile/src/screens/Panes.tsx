/**
 * The split view, screen by screen. Each detail screen (a chat, a general chat, a session's
 * files) is wrapped in a `SplitFrame` whose list pane is the matching list screen; the two tabs
 * that own those lists show an empty detail pane beside them until a row is picked.
 *
 * On a phone-width window every wrapper renders exactly the screen it wraps, so nothing changes
 * there. The list in a detail screen's frame is rendered with that screen's (root stack)
 * navigation: the lists only navigate to root routes, and to a tab through `Tabs`.
 */
import React from "react";
import { Text, View } from "react-native";
import { Icon } from "../components/Glass";
import { SplitFrame } from "../components/SplitFrame";
import type { AppSymbol } from "../components/androidSymbols";
import type { ChatProps, ChatsProps, FileViewProps, FilesProps, GeneralChatProps, GeneralProps } from "../navigation";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";
import { ChatScreen } from "./ChatScreen";
import { ChatsScreen } from "./ChatsScreen";
import { FileViewScreen } from "./FileViewScreen";
import { FilesScreen } from "./FilesScreen";
import { GeneralChatScreen } from "./GeneralChatScreen";
import { GeneralScreen } from "./GeneralScreen";

/** A list screen's props, borrowed from a root-stack screen (see the file comment). */
const asList = <T,>(props: { navigation: unknown; route: unknown }) => props as unknown as T;

function EmptyPane({ symbol, text }: { symbol: AppSymbol; text: string }) {
  const { palette: p } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32, backgroundColor: p.panelBg }}>
      <Icon name={symbol} size={34} color={p.textDim} />
      <Text style={{ color: p.textMid, fontSize: TYPE.subhead, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

export function SessionsTab(props: ChatsProps) {
  return (
    <SplitFrame primary="list" list={<ChatsScreen {...props} />}>
      <EmptyPane symbol="bubble.left.and.bubble.right" text="Pick a session to open it here." />
    </SplitFrame>
  );
}

export function GeneralTab(props: GeneralProps) {
  return (
    <SplitFrame primary="list" list={<GeneralScreen {...props} />}>
      <EmptyPane symbol="sparkles" text="Pick a chat to open it here." />
    </SplitFrame>
  );
}

export function ChatPane(props: ChatProps) {
  return (
    <SplitFrame primary="detail" current={{ sessionId: props.route.params.sessionId }} list={<ChatsScreen {...asList<ChatsProps>(props)} />}>
      <ChatScreen {...props} />
    </SplitFrame>
  );
}

export function GeneralChatPane(props: GeneralChatProps) {
  return (
    <SplitFrame primary="detail" current={{ chatId: props.route.params.chatId }} list={<GeneralScreen {...asList<GeneralProps>(props)} />}>
      <GeneralChatScreen {...props} />
    </SplitFrame>
  );
}

export function FilesPane(props: FilesProps) {
  return (
    <SplitFrame primary="detail" current={{ sessionId: props.route.params.sessionId }} list={<ChatsScreen {...asList<ChatsProps>(props)} />}>
      <FilesScreen {...props} />
    </SplitFrame>
  );
}

export function FileViewPane(props: FileViewProps) {
  return (
    <SplitFrame primary="detail" current={{ sessionId: props.route.params.sessionId }} list={<ChatsScreen {...asList<ChatsProps>(props)} />}>
      <FileViewScreen {...props} />
    </SplitFrame>
  );
}
