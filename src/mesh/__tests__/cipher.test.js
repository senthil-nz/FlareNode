import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { deriveMeshKey, createCipher } from '../cipher.js';
import { MeshStore } from '../store.js';
import { SyncEngine } from '../syncEngine.js';
import { MeshService } from '../meshService.js';
import { LoopbackHub } from '../loopbackTransport.js';

console.log = () => {};

const random = (count) => new Uint8Array(randomBytes(count));
// Few iterations keep the tests quick; the app uses the real number
const cipherFor = async (token) => createCipher(await deriveMeshKey(token, { iterations: 50 }), random);

async function phone(hub, id, token) {
  const store = new MeshStore({ nodeId: id });
  const engine = new SyncEngine({
    store,
    transport: hub.createTransport(),
    nodeId: id,
    name: `Responder ${id}`,
    cipher: token ? await cipherFor(token) : null,
  });
  await engine.start();
  return { id, store, engine };
}

const ids = (node) => node.store.all('tactical_markers').map((doc) => doc._id).sort();
const marker = (id, extra = {}) => ({ _id: id, latitude: -41.29, longitude: 174.78, type: 'hazard', ...extra });

test('the same token gives the same key on every phone; a different token does not', async () => {
  const first = await deriveMeshKey('OP-2026-S1', { iterations: 50 });
  const second = await deriveMeshKey('OP-2026-S1', { iterations: 50 });
  const other = await deriveMeshKey('OP-2026-S2', { iterations: 50 });
  assert.equal(first.length, 32);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);
  await assert.rejects(() => deriveMeshKey(''));
});

test('a sealed message opens to the original text, including non-English characters', async () => {
  const cipher = await cipherFor('OP-2026-S1');
  const text = JSON.stringify({ note: 'Slip at Māori Pā Road — 道路封鎖 🚧', n: 42 });
  const sealed = cipher.seal(text, { from: 'a', to: 'b' });

  assert.ok(!sealed.includes('Slip'));
  assert.equal(cipher.open(sealed, { from: 'a', to: 'b' }), text);
});

test('sealing the same text twice gives different output', async () => {
  const cipher = await cipherFor('OP-2026-S1');
  assert.notEqual(cipher.seal('same', { from: 'a', to: 'b' }), cipher.seal('same', { from: 'a', to: 'b' }));
});

test('a message does not open with another token, after tampering, or for another phone', async () => {
  const ours = await cipherFor('OP-2026-S1');
  const theirs = await cipherFor('guess');
  const sealed = ours.seal('{"t":"docs"}', { from: 'a', to: 'b' });

  assert.equal(theirs.open(sealed, { from: 'a', to: 'b' }), null);

  const middle = Math.floor(sealed.length / 2);
  const tampered = sealed.slice(0, middle) + (sealed[middle] === 'A' ? 'B' : 'A') + sealed.slice(middle + 1);
  assert.equal(ours.open(tampered, { from: 'a', to: 'b' }), null);

  assert.equal(ours.open(sealed, { from: 'a', to: 'c' }), null); // replayed to someone else
  assert.equal(ours.open(sealed, { from: 'b', to: 'a' }), null); // bounced back at the sender
  assert.equal(ours.open('not an envelope', { from: 'a', to: 'b' }), null);
  assert.equal(ours.open('s1.@@@', { from: 'a', to: 'b' }), null);
});

test('phones with the same token sync, and what crosses the radio is unreadable', async () => {
  const hub = new LoopbackHub();
  const overheard = [];
  const deliver = hub.deliver.bind(hub);
  hub.deliver = (from, to, text) => { overheard.push(text); deliver(from, to, text); };

  const a = await phone(hub, 'a', 'OP-2026-S1');
  const b = await phone(hub, 'b', 'OP-2026-S1');
  a.store.upsert('tactical_markers', marker('secret-marker', { note: 'casualty collection point' }));

  hub.link('a', 'b');
  await hub.idle();

  assert.deepEqual(ids(b), ['secret-marker']);
  assert.deepEqual(a.engine.connectedPeers().map((peer) => peer.name), ['Responder b']);
  assert.ok(overheard.length > 0);
  assert.ok(overheard.every((text) => !text.includes('secret-marker') && !text.includes('casualty')));
});

test('a phone with a different token is not listed, learns nothing and changes nothing', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', 'OP-2026-S1');
  const outsider = await phone(hub, 'x', 'wrong-token');
  let rejected = null;
  a.engine.on('rejectedPeer', (info) => { rejected = info; });
  a.store.upsert('tactical_markers', marker('ours'));
  outsider.store.upsert('tactical_markers', marker('planted'));

  hub.link('a', 'x');
  await hub.idle();
  a.store.upsert('tactical_markers', marker('later'));
  outsider.store.upsert('tactical_markers', { _id: 'ours', deleted: true });
  await hub.idle();

  assert.deepEqual(a.engine.connectedPeers(), []);
  assert.deepEqual(outsider.engine.connectedPeers(), []);
  assert.deepEqual(ids(a), ['later', 'ours']);
  assert.equal(a.store.get('tactical_markers', 'ours').deleted, undefined);
  assert.deepEqual(ids(outsider), ['ours', 'planted']); // only its own copies
  assert.equal(outsider.store.get('tactical_markers', 'ours').latitude, undefined);
  assert.deepEqual(rejected, { id: 'x', name: 'Responder x' });
});

test('an unsealed phone cannot inject records into a sealed mesh', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', 'OP-2026-S1');
  const plain = await phone(hub, 'p', null);
  plain.store.upsert('tactical_markers', marker('injected'));

  hub.link('a', 'p');
  await hub.idle();

  assert.deepEqual(ids(a), []);
  assert.deepEqual(a.engine.connectedPeers(), []);
});

test('sealed messages larger than the radio allows still get through', async () => {
  const hub = new LoopbackHub({ maxPayloadBytes: 300 });
  const a = await phone(hub, 'a', 'OP-2026-S1');
  const b = await phone(hub, 'b', 'OP-2026-S1');
  const note = 'Bridge down at Māori Pā Road — detour via SH1. '.repeat(40);
  a.store.upsert('tactical_markers', marker('big', { note }));
  for (let i = 0; i < 20; i++) a.store.upsert('tactical_markers', marker(`m${i}`));

  hub.link('a', 'b');
  await hub.idle();

  assert.equal(b.store.all('tactical_markers').length, 21);
  assert.equal(b.store.get('tactical_markers', 'big').note, note);
});

test('relay still works on a sealed mesh: A reaches C through B', async () => {
  const hub = new LoopbackHub();
  const a = await phone(hub, 'a', 'OP-2026-S1');
  const b = await phone(hub, 'b', 'OP-2026-S1');
  const c = await phone(hub, 'c', 'OP-2026-S1');
  hub.link('a', 'b');
  hub.link('b', 'c');
  await hub.idle();

  a.store.upsert('tactical_markers', marker('far'));
  await hub.idle();

  assert.deepEqual(ids(c), ['far']);
});

test('service: the operational token decides which mesh a phone is on', async () => {
  const hub = new LoopbackHub();
  const service = (nodeId) => new MeshService({
    createTransport: () => hub.createTransport(),
    getNodeId: async () => nodeId,
    createCipher: cipherFor,
  });
  const alpha = { id: 'alpha', name: 'Responder Alpha' };
  const a = service('node-a');
  const b = service('node-b');
  await a.init('Responder Alpha');
  await b.init('Responder Bravo');
  await a.startP2PSync('OP-2026-S1');
  await b.startP2PSync('OP-OTHER');
  hub.link('node-a', 'node-b');
  await a.saveMarker({ id: 'm1', latitude: -41.29, longitude: 174.78, type: 'hazard', timestamp: 1 }, alpha);
  await hub.idle();

  assert.deepEqual(a.getRemotePeers(), []);
  assert.deepEqual(await b.getTacticalMarkers(), []);

  // b is given the right token (the mesh authentication prompt in the app)
  await b.startP2PSync('OP-2026-S1');
  hub.link('node-a', 'node-b');
  await hub.idle();

  assert.equal(a.getRemotePeers()[0].deviceName, 'Responder Bravo');
  assert.deepEqual((await b.getTacticalMarkers()).map((doc) => doc._id), ['alpha-m1']);
});
