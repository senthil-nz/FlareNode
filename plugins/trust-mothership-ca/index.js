const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

/**
 * Lets the app reach the Mothership over HTTPS.
 *
 * The Mothership is its own certificate authority (mothership-server/src/
 * tls.js), because a laptop on a local network cannot get a certificate from
 * a public one. A responder installs its certificate once in Android's
 * settings (Security > Encryption and credentials > Install a certificate >
 * CA certificate). Android apps ignore certificates installed that way unless
 * they say otherwise, so this says otherwise.
 *
 * Plain HTTP stays allowed, so a Mothership without HTTPS still works.
 */
const CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

/** Writes the network security configuration into an Android project. */
function writeConfig(androidRoot) {
  const directory = path.join(androidRoot, 'app', 'src', 'main', 'res', 'xml');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'network_security_config.xml'), CONFIG);
}

const withTrustMothershipCa = (config) => {
  config = withDangerousMod(config, ['android', async (config) => {
    writeConfig(config.modRequest.platformProjectRoot);
    return config;
  }]);
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (application) application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return config;
  });
};

module.exports = withTrustMothershipCa;
module.exports.writeConfig = writeConfig;
