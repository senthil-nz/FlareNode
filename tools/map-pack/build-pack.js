#!/usr/bin/env node
/**
 * Builds an offline map pack for FlareNode.
 *
 * Reads vector tiles for a bounding box out of a Protomaps daily build (which
 * is published so regions can be extracted, unlike the OpenStreetMap tile
 * servers) and writes them to an MBTiles file that MapLibre reads directly.
 *
 *   node build-pack.js --id wellington-city --name "Wellington city" \
 *        --bbox 174.70,-41.36,174.90,-41.20 --bundle
 *
 *   --bundle   write to assets/maps/default.* (shipped inside the app)
 *   otherwise  write to mothership-server/maps/<id>.* (downloadable by phones)
 *   --maxzoom  street-level zoom to include, default 15
 *   --build    Protomaps build date (YYYYMMDD), default: the latest
 *   --assets   also refresh the shared styles and fonts in assets/maps
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sqlite3 = require('sqlite3');
const { PMTiles, FetchSource } = require('pmtiles');
const { layers, namedFlavor } = require('@protomaps/basemaps');

const ROOT = path.join(__dirname, '..', '..');
const ASSETS_DIR = path.join(ROOT, 'assets', 'maps');
const SERVER_DIR = path.join(ROOT, 'mothership-server', 'maps');
const BUILDS_URL = 'https://build-metadata.protomaps.dev/builds.json';
const FONTS_URL = 'https://protomaps.github.io/basemaps-assets/fonts';
const FONT_STACKS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
// Basic Latin, Latin Extended-A (Maori macrons), general punctuation
const FONT_RANGES = ['0-255', '256-511', '8192-8447'];
const ATTRIBUTION = '© OpenStreetMap contributors · Protomaps';
const CONCURRENCY = 8;

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[key] = true;
  else { args[key] = next; i++; }
}

const fail = (message) => { console.error(`ERROR: ${message}`); process.exit(1); };

const lngToX = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const expand = ([w, s, e, n], by) => [clamp(w - by, -180, 180), clamp(s - by, -85, 85), clamp(e + by, -180, 180), clamp(n + by, -85, 85)];

function tilesFor(bbox, minZoom, maxZoom) {
  const [w, s, e, n] = bbox;
  const out = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const max = 2 ** z - 1;
    const x0 = clamp(lngToX(w, z), 0, max), x1 = clamp(lngToX(e, z), 0, max);
    const y0 = clamp(latToY(n, z), 0, max), y1 = clamp(latToY(s, z), 0, max);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}

const run = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));

// Short network blips are common on long downloads; try a few times
async function fetchRetry(url, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
}

async function latestBuild() {
  const builds = await (await fetchRetry(BUILDS_URL)).json();
  return builds[builds.length - 1].key.replace('.pmtiles', '');
}

// The basemap style, minus icons (no sprite sheet is bundled). The tile and
// font locations are filled in on the phone, where the files' paths are known.
function writeStyles() {
  for (const flavor of ['light', 'dark']) {
    const styleLayers = layers('protomaps', namedFlavor(flavor), { lang: 'en' })
      .filter((layer) => !(layer.layout && layer.layout['icon-image'] && !layer.layout['text-field']))
      .map((layer) => {
        const withoutIcons = (props) => props && Object.fromEntries(Object.entries(props).filter(([key]) => !key.startsWith('icon-')));
        const cleaned = { ...layer };
        if (layer.layout) cleaned.layout = withoutIcons(layer.layout);
        if (layer.paint) cleaned.paint = withoutIcons(layer.paint);
        return cleaned;
      });
    const style = {
      version: 8,
      name: `FlareNode offline ${flavor}`,
      glyphs: '__GLYPHS__',
      sources: { protomaps: { type: 'vector', url: '__TILES__', attribution: ATTRIBUTION } },
      layers: styleLayers,
    };
    fs.writeFileSync(path.join(ASSETS_DIR, `style-${flavor}.json`), JSON.stringify(style));
  }
  console.log('styles written (light, dark)');
}

async function writeFonts() {
  const dir = path.join(ASSETS_DIR, 'fonts');
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const stack of FONT_STACKS) {
    for (const range of FONT_RANGES) {
      const response = await fetchRetry(`${FONTS_URL}/${encodeURIComponent(stack)}/${range}.pbf`);
      if (!response.ok) fail(`font ${stack} ${range}: HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      // Android resource names allow only lowercase letters, digits and underscores
      const name = `${stack.toLowerCase().replace(/ /g, '_')}_${range.replace('-', '_')}.pbf`;
      fs.writeFileSync(path.join(dir, name), data);
      bytes += data.length;
    }
  }
  console.log(`fonts written (${FONT_STACKS.length * FONT_RANGES.length} files, ${(bytes / 1e6).toFixed(1)} MB)`);
}

async function main() {
  if (args.assets) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    writeStyles();
    await writeFonts();
    if (!args.bbox) return;
  }

  if (!args.id || !/^[a-z0-9-]{2,40}$/.test(args.id)) fail('--id is required (lowercase letters, digits, dashes)');
  if (!args.bbox) fail('--bbox west,south,east,north is required');
  const bbox = String(args.bbox).split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(Number.isNaN) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) fail('--bbox must be west,south,east,north');
  const maxZoom = clamp(parseInt(args.maxzoom || '15', 10), 10, 15);
  const name = args.name || args.id;
  const build = args.build || (await latestBuild());

  // Detail falls off with distance: the world and the surrounding country at
  // low zoom for context, the area around the pack at mid zoom, and street
  // level only inside the requested box.
  const wanted = new Map();
  for (const tile of [
    ...tilesFor([-180, -85, 180, 85], 0, 4),
    ...tilesFor(expand(bbox, 8), 5, 7),
    ...tilesFor(expand(bbox, 2), 8, 9),
    ...tilesFor(expand(bbox, 0.5), 10, 12),
    ...tilesFor(bbox, 13, maxZoom),
  ]) wanted.set(tile.join('/'), tile);
  const tiles = [...wanted.values()];

  const outDir = args.bundle ? ASSETS_DIR : SERVER_DIR;
  const base = args.bundle ? 'default' : args.id;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${base}.mbtiles`);
  if (fs.existsSync(file)) fs.unlinkSync(file);

  console.log(`pack "${name}" from Protomaps build ${build}: ${tiles.length} tiles, zoom 0-${maxZoom}`);
  const archive = new PMTiles(new FetchSource(`https://build.protomaps.com/${build}.pmtiles`));
  const metadata = await archive.getMetadata();

  const db = new sqlite3.Database(file);
  await run(db, 'CREATE TABLE metadata (name TEXT, value TEXT)');
  await run(db, 'CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)');
  await run(db, 'CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)');
  await run(db, 'BEGIN');

  let done = 0, stored = 0, next = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const [z, x, y] = tiles[next++];
      const tile = await archive.getZxy(z, x, y);
      if (tile && tile.data && tile.data.byteLength > 0) {
        // MBTiles rows are numbered from the bottom (TMS), vector tiles are gzipped
        await run(db, 'INSERT INTO tiles VALUES (?, ?, ?, ?)', [z, x, 2 ** z - 1 - y, zlib.gzipSync(Buffer.from(tile.data))]);
        stored++;
      }
      if (++done % 200 === 0) console.log(`  ${done}/${tiles.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const meta = {
    name,
    format: 'pbf',
    type: 'baselayer',
    version: build,
    minzoom: '0',
    maxzoom: String(maxZoom),
    bounds: '-180,-85,180,85',
    center: `${center[0]},${center[1]},12`,
    attribution: ATTRIBUTION,
    json: JSON.stringify({ vector_layers: metadata.vector_layers || [] }),
  };
  for (const [key, value] of Object.entries(meta)) await run(db, 'INSERT INTO metadata VALUES (?, ?)', [key, value]);
  await run(db, 'COMMIT');
  await new Promise((resolve) => db.close(resolve));

  const bytes = fs.statSync(file).size;
  const manifest = { id: args.id, name, bbox, center, zoom: 12, maxZoom, tiles: stored, bytes, build, attribution: ATTRIBUTION };
  fs.writeFileSync(path.join(outDir, `${base}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`done: ${stored} tiles, ${(bytes / 1e6).toFixed(1)} MB -> ${path.relative(ROOT, file)}`);
}

main().catch((error) => fail(error.stack || error.message));
