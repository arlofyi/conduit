/**
 * In-app updates (Android only): what is installed, and the hand-off to the system installer.
 * `AppUpdate` is null on iOS and web, and on a build made before this module existed.
 */
import { requireOptionalNativeModule } from "expo";

export interface AppUpdateNative {
  /** the installed build's versionCode */
  versionCode(): number;
  versionName(): string;
  /** Android 8+: the user has allowed this app to install packages */
  canInstall(): boolean;
  openInstallSettings(): void;
  /** open the system installer on a `content://` APK */
  install(contentUri: string): void;
}

export const AppUpdate = requireOptionalNativeModule<AppUpdateNative>("AppUpdate");
