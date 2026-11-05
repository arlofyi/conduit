/**
 * The root navigation container's ref, and the ONE way a chat (or general chat) is opened.
 *
 * Phone: push it over the tabs, or replace a chat that is already showing (one chat streams at
 * a time -- a chat left mounted underneath would hold an attachment nobody sees).
 *
 * Split view (tablet / wide window): the session list stays on screen BESIDE the open chat, so
 * picking another row must swap the right pane, not stack a second chat on the first. The
 * stack is reset to `[Tabs, <the new screen>]`, keeping the Tabs route (and its own state) as
 * it was. Files or a file opened from the old chat go with it.
 */
import { CommonActions, StackActions, createNavigationContainerRef } from "@react-navigation/native";
import type { RootStackParamList } from "./navigation";

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

type PaneRoute =
  | { name: "Chat"; params: RootStackParamList["Chat"] }
  | { name: "GeneralChat"; params: RootStackParamList["GeneralChat"] };

/** Open a chat or a general chat. `split` is whether the list is beside the detail pane. */
export function openPane(route: PaneRoute, split: boolean): void {
  if (!navigationRef.isReady()) return;
  const state = navigationRef.getRootState();
  const tabs = state?.routes.find((r) => r.name === "Tabs");
  if (split && tabs) {
    // `reset` takes a partial state; the Tabs route keeps its key and nested state as it was.
    const next = { index: 1, routes: [tabs, { name: route.name, params: route.params }] };
    navigationRef.dispatch(CommonActions.reset(next as unknown as Parameters<typeof CommonActions.reset>[0]));
    return;
  }
  const current = navigationRef.getCurrentRoute()?.name;
  if (current === route.name) {
    navigationRef.dispatch(StackActions.replace(route.name, route.params));
    return;
  }
  // `navigate` with a union-typed route needs the cast; both arms are valid RootStack routes.
  (navigationRef.navigate as (name: string, params: object) => void)(route.name, route.params);
}

export const openChatPane = (params: RootStackParamList["Chat"], split: boolean) => openPane({ name: "Chat", params }, split);
export const openGeneralPane = (params: RootStackParamList["GeneralChat"], split: boolean) =>
  openPane({ name: "GeneralChat", params }, split);
