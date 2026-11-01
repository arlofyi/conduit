/**
 * Notifications with the screen off (Android only). While the app is in the background a
 * foreground service holds one authenticated socket to the computer and posts system
 * notifications for questions, permissions and finished turns. Its rules are a Kotlin port of
 * src/logic/watch.ts; data/BgWatchProvider.tsx drives it.
 *
 * `BgWatch` is null on iOS and web: iOS gives a backgrounded app no socket, so there the app
 * behaves exactly as before (in-app banners only).
 */
import { requireOptionalNativeModule } from "expo";

export interface EventSubscription {
  remove(): void;
}

export interface WatchStartOptions {
  /** ws:// URLs, the one working now first */
  addresses: string[];
  /** this phone's device token; held in memory by the service only, never logged */
  token: string;
  /** the computer's name, for the ongoing notification */
  computer: string;
  notifyQuestion: boolean;
  notifyPermission: boolean;
  notifyFinished: boolean;
  /** JSON of `watchBaseline(...)`: what the app had already shown */
  baseline: string;
}

export interface WatchStatus {
  running: boolean;
  /** "connecting" | "watching" | "retrying" | "stopped" */
  phase: "connecting" | "watching" | "retrying" | "stopped";
  /** why it stopped by itself: "unauthorized" (the computer refused the token), "protocol" */
  reason: string | null;
}

interface BgWatchNative {
  /** start, or update a running watcher */
  start(o: WatchStartOptions): Promise<boolean>;
  /** stop, and take its notifications down */
  stop(): Promise<boolean>;
  status(): WatchStatus;
  /** the chat a tapped notification asked to open, consumed once (null if none) */
  takeOpenTarget(): Record<string, unknown> | null;
  /** notifications are allowed for this app (runtime permission AND not switched off) */
  notificationsEnabled(): boolean;
  /** the system may stop the app in the background (not exempt from battery optimization) */
  batteryRestricted(): boolean;
  openBatterySettings(): boolean;
  openNotificationSettings(): boolean;
  addListener(event: "onStatus", listener: (s: WatchStatus) => void): EventSubscription;
  /** a notification was tapped while the app was running: call `takeOpenTarget` */
  addListener(event: "onOpen", listener: () => void): EventSubscription;
}

export const BgWatch = requireOptionalNativeModule<BgWatchNative>("BgWatch");
