const { withAppBuildGradle, withAndroidManifest } = require('@expo/config-plugins');

/**
 * Lets the same project build "FlareNode Mesh Lab" as a second, separately
 * installable app: `gradlew assembleRelease -PappIdSuffix=.meshlab` adds the
 * suffix to the application id and changes the launcher name. Without the
 * property the build is the normal FlareNode app. See scripts/build-mesh-lab.bat.
 */
module.exports = function withMeshLabVariant(config) {
  config = withAppBuildGradle(config, (config) => {
    const marker = "project.findProperty('appIdSuffix')";
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents = config.modResults.contents.replace(
        /(\n\s*applicationId\s+['"][^'"]+['"])/,
        `$1
        // -PappIdSuffix=.meshlab builds a separately installable Mesh Lab app
        def appIdSuffix = project.findProperty('appIdSuffix') ?: ''
        if (appIdSuffix) applicationIdSuffix appIdSuffix
        manifestPlaceholders = [appLabel: appIdSuffix ? 'FlareNode Mesh Lab' : '@string/app_name']`
      );
    }
    return config;
  });

  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (application) application.$['android:label'] = '${appLabel}';
    return config;
  });
};
