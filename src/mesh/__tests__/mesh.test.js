import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HybridClock, compareVersions, versionMillis } from '../clock.js';
import { MeshStore } from '../store.js';
import { SyncEngine, PROTOCOL_VERSION } from '../syncEngine.js';
import { LoopbackHub } from '../loopbackTransport.js';

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

// A phone: a store plus a sync engine on a shared pretend radio
async function phone(hub, id, { now, persistence } = {}) {
  const store = new MeshStore({ nodeId: id, clock: new HybridClock(id, now), persistence });
  await store.load();
  const engine = new SyncEngine({ store, transport: hub.createTransport(), nodeId: id, name: `Responder ${id}` });
  await engine.start();
  return { id, store, engine };
}

const ids = (node, collection = 'tactical_markers') => node.store.all(collection).map((doc) => doc._id).sort();
const marker = (id, extra = {}) => ({ _id: id, latitude: -41.29, longitude: 174.78, type: 'hazard', ...extra });

test('clock: versions always increase, even within one millisecond', () => {
  const clock = new HybridClock('a', () => 1000);
  const first = clock.tick();
  const second = clock.tick();
  const third = clock.tick();
  assert.ok(compareVersions(first, second) < 0);
  assert.ok(compareVersions(second, third) < 0);
});

test('clock: a phone whose clock is behind still writes newer than what it has seen', () => {
  const ahead = new HybridClock('ahead', () => 1_000 + 30 * 60 * 1000); // half an hour ahead
  const behind = new HybridClock('behind', () => 1_000);
  const seen = ahead.tick();
  behind.observe(seen);
  assert.ok(compareVersions(behind.tick(), seen) > 0);
});

test('clock: a version far in the future does not drag this phone along with it', () => {
  const clock = new HybridClock('here', () => 1_000_000);
  clock.observe(`${String(1_000_000 + 90 * 24 * 60 * 60 * 1000).padStart(15, '0')}:00000:far`);
  assert.equal(versionMillis(clock.tick()), 1_000_000);
});

test('store: a change to a record is newer than it, even when the record came from a clock far ahead', () => {
  const store = new MeshStore({ nodeId: 'here', clock: new HybridClock('here', () => 1_000_000) });
  const future = { collection: 'tactical_markers', id: 'm1', version: `${String(9_000_000_000).padStart(15, '0')}:00000:far`, fields: { _id: 'm1', type: 'hazard' } };
  store.applyRemote([future], 'peer');
  store.upsert('tactical_markers', { _id: 'm1', deleted: true });
  assert.equal(store.get('tactical_markers', 'm1').deleted, true);

  // ...and another phone holding the future copy takes the change
  const other = new MeshStore({ nodeId: 'other' });
  other.applyRemote([future], 'peer');
  other.applyRemote(store.recordsNewerThan(other.digest(['tactical_markers'])), 'peer');
  assert.equal(other.get('tactical_markers', 'm1').deleted, true);
});

test('store: upsert merges fields, so flagging a marker deleted keeps the rest', () => {
  const store = new MeshStore({ nodeId: 'a' });
  store.upsert('tactical_markers', marker('m1', { author_id: 'alpha' }));
  store.upsert('tactical_markers', { _id: 'm1', deleted: true, deleted_by: 'alpha' });
  const doc = store.get('tactical_markers', 'm1');
  assert.equal(doc.deleted, true);
  assert.equal(doc.type, 'hazard');
  assert.equal(doc.author_id, 'alpha');
});

test('store: observers get the collection immediately and on each change', () => {
  const store = new MeshStore({ nodeId: 'a' });
  const seen = [];
  const stop = store.observe('tactical_markers', (docs) => seen.push(docs.length));
  store.upsert('tactical_markers', marker('m1'));
  store.upsert('connectivity_logs', { _id: 'g1' }); // another collection: no callback
  store.upsert('tactical_markers', marker('m2'));
  stop();
  store.upsert('tactical_markers', marker('m3'));
  assert.deepEqual(seen, [0, 1, 2]);
});

test('two phones exchange what each wrote before they met', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  a.store.upsert('tactical_markers', marker('from-a'));
  b.store.upsert('tactical_markers', marker('from-b'));

  hub.link('a', 'b');
  await hub.idle();

  assert.deepEqual(ids(a), ['from-a', 'from-b']);
  assert.deepEqual(ids(b), ['from-a', 'from-b']);
});

test('a write on one phone reaches a connected phone straight away', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  hub.link('a', 'b');
  await hub.idle();

  a.store.upsert('tactical_markers', marker('live'));
  await hub.idle();

  assert.deepEqual(ids(b), ['live']);
});

test('multi-hop: A reaches C through B, and a removal travels back', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  const c = await phone(hub, 'c');
  hub.link('a', 'b');
  hub.link('b', 'c'); // a and c are never in range of each other
  await hub.idle();

  a.store.upsert('tactical_markers', marker('far', { author_id: 'a' }));
  await hub.idle();
  assert.deepEqual(ids(c), ['far']);

  c.store.upsert('tactical_markers', { _id: 'far', deleted: true, deleted_by: 'c' });
  await hub.idle();
  assert.equal(a.store.get('tactical_markers', 'far').deleted, true);
  assert.equal(a.store.get('tactical_markers', 'far').author_id, 'a');
});

test('a phone that was out of range catches up when it comes back', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  hub.link('a', 'b');
  await hub.idle();

  hub.unlink('a', 'b');
  a.store.upsert('tactical_markers', marker('while-apart-1'));
  a.store.upsert('tactical_markers', marker('while-apart-2'));
  b.store.upsert('connectivity_logs', { _id: 'gap-1', latitude: -41.3, longitude: 174.8 });
  await hub.idle();
  assert.deepEqual(ids(b), []);

  hub.link('a', 'b');
  await hub.idle();
  assert.deepEqual(ids(b), ['while-apart-1', 'while-apart-2']);
  assert.deepEqual(ids(a, 'connectivity_logs'), ['gap-1']);
});

test('conflict: both phones change the same record apart; the later write wins everywhere', async () => {
  const hub = new LoopbackHub();
  let time = 1000;
  const a = await phone(hub, 'a', { now: () => time });
  const b = await phone(hub, 'b', { now: () => time });

  a.store.upsert('tactical_markers', marker('m', { type: 'hazard' }));
  time = 2000;
  b.store.upsert('tactical_markers', marker('m', { type: 'infrastructure' }));

  hub.link('a', 'b');
  await hub.idle();

  assert.equal(a.store.get('tactical_markers', 'm').type, 'infrastructure');
  assert.equal(b.store.get('tactical_markers', 'm').type, 'infrastructure');
});

test('conflict in the same millisecond is still settled the same way on both phones', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', { now: () => 1000 });
  const b = await phone(hub, 'b', { now: () => 1000 });
  a.store.upsert('tactical_markers', marker('m', { type: 'hazard' }));
  b.store.upsert('tactical_markers', marker('m', { type: 'responder' }));

  hub.link('a', 'b');
  await hub.idle();

  assert.equal(a.store.get('tactical_markers', 'm').type, b.store.get('tactical_markers', 'm').type);
});

test('a stale phone cannot bring back a removed marker', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  const c = await phone(hub, 'c');
  a.store.upsert('tactical_markers', marker('m'));
  hub.link('a', 'b');
  hub.link('a', 'c');
  await hub.idle();

  // c goes out of range, then the marker is removed
  hub.unlink('a', 'c');
  b.store.upsert('tactical_markers', { _id: 'm', deleted: true });
  await hub.idle();

  // c returns still holding the old copy, and meets only b
  hub.link('b', 'c');
  await hub.idle();

  for (const node of [a, b, c]) assert.equal(node.store.get('tactical_markers', 'm').deleted, true);
});

test('the mesh goes quiet once everyone agrees (no records circulating forever)', async () => {
  const hub = new LoopbackHub();
  const nodes = [];
  for (const id of ['a', 'b', 'c', 'd']) nodes.push(await phone(hub, id));
  // A ring: every phone has two neighbours, so there is a loop
  hub.link('a', 'b'); hub.link('b', 'c'); hub.link('c', 'd'); hub.link('d', 'a');
  await hub.idle();

  nodes[0].store.upsert('tactical_markers', marker('ring'));
  await hub.idle();
  const afterSync = hub.delivered;

  for (const node of nodes) assert.deepEqual(ids(node), ['ring']);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await hub.idle();
  assert.equal(hub.delivered, afterSync);
});

test('records larger than the radio allows are split and reassembled', async () => {
  const hub = new LoopbackHub({ maxPayloadBytes: 300 });
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  const note = 'Bridge down at Māori Pā Road — "do not cross" \\ detour via SH1. '.repeat(40);
  a.store.upsert('tactical_markers', marker('big', { note }));
  for (let i = 0; i < 25; i++) a.store.upsert('tactical_markers', marker(`m${i}`));

  hub.link('a', 'b');
  await hub.idle();

  assert.equal(b.store.all('tactical_markers').length, 26);
  assert.equal(b.store.get('tactical_markers', 'big').note, note);
});

test('peers: the list follows connections and carries the responder name', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  const seen = [];
  a.engine.observePeers((peers) => seen.push(peers.map((peer) => peer.name)));

  hub.link('a', 'b');
  await hub.idle();
  hub.unlink('a', 'b');

  assert.deepEqual(seen, [[], ['Responder b'], []]);
});

test('a peer on a different protocol version is ignored, not misread', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const stranger = hub.createTransport();
  await stranger.start({ nodeId: 'x', name: 'Future build' });
  let flagged = null;
  a.engine.on('incompatiblePeer', (info) => { flagged = info; });

  hub.link('a', 'x');
  await stranger.send('a', JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 1 }));
  await stranger.send('a', JSON.stringify({ t: 'docs', r: [{ collection: 'tactical_markers', id: 'evil', version: '999999999999999:00000:x', fields: {} }] }));
  await hub.idle();

  assert.deepEqual(flagged, { id: 'x', version: PROTOCOL_VERSION + 1 });
  assert.deepEqual(ids(a), []);
});

test('garbage and malformed records from a peer are dropped without harm', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const stranger = hub.createTransport();
  await stranger.start({ nodeId: 'x', name: 'Noisy' });
  hub.link('a', 'x');

  await stranger.send('a', 'not json at all');
  await stranger.send('a', JSON.stringify({ t: 'docs', r: [null, { id: 'no-collection' }, { collection: 'tactical_markers', id: 'ok', version: '000000000001000:00000:x', fields: { type: 'hazard' } }] }));
  await stranger.send('a', JSON.stringify({ t: 'frag', id: 1, i: 5, n: 2, d: 'bad index' }));
  await hub.idle();

  assert.deepEqual(ids(a), ['ok']);
});

test('persistence: records survive a restart and keep their versions', async () => {
  const persistence = memoryPersistence();
  const hub = new LoopbackHub();

  const first = await phone(hub, 'a', { persistence });
  first.store.upsert('tactical_markers', marker('kept'));
  await first.store.flush();
  const version = first.store.digest().tactical_markers.kept;
  await first.engine.stop();

  const restarted = await phone(hub, 'a', { persistence });
  assert.deepEqual(ids(restarted), ['kept']);
  assert.equal(restarted.store.digest().tactical_markers.kept, version);
  // and the clock carries on from where it was
  restarted.store.upsert('tactical_markers', marker('later'));
  assert.ok(compareVersions(restarted.store.digest().tactical_markers.later, version) > 0);
});
