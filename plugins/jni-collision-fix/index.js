const { withAppBuildGradle } = require('@expo/config-plugins');

module.exports = function withJniCollisionFix(config) {
  return withAppBuildGradle(config, (config) => {
    const packagingBlock = `
android {
    packagingOptions {
        pickFirst 'lib/arm64-v8a/libjsi.so'
        pickFirst 'lib/armeabi-v7a/libjsi.so'
        pickFirst 'lib/x86/libjsi.so'
        pickFirst 'lib/x86_64/libjsi.so'
    }
}`;

    if (!config.modResults.contents.includes('packagingOptions')) {
      config.modResults.contents += '\n' + packagingBlock;
    }
    return config;
  });
};
