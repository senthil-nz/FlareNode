import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeshService } from '../meshService.js';
import { LoopbackHub } from '../loopbackTransport.js';

// Keep the service's progress messages out of the test output
console.log = () => {};

const alpha = { id: 'alpha', name: 'Responder Alpha' };
const bravo = { id: 'bravo', name: 'Responder Bravo' };

// Stands in for the phone's storage: keeps what it is given, by collection and id
const memoryPersistence = () => {
  const rows = new Map();
  const key = (record) => `${record.collection}|${record.id}`;
  return {
    rows,
    load: async () => JSON.parse(JSON.stringify([...rows.values()])),
    saveRecords: async (records) => { for (const record of records) rows.set(key(record), JSON.parse(JSON.stringify(record))); },
    removeRecords: async (keys) => { for (const item of keys) rows.delete(key(item)); },
  };
};

// A phone running the app-facing service on the pretend radio
async function phone(hub, nodeId, user, { persistence = null, now } = {}) {
  const service = new MeshService({
    createTransport: () => hub.createTransport(),
    persistence,
    getNodeId: async () => nodeId,
    now,
  });
  assert.equal(await service.init(user.name), true);
  await service.startP2PSync('OP-TEST');
  return service;
}

const marker = (id, extra = {}) => ({ id, latitude: -41.29, longitude: 174.78, type: 'hazard', timestamp: 1000, ...extra });

test('a marker dropped on one phone appears on the other, with its author', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'node-a', alpha);
  const b = await phone(hub, 'node-b', bravo);
  hub.link('node-a', 'node-b');

  let seen = [];
  b.subscribeToMarkers((docs) => { seen = docs; });
  await a.saveMarker(marker('m1'), alpha);
  await hub.idle();

  assert.equal(seen.length, 1);
  assert.deepEqual(
    { id: seen[0]._id, type: seen[0].type, author: seen[0].author_name, lat: seen[0].latitude },
    { id: 'alpha-m1', type: 'hazard', author: 'Responder Alpha', lat: -41.29 }
  );
});

test('removing a marker hides it everywhere but keeps the record for the Mothership', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'node-a', alpha);
  const b = await phone(hub, 'node-b', bravo);
  hub.link('node-a', 'node-b');
  await a.saveMarker(marker('m1'), alpha);
  await hub.idle();

  await b.removeMarker('alpha-m1', bravo);
  await hub.idle();

  assert.deepEqual(await a.getTacticalMarkers(), []);
  const all = await a.getAllMarkerDocs();
  assert.equal(all.length, 1);
  assert.equal(all[0].deleted, true);
  assert.equal(all[0].deleted_by, 'bravo');
  assert.equal(all[0].author_id, 'alpha');
});

test('markers come back newest first', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'node-a', alpha);
  await a.saveMarker(marker('old', { timestamp: 100 }), alpha);
  await a.saveMarker(marker('new', { timestamp: 300 }), alpha);
  await a.saveMarker(marker('mid', { timestamp: 200 }), alpha);

  assert.deepEqual((await a.getTacticalMarkers()).map((doc) => doc._id), ['alpha-new', 'alpha-mid', 'alpha-old']);
});

test('peers are reported in the shape the map screen expects, by responder name', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'node-a', alpha);
  await phone(hub, 'node-b', bravo);
  const updates = [];
  a.observePeers((peers) => updates.push(peers));

  hub.link('node-a', 'node-b');
  await hub.idle();

  assert.deepEqual(updates[0], []);
  const [peer] = updates.at(-1);
  assert.equal(peer.deviceName, 'Responder Bravo');
  assert.equal(peer.peerKeyString, 'node-b');
  assert.equal(peer.connections[0].connectionType, 'loopback');
  assert.equal(a.getRemotePeers().length, 1);

  hub.unlink('node-a', 'node-b');
  assert.deepEqual(updates.at(-1), []);
});

test('dead zones are shared, can be cleared for everyone, and respect the time window', async () => {
  const hub = new LoopbackHub();
  let time = 10 * 60 * 60 * 1000; // 10 hours in
  const a = await phone(hub, 'node-a', alpha, { now: () => time });
  const b = await phone(hub, 'node-b', bravo, { now: () => time });
  hub.link('node-a', 'node-b');

  await a.logConnectivityGap(-41.3, 174.8, alpha);
  time += 5 * 60 * 60 * 1000;
  await a.logConnectivityGap(-41.31, 174.81, alpha);
  await hub.idle();

  let onB = [];
  b.subscribeToConnectivityLogs((logs) => { onB = logs; });
  assert.equal(onB.length, 2);
  assert.equal(onB[0].reporter_name, 'Responder Alpha');
  assert.ok(onB[0].timestamp > onB[1].timestamp);
  assert.equal((await b.getConnectivityLogs(1)).length, 1);
  assert.equal((await b.exportConnectivityLogsAsGeoJSON(24)).features.length, 2);

  await b.clearConnectivityLogs(onB);
  await hub.idle();
  const afterClear = await a.getConnectivityLogs(24);
  assert.equal(afterClear.length, 2);
  assert.ok(afterClear.every((log) => log.deleted));
  assert.equal((await a.exportConnectivityLogsAsGeoJSON(24)).features.length, 0);
});

test('the quake feed fetched by one phone reaches a phone with no internet', async () => {
  const hub = new LoopbackHub();
  const online = await phone(hub, 'node-a', alpha, { now: () => 5000 });
  const offline = await phone(hub, 'node-b', bravo);
  hub.link('node-a', 'node-b');

  let feed = null;
  offline.subscribeToQuakeFeed((value) => { feed = value; });
  assert.equal(feed, null);

  await online.saveQuakeFeed([{ id: 'q1', magnitude: 4.2, locality: '10 km north of Wellington' }]);
  await hub.idle();

  assert.equal(feed.fetchedAt, 5000);
  assert.equal(feed.quakes[0].magnitude, 4.2);
});

test('switching the mesh off stops updates; switching it on again catches up', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'node-a', alpha);
  const b = await phone(hub, 'node-b', bravo);
  hub.link('node-a', 'node-b');
  await hub.idle();

  await b.stopP2PSync();
  assert.deepEqual(b.getRemotePeers(), []);
  await a.saveMarker(marker('while-off'), alpha);
  await hub.idle();
  assert.deepEqual(await b.getTacticalMarkers(), []);

  await b.startP2PSync('OP-TEST');
  hub.link('node-a', 'node-b');
  await hub.idle();
  assert.deepEqual((await b.getTacticalMarkers()).map((doc) => doc._id), ['alpha-while-off']);
});

test('signing in as someone else changes the name other phones see', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'node-a', alpha);
  const b = await phone(hub, 'node-b', bravo);
  hub.link('node-a', 'node-b');
  await hub.idle();
  assert.equal(a.getRemotePeers()[0].deviceName, 'Responder Bravo');

  await b.init('Responder Charlie'); // the map screen calls init again after a new sign-in
  hub.link('node-a', 'node-b');
  await hub.idle();

  assert.equal(a.getRemotePeers()[0].deviceName, 'Responder Charlie');
});

test('subscriptions made before the mesh is ready start once it is', async () => {
  const hub = new LoopbackHub();
  const service = new MeshService({ createTransport: () => hub.createTransport(), getNodeId: async () => 'node-a' });
  let ready = false;
  service.onReady(() => { ready = true; });
  assert.equal(service.subscribeToMarkers(() => {}), null);
  assert.equal(ready, false);

  await service.init('Responder Alpha');
  assert.equal(ready, true);
  let immediate = false;
  service.onReady(() => { immediate = true; });
  assert.equal(immediate, true);
});

test('markers survive closing and reopening the app', async () => {
  const persistence = memoryPersistence();
  const hub = new LoopbackHub();

  const first = await phone(hub, 'node-a', alpha, { persistence });
  await first.saveMarker(marker('kept'), alpha);
  await first.shutdown();

  const reopened = await phone(hub, 'node-a', alpha, { persistence });
  assert.deepEqual((await reopened.getTacticalMarkers()).map((doc) => doc._id), ['alpha-kept']);
});

// Found on a slow phone: the mesh was asked to start twice within a few
// seconds, two copies ran, and every message was handled twice.
test('starting the mesh twice at once runs it once', async () => {
  const hub = new LoopbackHub();
  let transports = 0;
  const service = new MeshService({
    createTransport: () => { transports += 1; return hub.createTransport(); },
    getNodeId: async () => 'slow',
  });
  await service.init('Slow phone');
  await Promise.all([service.startP2PSync('OP-TEST'), service.startP2PSync('OP-TEST'), service.startP2PSync()]);
  assert.equal(transports, 1);

  // Stop and start asked for together still end in the order asked
  await Promise.all([service.stopP2PSync(), service.startP2PSync('OP-TEST')]);
  assert.equal(transports, 2);
  assert.ok(service.engine, 'running, because start was asked for last');
  await service.stopP2PSync();
});
