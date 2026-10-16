const { withAppBuildGradle } = require('@expo/config-plugins');

/**
 * Signs release builds with FlareNode's own key, when this computer has it.
 *
 * The key and its passwords live outside the repository, in
 * ~/.flarenode/signing.properties (see scripts/create-signing-key.bat):
 *
 *   storeFile=C:/Users/you/.flarenode/flarenode-release.jks
 *   storePassword=...
 *   keyAlias=flarenode
 *   keyPassword=...
 *
 * Without that file, release builds are signed with the debug key as before,
 * so anyone can build from the public code. A build signed with the release
 * key and one signed with the debug key cannot be installed over each other.
 */
const MARKER = '// Release signing (plugins/release-signing)';

const SNIPPET = `
${MARKER}
def flarenodeSigningFile = new File(System.getProperty('user.home'), '.flarenode/signing.properties')
def flarenodeSigning = new Properties()
if (flarenodeSigningFile.exists()) flarenodeSigningFile.withInputStream { flarenodeSigning.load(it) }
android {
    signingConfigs {
        if (flarenodeSigning.getProperty('storeFile')) {
            flarenodeRelease {
                storeFile file(flarenodeSigning.getProperty('storeFile'))
                storePassword flarenodeSigning.getProperty('storePassword')
                keyAlias flarenodeSigning.getProperty('keyAlias')
                keyPassword flarenodeSigning.getProperty('keyPassword')
            }
        }
    }
    buildTypes {
        release {
            if (flarenodeSigning.getProperty('storeFile')) signingConfig signingConfigs.flarenodeRelease
        }
    }
}
`;

/** Adds the release signing set-up to the text of app/build.gradle, once. */
function addReleaseSigning(contents) {
  return contents.includes(MARKER) ? contents : `${contents.trimEnd()}\n${SNIPPET}`;
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (config) => {
    config.modResults.contents = addReleaseSigning(config.modResults.contents);
    return config;
  });

module.exports = withReleaseSigning;
module.exports.addReleaseSigning = addReleaseSigning;
