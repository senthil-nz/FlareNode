const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Offline map packs and their label fonts are bundled as plain files
config.resolver.assetExts.push('mbtiles', 'pbf');

module.exports = config;
