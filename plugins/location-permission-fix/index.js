const { withAndroidManifest } = require('@expo/config-plugins');

const LOCATION_PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
];

/**
 * A library that declares the location permissions with android:maxSdkVersion
 * (the Ditto SDK did, when the app used it) has that cap applied to the whole
 * app by the manifest merger, so on Android 13+ the app can never be granted
 * location. Dead zone logging needs the phone's real
 * position, so strip that cap from the merged manifest.
 */
module.exports = function withLocationPermissionFix(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    manifest['uses-permission'] = manifest['uses-permission'] || [];

    for (const name of LOCATION_PERMISSIONS) {
      let entry = manifest['uses-permission'].find((p) => p.$['android:name'] === name);
      if (!entry) {
        entry = { $: { 'android:name': name } };
        manifest['uses-permission'].push(entry);
      }
      entry.$['tools:remove'] = 'android:maxSdkVersion';
    }
    return config;
  });
};
