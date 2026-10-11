import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { HybridClock } from '../clock.js';
import { MeshStore } from '../store.js';
import { SyncEngine } from '../syncEngine.js';
import { MeshService } from '../meshService.js';
import { createSqlPersistence } from '../sqlPersistence.js';
import { LoopbackHub } from '../loopbackTransport.js';

console.log = () => {};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Node's built-in SQLite, behind the three functions sqlPersistence asks for
const nodeSqlite = (database = new DatabaseSync(':memory:')) => ({
  database,
  exec: async (sql) => { database.exec(sql); },
  run: async (sql, params) => { database.prepare(sql).run(...params); },
  all: async (sql, params) => database.prepare(sql).all(...params),
});

// Records what the store asks its storage to do
const spyPersistence = () => {
  const rows = new Map();
  const key = (record) => `${record.collection}|${record.id}`;
  const calls = { saved: [], removed: [] };
  return {
    rows,
    calls,
    load: async () => JSON.parse(JSON.stringify([...rows.values()])),
    saveRecords: async (records) => { calls.saved.push(records.map((record) => record.id)); for (const record of records) rows.set(key(record), JSON.parse(JSON.stringify(record))); },
    removeRecords: async (keys) => { calls.removed.push(keys.map((item) => item.id)); for (const item of keys) rows.delete(key(item)); },
  };
};

async function phone(hub, id, { now, retentionMs = null } = {}) {
  const store = new MeshStore({ nodeId: id, clock: new HybridClock(id, now), retentionMs });
  const engine = new SyncEngine({ store, transport: hub.createTransport(), nodeId: id, name: id });
  await engine.start();
  return { id, store, engine };
}

// Lets a test see which message types cross the pretend radio
const watch = (hub) => {
  const seen = [];
  const deliver = hub.deliver.bind(hub);
  hub.deliver = (from, to, text) => { seen.push(JSON.parse(text)); deliver(from, to, text); };
  return seen;
};

const marker = (id, extra = {}) => ({ _id: id, latitude: -41.29, longitude: 174.78, type: 'hazard', author_id: 'alpha', author_name: 'Responder Alpha', ...extra });

// ---------------------------------------------------------------- saving

test('a change saves only the record that changed, not the whole store', async () => {
  const persistence = spyPersistence();
  const store = new MeshStore({ nodeId: 'a', persistence });
  for (let i = 0; i < 50; i++) store.upsert('tactical_markers', marker(`m${i}`));
  await store.flush();
  persistence.calls.saved.length = 0;

  store.upsert('tactical_markers', { _id: 'm7', deleted: true });
  await store.flush();

  assert.deepEqual(persistence.calls.saved, [['m7']]);
});

test('records arriving together from a peer are saved as one batch', async () => {
  const persistence = spyPersistence();
  const store = new MeshStore({ nodeId: 'a', persistence });
  const other = new MeshStore({ nodeId: 'b' });
  for (let i = 0; i < 5; i++) other.upsert('tactical_markers', marker(`m${i}`));

  store.applyRemote(other.recordsNewerThan({ tactical_markers: {} }), 'b');
  await store.flush();

  assert.equal(persistence.calls.saved.length, 1);
  assert.equal(persistence.calls.saved[0].length, 5);
});

// ---------------------------------------------------------------- SQLite

test('sqlite: records survive, a newer copy replaces an older one, and removal removes', async () => {
  const db = nodeSqlite();
  const persistence = createSqlPersistence(db);
  const first = new MeshStore({ nodeId: 'a', persistence });
  first.upsert('tactical_markers', marker('m1', { note: 'Māori Pā Road — "closed"' }));
  first.upsert('tactical_markers', marker('m2'));
  first.upsert('tactical_markers', { _id: 'm1', type: 'infrastructure' });
  first.upsert('connectivity_logs', { _id: 'g1', latitude: -41.3, longitude: 174.8 });
  await first.flush();
  assert.equal(await persistence.count(), 3);

  const reopened = new MeshStore({ nodeId: 'a', persistence: createSqlPersistence(db) });
  await reopened.load();
  assert.equal(reopened.get('tactical_markers', 'm1').type, 'infrastructure');
  assert.equal(reopened.get('tactical_markers', 'm1').note, 'Māori Pā Road — "closed"');
  assert.deepEqual(reopened.digest(), first.digest());

  await persistence.removeRecords([{ collection: 'tactical_markers', id: 'm2' }]);
  assert.equal(await persistence.count(), 2);
});

test('sqlite: a batch that fails part-way leaves nothing behind', async () => {
  const db = nodeSqlite();
  let writes = 0;
  const flaky = { ...db, run: async (sql, params) => { if (sql.startsWith('INSERT') && ++writes === 3) throw new Error('disk full'); return db.run(sql, params); } };
  const persistence = createSqlPersistence(flaky);
  const records = ['a', 'b', 'c', 'd'].map((id) => ({ collection: 'tactical_markers', id, version: '000000000001000:00000:x', fields: { _id: id } }));

  await assert.rejects(() => persistence.saveRecords(records), /disk full/);
  assert.equal(await persistence.count(), 0);

  // and the database is still usable afterwards
  await persistence.saveRecords(records.slice(0, 2));
  assert.equal(await persistence.count(), 2);
});

test('sqlite: one unreadable row does not cost the rest of the store', async () => {
  const db = nodeSqlite();
  const persistence = createSqlPersistence(db);
  await persistence.saveRecords([{ collection: 'tactical_markers', id: 'good', version: '000000000001000:00000:x', fields: { _id: 'good' } }]);
  db.database.prepare('INSERT INTO mesh_records (collection, id, version, fields) VALUES (?, ?, ?, ?)').run('tactical_markers', 'bad', '000000000001000:00000:x', '{not json');

  const loaded = await persistence.load();
  assert.deepEqual(loaded.map((record) => record.id), ['good']);
});

test('sqlite: many writes at once are applied in order without interleaving', async () => {
  const persistence = createSqlPersistence(nodeSqlite());
  const store = new MeshStore({ nodeId: 'a', persistence });
  for (let i = 0; i < 200; i++) store.upsert('tactical_markers', marker(`m${i % 20}`, { round: i }));
  await store.flush();

  const reopened = new MeshStore({ nodeId: 'a', persistence });
  await reopened.load();
  assert.equal(reopened.size(), 20);
  assert.equal(reopened.get('tactical_markers', 'm19').round, 199);
});

// ---------------------------------------------------------------- cleaning up

test('compact: an old removed record is trimmed but still marks the removal', () => {
  let time = 100 * DAY;
  const store = new MeshStore({ nodeId: 'a', clock: new HybridClock('a', () => time), retentionMs: 90 * DAY });
  store.upsert('tactical_markers', marker('gone', { note: 'x'.repeat(500) }));
  store.upsert('tactical_markers', { _id: 'gone', deleted: true, deleted_by: 'alpha', deleted_at: time });
  store.upsert('tactical_markers', marker('live', { note: 'keep me' }));
  const version = store.digest().tactical_markers.gone;

  assert.deepEqual(store.compact(), { shrunk: 0, dropped: 0 }); // too recent
  time += 2 * DAY;
  assert.deepEqual(store.compact(), { shrunk: 1, dropped: 0 });

  const tombstone = store.get('tactical_markers', 'gone');
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.deleted_by, 'alpha');
  assert.equal(tombstone.note, undefined);
  assert.equal(tombstone.latitude, undefined);
  assert.equal(store.digest().tactical_markers.gone, version);
  assert.equal(store.get('tactical_markers', 'live').note, 'keep me');
  assert.deepEqual(store.compact(), { shrunk: 0, dropped: 0 }); // nothing left to do
});

test('compact: a trimmed removal still beats a stale copy from another phone', async () => {
  let time = 100 * DAY;
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', { now: () => time, retentionMs: 90 * DAY });
  const stale = await phone(hub, 'b', { now: () => time, retentionMs: 90 * DAY });
  a.store.upsert('tactical_markers', marker('m'));
  hub.link('a', 'b');
  await hub.idle();
  hub.unlink('a', 'b');

  a.store.upsert('tactical_markers', { _id: 'm', deleted: true });
  time += 3 * DAY;
  a.store.compact();

  hub.link('a', 'b');
  await hub.idle();
  assert.equal(a.store.get('tactical_markers', 'm').deleted, true);
  assert.equal(stale.store.get('tactical_markers', 'm').deleted, true);
});

test('compact: after the retention period a removed record is dropped, and cannot be brought back', async () => {
  let time = 100 * DAY;
  const hub = new LoopbackHub();
  const persistence = spyPersistence();
  const store = new MeshStore({ nodeId: 'a', clock: new HybridClock('a', () => time), retentionMs: 90 * DAY, persistence });
  const engine = new SyncEngine({ store, transport: hub.createTransport(), nodeId: 'a', name: 'a' });
  await engine.start();
  const away = await phone(hub, 'b', { now: () => time });

  store.upsert('tactical_markers', marker('old'));
  hub.link('a', 'b');
  await hub.idle();
  hub.unlink('a', 'b'); // b leaves, still holding the marker
  store.upsert('tactical_markers', { _id: 'old', deleted: true });

  time += 91 * DAY;
  assert.deepEqual(store.compact(), { shrunk: 0, dropped: 1 });
  await store.flush();
  assert.equal(store.get('tactical_markers', 'old'), null);
  assert.deepEqual(persistence.calls.removed, [['old']]);
  assert.ok(![...persistence.rows.keys()].includes('tactical_markers|old'));

  // b comes back after three months with its old copy
  hub.link('a', 'b');
  await hub.idle();
  assert.equal(store.get('tactical_markers', 'old'), null);
});

test('compact: recent records from a returning phone are still accepted', async () => {
  let time = 100 * DAY;
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', { now: () => time, retentionMs: 90 * DAY });
  const b = await phone(hub, 'b', { now: () => time });
  b.store.upsert('tactical_markers', marker('last-week'));
  time += 7 * DAY;

  hub.link('a', 'b');
  await hub.idle();
  assert.ok(a.store.get('tactical_markers', 'last-week'));
});

test('compact: with no retention period nothing is ever dropped', () => {
  let time = 100 * DAY;
  const store = new MeshStore({ nodeId: 'a', clock: new HybridClock('a', () => time) });
  store.upsert('tactical_markers', marker('m'));
  store.upsert('tactical_markers', { _id: 'm', deleted: true });
  time += 5000 * DAY;
  assert.equal(store.compact().dropped, 0);
  assert.equal(store.get('tactical_markers', 'm').deleted, true);
});

// ---------------------------------------------------------------- cheaper reconnects

test('summary: the same records give the same fingerprint whatever order they arrived in', () => {
  const a = new MeshStore({ nodeId: 'a' });
  for (let i = 0; i < 30; i++) a.upsert('tactical_markers', marker(`m${i}`));
  const records = a.recordsNewerThan({ tactical_markers: {} });
  const b = new MeshStore({ nodeId: 'b' });
  b.applyRemote([...records].reverse(), 'a');

  assert.deepEqual(b.summary(), a.summary());
  a.upsert('tactical_markers', { _id: 'm3', deleted: true });
  assert.notDeepEqual(b.summary(), a.summary());
});

test('phones already in step exchange fingerprints only, however many records they hold', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  for (let i = 0; i < 300; i++) a.store.upsert('tactical_markers', marker(`m${i}`));
  hub.link('a', 'b');
  await hub.idle();
  assert.equal(b.store.size(), 300);
  hub.unlink('a', 'b');

  const seen = watch(hub);
  hub.link('a', 'b'); // they meet again with nothing changed
  await hub.idle();

  assert.deepEqual(seen.map((message) => message.t).sort(), ['hello', 'hello', 'summary', 'summary']);
  assert.ok(seen.every((message) => JSON.stringify(message).length < 200));
});

test('only the collection that differs is listed in full', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  for (let i = 0; i < 40; i++) a.store.upsert('tactical_markers', marker(`m${i}`));
  a.store.upsert('connectivity_logs', { _id: 'g1', latitude: -41.3, longitude: 174.8 });
  hub.link('a', 'b');
  await hub.idle();
  hub.unlink('a', 'b');

  b.store.upsert('connectivity_logs', { _id: 'g2', latitude: -41.31, longitude: 174.81 });
  const seen = watch(hub);
  hub.link('a', 'b');
  await hub.idle();

  const digests = seen.filter((message) => message.t === 'digest');
  assert.ok(digests.length > 0);
  assert.ok(digests.every((message) => Object.keys(message.d).join() === 'connectivity_logs'));
  assert.ok(a.store.get('connectivity_logs', 'g2'));
});

test('a collection only one phone has is still sent across', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  a.store.upsert('quake_feed', { _id: 'geonet', payload: '[]' });

  hub.link('a', 'b');
  await hub.idle();
  assert.ok(b.store.get('quake_feed', 'geonet'));
});

// ---------------------------------------------------------------- the service

test('service: opening the app tidies old removed records', async () => {
  let time = 100 * DAY;
  const hub = new LoopbackHub();
  const persistence = createSqlPersistence(nodeSqlite());
  const make = () => new MeshService({
    createTransport: () => hub.createTransport(),
    getNodeId: async () => 'node-a',
    persistence,
    retentionMs: 90 * DAY,
    now: () => time,
  });
  const alpha = { id: 'alpha', name: 'Responder Alpha' };

  const first = make();
  await first.init('Responder Alpha');
  await first.saveMarker({ id: 'kept', latitude: -41.29, longitude: 174.78, type: 'hazard', timestamp: time }, alpha);
  await first.saveMarker({ id: 'removed', latitude: -41.29, longitude: 174.78, type: 'hazard', timestamp: time }, alpha);
  await first.removeMarker('alpha-removed', alpha);
  await first.shutdown();
  assert.equal(await persistence.count(), 2);

  time += 91 * DAY;
  const later = make();
  await later.init('Responder Alpha');
  await later.shutdown();

  assert.equal(await persistence.count(), 1);
  const reopened = make();
  await reopened.init('Responder Alpha');
  assert.deepEqual((await reopened.getAllMarkerDocs()).map((doc) => doc._id), ['alpha-kept']);
});
