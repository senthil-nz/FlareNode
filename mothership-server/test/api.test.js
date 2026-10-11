const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ed25519 } = require('@noble/curves/ed25519');

/**
 * End-to-end tests for the Mothership API.
 *
 * They start the real server on a spare port against a throwaway SQLite file,
 * seed the demo responders, and talk to it over HTTP like a phone or the
 * dashboard would. Nothing touches the real database or .env.
 */

const ROOT = path.join(__dirname, '..');
const PORT = String(4100 + Math.floor(Math.random() * 800));
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'test-password-not-real';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mothership-test-'));
const env = {
  ...process.env,
  PORT,
  SQLITE_PATH: path.join(directory, 'test.sqlite'),
  JWT_SECRET: 'test-jwt-secret',
  VALIDATOR_API_KEY: 'test-validator-key',
  SEED_PASSWORD: PASSWORD,
  DATABASE_URL: '',
};

let server;
let mesh; // the app's own identity code, to check the server stays compatible with it
let admin;
let alpha;
let bravo;

const call = async (method, route, { token, body, headers = {} } = {}) => {
  const response = await fetch(BASE + route, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) { /* not JSON (CSV export) */ }
  return { status: response.status, json, text };
};

const login = async (id, password = PASSWORD) => (await call('POST', '/api/auth/login', { body: { author_id: id, password } }));
const markerIds = async () => (await call('GET', '/api/dashboard', { token: admin })).json.markers.map((marker) => marker.id).sort();
const marker = (id, extra = {}) => ({ _id: id, latitude: -41.29, longitude: 174.78, type: 'hazard', timestamp: 1000, author_id: 'alpha', author_name: 'Responder Alpha', ...extra });

before(async () => {
  const seeded = spawnSync(process.execPath, ['seed.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.match(seeded.stdout, /Seed successful/, seeded.stdout + seeded.stderr);

  server = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15000);
    const watch = (chunk) => {
      output += chunk;
      if (output.includes('running on port')) { clearTimeout(timer); resolve(); }
    };
    server.stdout.on('data', watch);
    server.stderr.on('data', watch);
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${output}`)); });
  });

  mesh = await import('../../src/mesh/identity.js');
  admin = (await login('admin')).json.token;
  alpha = (await login('alpha')).json.token;
  bravo = (await login('bravo')).json.token;
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  // Windows releases the database file a moment after the process ends
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('login: roles are issued, and wrong passwords are refused', async () => {
  const asAdmin = await login('admin');
  assert.equal(asAdmin.status, 200);
  assert.deepEqual(asAdmin.json.user, { id: 'admin', name: 'Super User', role: 'admin' });
  assert.equal((await login('alpha')).json.user.role, 'responder');
  assert.equal((await login('alpha', 'wrong')).status, 401);
  assert.equal((await login('nobody')).status, 401);
});

test('every data endpoint needs a valid token', async () => {
  for (const route of ['/api/dashboard', '/api/responders', '/api/maps', '/api/export/odk', '/api/export/geojson', '/api/export/gaps']) {
    assert.equal((await call('GET', route)).status, 401, route);
    assert.equal((await call('GET', route, { token: 'not-a-token' })).status, 403, route);
  }
  assert.equal((await call('POST', '/api/sync/markers', { body: [] })).status, 401);
});

test('responders: only admins can manage them, and passwords never leave the server', async () => {
  assert.equal((await call('GET', '/api/responders', { token: alpha })).status, 403);
  const list = await call('GET', '/api/responders', { token: admin });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((responder) => responder.id), ['admin', 'alpha', 'bravo']);
  assert.ok(list.json.every((responder) => !('password_hash' in responder)));
  assert.equal((await call('POST', '/api/responders', { token: alpha, body: { id: 'x1', name: 'X', password: 'long-enough-1' } })).status, 403);
});

test('responders: create, sign in, reset password, change own password, remove', async () => {
  const create = (body) => call('POST', '/api/responders', { token: admin, body });
  assert.equal((await create({ id: 'charlie', name: 'Responder Charlie', password: 'short' })).status, 400);
  assert.equal((await create({ id: 'bad id!', name: 'X', password: 'long-enough-1' })).status, 400);
  assert.equal((await create({ id: 'charlie', name: 'Responder Charlie', password: 'first-pass-123' })).status, 201);
  assert.equal((await create({ id: 'charlie', name: 'Again', password: 'first-pass-123' })).status, 409);

  const charlie = (await login('charlie', 'first-pass-123')).json.token;
  assert.ok(charlie);

  assert.equal((await call('PUT', '/api/responders/charlie', { token: admin, body: { password: 'second-pass-456' } })).status, 200);
  assert.equal((await login('charlie', 'first-pass-123')).status, 401);

  const change = (body) => call('POST', '/api/auth/password', { token: charlie, body });
  assert.equal((await change({ current_password: 'wrong', new_password: 'third-pass-789' })).status, 401);
  assert.equal((await change({ current_password: 'second-pass-456', new_password: 'short' })).status, 400);
  assert.equal((await change({ current_password: 'second-pass-456', new_password: 'third-pass-789' })).status, 200);
  assert.equal((await login('charlie', 'third-pass-789')).status, 200);

  assert.equal((await call('DELETE', '/api/responders/charlie', { token: admin })).status, 200);
  assert.equal((await login('charlie', 'third-pass-789')).status, 401);
  assert.equal((await call('DELETE', '/api/responders/charlie', { token: admin })).status, 404);
});

test('responders: an admin cannot lock themselves out', async () => {
  assert.equal((await call('DELETE', '/api/responders/admin', { token: admin })).status, 400);
  assert.equal((await call('PUT', '/api/responders/admin', { token: admin, body: { role: 'responder' } })).status, 400);
});

test('markers: a phone uploads them and the dashboard shows them', async () => {
  const sync = await call('POST', '/api/sync/markers', { token: alpha, body: [marker('t-sync-1'), marker('t-sync-2', { type: 'infrastructure' })] });
  assert.equal(sync.status, 200);
  const dashboard = (await call('GET', '/api/dashboard', { token: admin })).json;
  const stored = dashboard.markers.find((item) => item.id === 't-sync-1');
  assert.equal(stored.author_name, 'Responder Alpha');
  assert.equal(stored.latitude, -41.29);
  assert.ok(dashboard.uplinks.some((uplink) => uplink.id === 'alpha'));
  assert.equal((await call('POST', '/api/sync/markers', { token: alpha, body: { not: 'an array' } })).status, 400);
});

test('markers: only the author or an admin can remove one, whoever relays the removal', async () => {
  await call('POST', '/api/sync/markers', { token: alpha, body: [marker('t-rm-1'), marker('t-rm-2'), marker('t-rm-3')] });

  // bravo tries to remove alpha's marker
  await call('POST', '/api/sync/markers', { token: bravo, body: [marker('t-rm-1', { deleted: true, deleted_by: 'bravo' })] });
  assert.ok((await markerIds()).includes('t-rm-1'));

  // the author removes it, relayed by bravo's phone
  await call('POST', '/api/sync/markers', { token: bravo, body: [marker('t-rm-2', { deleted: true, deleted_by: 'alpha' })] });
  assert.ok(!(await markerIds()).includes('t-rm-2'));

  // an admin removes it, relayed by alpha's phone
  await call('POST', '/api/sync/markers', { token: alpha, body: [marker('t-rm-3', { deleted: true, deleted_by: 'admin' })] });
  assert.ok(!(await markerIds()).includes('t-rm-3'));
});

test('markers: a phone that missed a removal cannot bring the marker back', async () => {
  await call('POST', '/api/sync/markers', { token: alpha, body: [marker('t-stale')] });
  await call('POST', '/api/sync/markers', { token: alpha, body: [marker('t-stale', { deleted: true, deleted_by: 'alpha' })] });
  assert.ok(!(await markerIds()).includes('t-stale'));

  await call('POST', '/api/sync/markers', { token: bravo, body: [marker('t-stale')] }); // bravo still has the old copy
  assert.ok(!(await markerIds()).includes('t-stale'));
});

test('markers: a phone can fetch what the server holds, including what was removed', async () => {
  await call('POST', '/api/sync/markers', { token: alpha, body: [marker('t-pull-1'), marker('t-pull-2')] });
  await call('POST', '/api/sync/markers', { token: alpha, body: [marker('t-pull-2', { deleted: true, deleted_by: 'alpha' })] });

  assert.equal((await call('GET', '/api/sync/markers')).status, 401);
  const pulled = (await call('GET', '/api/sync/markers', { token: bravo })).json;
  const ids = pulled.markers.map((item) => item.id);
  assert.ok(ids.includes('t-pull-1'));
  assert.ok(!ids.includes('t-pull-2'));
  assert.ok(pulled.removed.includes('t-pull-2'));
  assert.equal(pulled.markers.find((item) => item.id === 't-pull-1').author_name, 'Responder Alpha');
});

// A phone's signing key, enrolled with the Mothership as the given responder
const enrol = async (token) => {
  const privateKey = new Uint8Array(crypto.randomBytes(32));
  const publicKey = Buffer.from(ed25519.getPublicKey(privateKey)).toString('base64');
  const response = await call('POST', '/api/mesh/enroll', { token, body: { key: publicKey } });
  return { privateKey, publicKey, response, ...response.json };
};

// A marker record as the app would sign and upload it
const signedMarker = (phone, id, version, extra = {}) => {
  const fields = { _id: id, latitude: -41.29, longitude: 174.78, type: 'hazard', timestamp: 1000, author_id: phone.certificate.id, author_name: phone.certificate.name, ...extra };
  const record = { collection: 'tactical_markers', id, version, fields };
  const auth = mesh.signRecord(ed25519, phone.privateKey, mesh.certificateId(phone.certificate), record);
  return { record: { ...record, auth }, upload: { ...fields, _mesh: { version, auth } } };
};

test('mesh: enrolling gives a certificate the app accepts, with the role from the database', async () => {
  const phone = await enrol(alpha);
  assert.equal(phone.response.status, 200);
  assert.equal(phone.certificate.id, 'alpha');
  assert.equal(phone.certificate.role, 'responder');
  assert.equal(phone.certificate.key, phone.publicKey);
  assert.equal(mesh.verifyCertificate(ed25519, phone.authorityKey, phone.certificate), true);
  assert.equal(mesh.verifyCertificate(ed25519, phone.authorityKey, { ...phone.certificate, role: 'admin' }), false);

  const boss = await enrol(admin);
  assert.equal(boss.certificate.role, 'admin');
  assert.equal(boss.authorityKey, phone.authorityKey); // one authority for everyone
});

test('mesh: enrolling needs sign-in and a real public key', async () => {
  const key = Buffer.from(ed25519.getPublicKey(new Uint8Array(crypto.randomBytes(32)))).toString('base64');
  assert.equal((await call('POST', '/api/mesh/enroll', { body: { key } })).status, 401);
  assert.equal((await call('POST', '/api/mesh/enroll', { token: alpha, body: { key: 'not-a-key' } })).status, 400);
  assert.equal((await call('POST', '/api/mesh/enroll', { token: alpha, body: {} })).status, 400);
});

test('mesh: signed markers are handed on with their signatures and the certificates to check them', async () => {
  const phone = await enrol(alpha);
  const marker1 = signedMarker(phone, 'alpha-signed-1', '000001000000000:00000:n1');
  await call('POST', '/api/sync/markers', { token: alpha, body: [marker1.upload] });

  const pulled = (await call('GET', '/api/sync/markers', { token: bravo })).json;
  const handed = pulled.records.find((record) => record.id === 'alpha-signed-1');
  assert.deepEqual(handed, marker1.record);

  // exactly what another phone would do with it
  const certificate = pulled.certificates.find((cert) => mesh.certificateId(cert) === handed.auth.k);
  assert.equal(mesh.verifyCertificate(ed25519, phone.authorityKey, certificate), true);
  assert.equal(mesh.verifyRecord(ed25519, certificate, handed), true);
  // and the dashboard still sees it as an ordinary marker
  assert.ok((await markerIds()).includes('alpha-signed-1'));
});

test('mesh: a signed removal is handed on too, and an older copy does not replace a newer one', async () => {
  const phone = await enrol(alpha);
  const older = signedMarker(phone, 'alpha-signed-2', '000001000000000:00000:n1', { type: 'hazard' });
  const newer = signedMarker(phone, 'alpha-signed-2', '000001000000500:00000:n1', { type: 'infrastructure', timestamp: 2000 });
  await call('POST', '/api/sync/markers', { token: alpha, body: [newer.upload] });
  await call('POST', '/api/sync/markers', { token: bravo, body: [older.upload] }); // a stale phone
  let pulled = (await call('GET', '/api/sync/markers', { token: bravo })).json;
  assert.equal(pulled.records.find((record) => record.id === 'alpha-signed-2').version, newer.record.version);

  const removal = signedMarker(phone, 'alpha-signed-2', '000001000000900:00000:n1', { type: 'infrastructure', timestamp: 2000, deleted: true, deleted_by: 'alpha' });
  await call('POST', '/api/sync/markers', { token: alpha, body: [removal.upload] });
  pulled = (await call('GET', '/api/sync/markers', { token: bravo })).json;
  assert.ok(!pulled.records.some((record) => record.id === 'alpha-signed-2'));
  const handed = pulled.removedRecords.find((record) => record.id === 'alpha-signed-2');
  assert.deepEqual(handed, removal.record);
  assert.equal(mesh.verifyRecord(ed25519, phone.certificate, handed), true);
});

test('dead zones: uploaded, shown, exported, and cleared ones stay cleared', async () => {
  const gap = { _id: 't-gap-1', latitude: -41.3, longitude: 174.8, timestamp: 2000 };
  await call('POST', '/api/sync/gaps', { token: alpha, body: [gap, { _id: 't-gap-zero', latitude: 0, longitude: 0, timestamp: 1 }] });
  let gaps = (await call('GET', '/api/dashboard', { token: admin })).json.gaps.map((item) => item.id);
  assert.ok(gaps.includes('t-gap-1'));
  assert.ok(!gaps.includes('t-gap-zero')); // old builds logged gaps with no position

  const exported = (await call('GET', '/api/export/gaps', { token: admin })).json;
  assert.equal(exported.type, 'FeatureCollection');
  assert.ok(exported.features.length >= 1);

  await call('POST', '/api/sync/gaps', { token: alpha, body: [{ ...gap, deleted: true }] });
  await call('POST', '/api/sync/gaps', { token: bravo, body: [gap] });
  gaps = (await call('GET', '/api/dashboard', { token: admin })).json.gaps.map((item) => item.id);
  assert.ok(!gaps.includes('t-gap-1'));
});

test('exports: CSV keeps columns intact when a name contains a comma', async () => {
  await call('POST', '/api/sync/markers', { token: alpha, body: [marker('t-csv', { author_name: 'Smith, Jane "JJ"' })] });
  const csv = (await call('GET', '/api/export/odk', { token: admin })).text;
  const line = csv.split('\n').find((row) => row.startsWith('t-csv,'));
  assert.ok(line.endsWith('"Smith, Jane ""JJ"""'), line);

  const geojson = (await call('GET', '/api/export/geojson', { token: admin })).json;
  assert.equal(geojson.type, 'FeatureCollection');
  assert.ok(geojson.features.some((feature) => feature.properties.id === 't-csv'));
});

test('map packs: listing needs sign-in and pack names cannot escape the folder', async () => {
  const list = await call('GET', '/api/maps', { token: alpha });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json));
  assert.equal((await call('GET', '/api/maps/no-such-pack/download', { token: alpha })).status, 404);
  assert.equal((await call('GET', '/api/maps/..%2F.env/download', { token: alpha })).status, 400);
});

test('validator feed: needs its API key', async () => {
  assert.equal((await call('GET', '/api/feed/validator')).status, 403);
  assert.equal((await call('GET', '/api/feed/validator', { headers: { 'x-api-key': 'wrong' } })).status, 403);
  const feed = await call('GET', '/api/feed/validator', { headers: { 'x-api-key': 'test-validator-key' } });
  assert.equal(feed.status, 200);
  assert.equal(feed.json.type, 'FeatureCollection');
});

test('the dashboard page is served', async () => {
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /FlareNode Mothership/);
});
