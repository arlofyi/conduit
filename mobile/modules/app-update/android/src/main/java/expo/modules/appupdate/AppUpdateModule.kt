package expo.modules.appupdate

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private class NotAnApk(message: String) : CodedException("ERR_APP_UPDATE_URI", message, null)

/**
 * In-app updates from GitHub Releases (see src/data/appUpdate.ts). This side only answers what
 * is INSTALLED and hands a downloaded APK to the system installer; finding, downloading and
 * checking the release is JavaScript.
 *
 * Nothing here can install silently: the system installer asks the user every time, asks once
 * beforehand to allow installs from this app, and rejects an APK whose signing key differs from
 * the installed app's -- which is what makes a release on GitHub safe to offer.
 */
class AppUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  @Suppress("DEPRECATION")
  private fun info() = context.packageManager.getPackageInfo(context.packageName, 0)

  override fun definition() = ModuleDefinition {
    Name("AppUpdate")

    /** The installed build's versionCode: what a release's build number is compared against. */
    Function("versionCode") {
      val i = info()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) i.longVersionCode.toDouble() else @Suppress("DEPRECATION") i.versionCode.toDouble()
    }

    Function("versionName") { info().versionName ?: "" }

    /** Android 8+: has the user allowed this app to install packages? */
    Function("canInstall") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.packageManager.canRequestPackageInstalls() else true
    }

    /** The system page where the user allows installs from this app. */
    Function("openInstallSettings") {
      val intent =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        } else {
          Intent(Settings.ACTION_SECURITY_SETTINGS)
        }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Open the system installer on a downloaded APK (a `content://` URI from expo-file-system). */
    Function("install") { contentUri: String ->
      if (!contentUri.startsWith("content://")) throw NotAnApk("expected a content:// URI")
      val intent =
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(Uri.parse(contentUri), "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
  }
}
