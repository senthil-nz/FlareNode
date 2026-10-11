import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Asset } from 'expo-asset';
import { ServerConfig } from './ServerConfig';

import lightStyle from '../../assets/maps/style-light.json';
import darkStyle from '../../assets/maps/style-dark.json';
import bundledPack from '../../assets/maps/default.json';

/**
 * Offline map packs.
 *
 * A pack is an MBTiles file of vector tiles that MapLibre reads straight from
 * disk, so the map works with no network at all. One pack ships inside the
 * app; others can be downloaded from the Mothership to swap the region.
 * Build packs with tools/map-pack.
 */

const BUNDLED_TILES = require('../../assets/maps/default.mbtiles');

// The style asks for glyphs as {fontstack}/{range}.pbf
const FONTS = {
  'Noto Sans Regular': {
    '0-255': require('../../assets/maps/fonts/noto_sans_regular_0_255.pbf'),
    '256-511': require('../../assets/maps/fonts/noto_sans_regular_256_511.pbf'),
    '8192-8447': require('../../assets/maps/fonts/noto_sans_regular_8192_8447.pbf'),
  },
  'Noto Sans Medium': {
    '0-255': require('../../assets/maps/fonts/noto_sans_medium_0_255.pbf'),
    '256-511': require('../../assets/maps/fonts/noto_sans_medium_256_511.pbf'),
    '8192-8447': require('../../assets/maps/fonts/noto_sans_medium_8192_8447.pbf'),
  },
  'Noto Sans Italic': {
    '0-255': require('../../assets/maps/fonts/noto_sans_italic_0_255.pbf'),
    '256-511': require('../../assets/maps/fonts/noto_sans_italic_256_511.pbf'),
    '8192-8447': require('../../assets/maps/fonts/noto_sans_italic_8192_8447.pbf'),
  },
};

const ROOT = `${FileSystem.documentDirectory}maps/`;
const FONTS_DIR = `${ROOT}fonts/`;
const PACKS_DIR = `${ROOT}packs/`;
const ACTIVE_KEY = 'map_pack_id';
const BUNDLED_ID = 'bundled';

const exists = async (uri) => (await FileSystem.getInfoAsync(uri)).exists;
const ensureDir = (uri) => FileSystem.makeDirectoryAsync(uri, { intermediates: true }).catch(() => {});

// Copies a file bundled with the app to a known place on disk
const copyAsset = async (moduleId, to) => {
  if (await exists(to)) return;
  const asset = Asset.fromModule(moduleId);
  await asset.downloadAsync();
  await FileSystem.copyAsync({ from: asset.localUri, to });
};

const bundledFile = () => `${ROOT}bundled-${bundledPack.build}.mbtiles`;
const packFile = (id) => `${PACKS_DIR}${id}.mbtiles`;
const packManifest = (id) => `${PACKS_DIR}${id}.json`;

// "file:///data/..." -> "mbtiles:///data/..."
const tilesUrl = (fileUri) => fileUri.replace(/^file:\/\//, 'mbtiles://');

const styleFor = (template, fileUri) => ({
  ...template,
  glyphs: `${FONTS_DIR}{fontstack}/{range}.pbf`,
  sources: { protomaps: { ...template.sources.protomaps, url: tilesUrl(fileUri) } },
});

let preparing = null;

export const OfflineMap = {
  BUNDLED_ID,

  /** Unpacks the bundled map and fonts on first run. Safe to call repeatedly. */
  prepare() {
    if (!preparing) {
      preparing = (async () => {
        await ensureDir(ROOT);
        await ensureDir(PACKS_DIR);
        for (const [stack, ranges] of Object.entries(FONTS)) {
          // MapLibre looks for a folder named exactly after the font, spaces included
          const dir = `${FONTS_DIR}${encodeURIComponent(stack)}/`;
          await ensureDir(dir);
          for (const [range, moduleId] of Object.entries(ranges)) {
            await copyAsset(moduleId, `${dir}${range}.pbf`);
          }
        }
        await copyAsset(BUNDLED_TILES, bundledFile());

        // Drop the bundled map of an older app version
        for (const name of await FileSystem.readDirectoryAsync(ROOT)) {
          if (name.startsWith('bundled-') && `${ROOT}${name}` !== bundledFile()) {
            await FileSystem.deleteAsync(`${ROOT}${name}`, { idempotent: true });
          }
        }
      })().catch((error) => {
        preparing = null;
        throw error;
      });
    }
    return preparing;
  },

  /** Packs on this phone: the bundled one first, then any downloaded. */
  async installedPacks() {
    await this.prepare();
    const packs = [{ ...bundledPack, id: BUNDLED_ID, bundled: true }];
    for (const name of await FileSystem.readDirectoryAsync(PACKS_DIR)) {
      if (!name.endsWith('.json')) continue;
      try {
        const pack = JSON.parse(await FileSystem.readAsStringAsync(`${PACKS_DIR}${name}`));
        if (await exists(packFile(pack.id))) packs.push(pack);
      } catch (error) {
        // An interrupted download leaves a manifest without a usable pack
      }
    }
    return packs;
  },

  /** The pack in use, with ready-to-use MapLibre styles for it. */
  async activePack() {
    const packs = await this.installedPacks();
    const activeId = await SecureStore.getItemAsync(ACTIVE_KEY);
    const pack = packs.find((candidate) => candidate.id === activeId) || packs[0];
    const file = pack.bundled ? bundledFile() : packFile(pack.id);
    return {
      ...pack,
      styles: { light: styleFor(lightStyle, file), dark: styleFor(darkStyle, file) },
    };
  },

  async setActive(id) {
    if (id === BUNDLED_ID) await SecureStore.deleteItemAsync(ACTIVE_KEY);
    else await SecureStore.setItemAsync(ACTIVE_KEY, id);
    return this.activePack();
  },

  /** Packs the Mothership offers. Needs a route to the server. */
  async availablePacks() {
    const token = await SecureStore.getItemAsync('mothership_jwt');
    const serverUrl = await ServerConfig.getUrl();
    const response = await fetch(`${serverUrl}/api/maps`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Mothership returned HTTP ${response.status}`);
    return response.json();
  },

  /** Downloads a pack from the Mothership. onProgress gets a 0-1 fraction. */
  async download(pack, onProgress) {
    await this.prepare();
    const token = await SecureStore.getItemAsync('mothership_jwt');
    const serverUrl = await ServerConfig.getUrl();
    const partial = `${packFile(pack.id)}.part`;
    await FileSystem.deleteAsync(partial, { idempotent: true });

    const task = FileSystem.createDownloadResumable(
      `${serverUrl}/api/maps/${pack.id}/download`,
      partial,
      { headers: { Authorization: `Bearer ${token}` } },
      ({ totalBytesWritten }) => onProgress?.(pack.bytes ? Math.min(1, totalBytesWritten / pack.bytes) : 0)
    );
    const result = await task.downloadAsync();
    if (!result || result.status !== 200) {
      await FileSystem.deleteAsync(partial, { idempotent: true });
      throw new Error(`Download failed${result ? ` (HTTP ${result.status})` : ''}`);
    }
    // Only a complete file is moved into place
    await FileSystem.deleteAsync(packFile(pack.id), { idempotent: true });
    await FileSystem.moveAsync({ from: partial, to: packFile(pack.id) });
    await FileSystem.writeAsStringAsync(packManifest(pack.id), JSON.stringify(pack));
  },

  async remove(id) {
    if (id === BUNDLED_ID) return;
    if ((await SecureStore.getItemAsync(ACTIVE_KEY)) === id) await SecureStore.deleteItemAsync(ACTIVE_KEY);
    await FileSystem.deleteAsync(packFile(id), { idempotent: true });
    await FileSystem.deleteAsync(packManifest(id), { idempotent: true });
  },
};
