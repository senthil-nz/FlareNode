import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { deriveMeshKey, createCipher } from '../cipher.js';
import { MeshStore } from '../store.js';
import { SyncEngine } from '../syncEngine.js';
import { LoopbackHub } from '../loopbackTransport.js';

/**
 * Radios lose messages, most often right as a connection forms. These tests
 * reproduce a fault seen on real phones: the first messages of a new
 * connection went missing, one phone never learned what it lacked, and only
 * markers dropped afterwards came through.
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cipherFor = async (token) => createCipher(await deriveMeshKey(token, { iterations: 50 }), (count) => new Uint8Array(randomBytes(count)));

async function phone(hub, id, { cipher = null, earlyResyncMs = [20], resyncMs = 0 } = {}) {
  const store = new MeshStore({ nodeId: id });
  const engine = new SyncEngine({ store, transport: hub.createTransport(), nodeId: id, name: `Responder ${id}`, cipher, earlyResyncMs, resyncMs });
  await engine.start();
  return { id, store, engine };
}

const ids = (node) => node.store.all('tactical_markers').map((doc) => doc._id).sort();
const marker = (id) => ({ _id: id, latitude: -41.29, longitude: 174.78, type: 'hazard' });
const settle = async (hub, ms = 80) => { await hub.idle(); await wait(ms); await hub.idle(); };

test('the fault: with the greeting sent only once, a lost one leaves a phone behind', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', { earlyResyncMs: [] });
  const b = await phone(hub, 'b', { earlyResyncMs: [] });
  a.store.upsert('tactical_markers', marker('from-a'));
  b.store.upsert('tactical_markers', marker('from-b'));

  hub.loseNext('b', 2); // b misses a's hello and summary
  hub.link('a', 'b');
  await settle(hub);

  assert.deepEqual(ids(a), ['from-a', 'from-b']); // a caught up from b
  assert.deepEqual(ids(b), ['from-b']); // b never learned what it was missing

  // ...while a marker dropped afterwards does get through, as seen on the phones
  a.store.upsert('tactical_markers', marker('new'));
  await settle(hub);
  assert.deepEqual(ids(b), ['from-b', 'new']);
});

test('repeating the greeting shortly after connecting recovers from a lost one', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  a.store.upsert('tactical_markers', marker('from-a'));
  b.store.upsert('tactical_markers', marker('from-b'));

  hub.loseNext('b', 2);
  hub.link('a', 'b');
  await settle(hub);

  assert.deepEqual(ids(a), ['from-a', 'from-b']);
  assert.deepEqual(ids(b), ['from-a', 'from-b']);
});

test('both phones losing their first messages still end up in step', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a');
  const b = await phone(hub, 'b');
  for (let i = 0; i < 20; i++) a.store.upsert('tactical_markers', marker(`a${i}`));
  for (let i = 0; i < 20; i++) b.store.upsert('tactical_markers', marker(`b${i}`));

  hub.loseNext('a', 2);
  hub.loseNext('b', 2);
  hub.link('a', 'b');
  await settle(hub);

  assert.equal(a.store.size(), 40);
  assert.equal(b.store.size(), 40);
});

test('the steady repeat catches a loss that happens later in a connection', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', { earlyResyncMs: [], resyncMs: 30 });
  const b = await phone(hub, 'b', { earlyResyncMs: [], resyncMs: 30 });
  hub.link('a', 'b');
  await hub.idle();

  hub.loseNext('b', 1); // the live update for this marker is lost
  a.store.upsert('tactical_markers', marker('lost-in-flight'));
  await hub.idle();
  assert.deepEqual(ids(b), []);

  await settle(hub, 120);
  assert.deepEqual(ids(b), ['lost-in-flight']);
  await a.engine.stop();
  await b.engine.stop();
});

test('sealed mesh: a lost greeting no longer leaves one phone not counting the other as a peer', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', { cipher: await cipherFor('OP-2026-S1') });
  const b = await phone(hub, 'b', { cipher: await cipherFor('OP-2026-S1') });
  // Nothing differs, so after the greeting neither phone has anything to send
  hub.loseNext('b', 2);
  hub.link('a', 'b');
  await hub.idle();
  assert.equal(a.engine.connectedPeers().length, 1);
  assert.equal(b.engine.connectedPeers().length, 0); // b has heard nothing it can open yet

  await settle(hub);
  assert.equal(b.engine.connectedPeers().length, 1);
});

test('repeating the greeting to a phone already in step sends no records', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', { earlyResyncMs: [10, 25] });
  const b = await phone(hub, 'b', { earlyResyncMs: [10, 25] });
  for (let i = 0; i < 50; i++) a.store.upsert('tactical_markers', marker(`m${i}`));
  hub.link('a', 'b');
  await hub.idle();
  assert.equal(b.store.size(), 50);

  const types = [];
  const deliver = hub.deliver.bind(hub);
  hub.deliver = (from, to, text) => { types.push(JSON.parse(text).t); deliver(from, to, text); };
  await settle(hub);

  assert.ok(types.length > 0);
  assert.ok(types.every((type) => type === 'hello' || type === 'summary'), types.join());
});

test('stopping the engine cancels its repeats', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', { earlyResyncMs: [20], resyncMs: 20 });
  const b = await phone(hub, 'b', { earlyResyncMs: [20], resyncMs: 20 });
  hub.link('a', 'b');
  await hub.idle();
  await a.engine.stop();
  await b.engine.stop();
  const before = hub.delivered;

  await wait(80);
  assert.equal(hub.delivered, before);
});
