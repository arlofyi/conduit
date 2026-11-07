/**
 * app.json, plus what a release build stamps on it.
 *
 * .github/workflows/release.yml builds the phone app inside every Conduit release and sets:
 *   CONDUIT_RELEASE_VERSION  the Conduit version (0.51.0): the phone's version name, so the APK,
 *                            the iOS app and the desktop installers of one release agree
 *   CONDUIT_MOBILE_BUILD     the build number derived from it (510009): the Android versionCode,
 *                            which in-app updates compare, and the iOS build number
 * Unset (a local build), app.json's version and versionCode stay as they are.
 */
const withReleaseSigning = require("./plugins/withReleaseSigning");

module.exports = ({ config }) => {
  const build = Number.parseInt(process.env.CONDUIT_MOBILE_BUILD ?? "", 10);
  const stamped = Number.isInteger(build) && build > 0;
  const release = /^\d+\.\d+\.\d+$/.test(process.env.CONDUIT_RELEASE_VERSION ?? "")
    ? process.env.CONDUIT_RELEASE_VERSION
    : null;
  return withReleaseSigning({
    ...config,
    version: release ?? (stamped ? `${config.version}.${build}` : config.version),
    android: { ...config.android, ...(stamped ? { versionCode: build } : {}) },
    ios: { ...config.ios, ...(stamped ? { buildNumber: String(build) } : {}) },
  });
};
