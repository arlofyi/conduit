/**
 * app.json, plus what a release build stamps on it.
 *
 * CONDUIT_MOBILE_BUILD (set by .github/workflows/mobile-release.yml) becomes the Android
 * versionCode -- the number in-app updates compare -- and the versionName's build suffix.
 * Unset (a local build), the versionCode stays app.json's.
 */
const withReleaseSigning = require("./plugins/withReleaseSigning");

module.exports = ({ config }) => {
  const build = Number.parseInt(process.env.CONDUIT_MOBILE_BUILD ?? "", 10);
  const stamped = Number.isInteger(build) && build > 0;
  return withReleaseSigning({
    ...config,
    version: stamped ? `${config.version}.${build}` : config.version,
    android: { ...config.android, ...(stamped ? { versionCode: build } : {}) },
  });
};
