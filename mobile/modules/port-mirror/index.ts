/**
 * Port mirroring (Android only): the computer's localhost web apps on this phone's localhost.
 * See docs/superpowers/specs/2026-10-31-port-mirroring-design.md.
 *
 * `PortMirror` is null on iOS and web -- there is no native side there, and iOS would suspend
 * the app (and its listeners) the moment Safari came to the front anyway.
 */
import { requireOptionalNativeModule } from "expo";

/** What `addListener` returns. */
export interface EventSubscription {
  remove(): void;
}

export interface MirrorPort {
  /** the port on the computer */
  remote: number;
  /** the port on this phone's 127.0.0.1 it appears on */
  local: number;
}

export interface MirrorStartOptions {
  /** the bridge's ws:// URL the app is connected on */
  url: string;
  /** this phone's device token for that computer; held in memory by the service only */
  token: string;
  /** the computer's name, for the notification */
  computer: string;
  ports: MirrorPort[];
}

export interface MirrorPortStatus extends MirrorPort {
  listening: boolean;
  /** "in use" when another app on the phone already holds the local port */
  error: string | null;
}

export interface MirrorStatus {
  running: boolean;
  /** why it last stopped by itself: "unauthorized" (the computer refused) or "stopped" (the notification's Stop) */
  reason: string | null;
  ports: MirrorPortStatus[];
}

interface PortMirrorNative {
  /** start, or update the port set of a running mirror */
  start(o: MirrorStartOptions): Promise<boolean>;
  stop(): Promise<boolean>;
  status(): MirrorStatus;
  addListener(event: "onStatus", listener: (s: MirrorStatus) => void): EventSubscription;
}

export const PortMirror = requireOptionalNativeModule<PortMirrorNative>("PortMirror");
