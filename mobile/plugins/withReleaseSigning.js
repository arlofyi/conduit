/**
 * Sign RELEASE builds with Conduit's own key when one is provided, instead of the template's
 * debug key.
 *
 * Why it matters: an APK can only update an installed app signed with the SAME key, and the
 * template's `debug.keystore` is public (every React Native project ships the same one). In-app
 * updates offer any APK on the GitHub release, and Android installs it over Conduit only when
 * the keys match -- so a release signed with the public key would let anyone ship an "update"
 * that inherits Conduit's stored device tokens. CI therefore always signs with the private key.
 *
 * The key comes from the environment at BUILD time (never from this repo):
 *   CONDUIT_KEYSTORE           absolute path to the .jks
 *   CONDUIT_KEYSTORE_PASSWORD  store password
 *   CONDUIT_KEY_ALIAS          key alias
 *   CONDUIT_KEY_PASSWORD       key password
 * With CONDUIT_KEYSTORE unset (a local build) the release build keeps the debug key, exactly as
 * before.
 */
const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "// conduit: release signing";

function apply(gradle) {
  if (gradle.includes(MARK)) return gradle;
  const signing = `    signingConfigs {
        ${MARK}
        release {
            if (System.getenv("CONDUIT_KEYSTORE")) {
                storeFile file(System.getenv("CONDUIT_KEYSTORE"))
                storePassword System.getenv("CONDUIT_KEYSTORE_PASSWORD")
                keyAlias System.getenv("CONDUIT_KEY_ALIAS")
                keyPassword System.getenv("CONDUIT_KEY_PASSWORD")
            }
        }`;
  if (!gradle.includes("    signingConfigs {")) throw new Error("withReleaseSigning: no signingConfigs block in app/build.gradle");
  let out = gradle.replace("    signingConfigs {", signing);
  // Only the RELEASE build type's line: the first `signingConfig signingConfigs.debug` after
  // `release {` inside buildTypes.
  const buildTypes = out.indexOf("buildTypes {");
  const release = out.indexOf("release {", buildTypes);
  const line = "signingConfig signingConfigs.debug";
  const at = out.indexOf(line, release);
  if (buildTypes < 0 || release < 0 || at < 0) throw new Error("withReleaseSigning: no release build type in app/build.gradle");
  out =
    out.slice(0, at) +
    'signingConfig System.getenv("CONDUIT_KEYSTORE") ? signingConfigs.release : signingConfigs.debug' +
    out.slice(at + line.length);
  return out;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    c.modResults.contents = apply(c.modResults.contents);
    return c;
  });
};
module.exports.apply = apply;
