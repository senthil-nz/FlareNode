import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeshStore } from '../store.js';
import { SyncEngine } from '../syncEngine.js';
import { LoopbackHub } from '../loopbackTransport.js';
import { MultiTransport } from '../multiTransport.js';
import { Transport } from '../transport.js';

/**
 * Several radios behind one transport. Each pretend radio is its own hub, so
 * a test can put two phones in Wi-Fi range, Bluetooth range, both or neither.
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function radios() {
  const wifi = new LoopbackHub({ label: 'wifi' });
  const bluetooth = new LoopbackHub({ label: 'bluetooth', maxPayloadBytes: 512 });
  const settle = async (ms = 40) => {
    for (let round = 0; round < 3; round += 1) {
      await wifi.idle();
      await bluetooth.idle();
      await wait(ms);
    }
  };
  return { wifi, bluetooth, settle };
}

// Wi-Fi is listed first, so it is preferred when both reach a peer
async function phone({ wifi, bluetooth }, id) {
  const store = new MeshStore({ nodeId: id });
  const transport = new MultiTransport([wifi.createTransport(), bluetooth.createTransport()]);
  const engine = new SyncEngine({ store, transport, nodeId: id, name: `Responder ${id}`, earlyResyncMs: [], resyncMs: 0 });
  await engine.start();
  return { id, store, engine, transport };
}

const ids = (node) => node.store.all('tactical_markers').map((doc) => doc._id).sort();
const marker = (id) => ({ _id: id, latitude: -41.29, longitude: 174.78, type: 'hazard' });
const peers = (node) => node.engine.connectedPeers().map(({ id, link }) => `${id} via ${link}`);

/** A radio that does whatever the test tells it to. */
class ScriptedTransport extends Transport {
  constructor({ startError = null, sendError = null, maxPayloadBytes = 1000 } = {}) {
    super();
    Object.assign(this, { startError, sendError, limit: maxPayloadBytes, sent: [], stopped: false });
  }

  get maxPayloadBytes() { return this.limit; }

  async start() { if (this.startError) throw this.startError; }

  async stop() { this.stopped = true; }

  async send(peerId, text) {
    if (this.sendError) throw this.sendError;
    this.sent.push([peerId, text]);
  }
}

test('a phone reachable over two radios is one peer, and sync uses the preferred radio', async () => {
  const air = radios();
  const a = await phone(air, 'a');
  const b = await phone(air, 'b');
  a.store.upsert('tactical_markers', marker('from-a'));

  air.bluetooth.link('a', 'b');
  air.wifi.link('a', 'b');
  await air.settle();

  assert.deepEqual(peers(a), ['b via wifi']);
  assert.deepEqual(peers(b), ['a via wifi']);
  assert.deepEqual(ids(b), ['from-a']);

  const overBluetooth = air.bluetooth.delivered;
  b.store.upsert('tactical_markers', marker('from-b'));
  await air.settle();
  assert.deepEqual(ids(a), ['from-a', 'from-b']);
  assert.equal(air.bluetooth.delivered, overBluetooth, 'nothing more went over Bluetooth once Wi-Fi was up');
});

test('losing one radio keeps the peer, and sync carries on over the other', async () => {
  const air = radios();
  const a = await phone(air, 'a');
  const b = await phone(air, 'b');
  air.wifi.link('a', 'b');
  air.bluetooth.link('a', 'b');
  await air.settle();

  const seen = [];
  a.engine.observePeers((list) => seen.push(list.map(({ id, link }) => `${id} via ${link}`).join(',')));

  air.wifi.unlink('a', 'b');
  await air.settle();
  assert.deepEqual(peers(a), ['b via bluetooth']);
  assert.ok(!seen.includes(''), 'the peer never dropped off the list');

  a.store.upsert('tactical_markers', marker('after-wifi-dropped'));
  await air.settle();
  assert.deepEqual(ids(b), ['after-wifi-dropped']);

  air.wifi.link('a', 'b');
  await air.settle();
  assert.deepEqual(peers(a), ['b via wifi']);
});

test('a message lost when its radio dropped is recovered over the remaining one', async () => {
  const air = radios();
  const a = await phone(air, 'a');
  const b = await phone(air, 'b');
  air.wifi.link('a', 'b');
  air.bluetooth.link('a', 'b');
  await air.settle();

  // The marker leaves over Wi-Fi, which drops while it is in the air
  a.store.upsert('tactical_markers', marker('in-the-air'));
  for (let turn = 0; turn < 50 && air.wifi.inFlight === 0; turn += 1) await Promise.resolve();
  assert.ok(air.wifi.inFlight > 0, 'the marker is on its way over Wi-Fi');
  const overBluetooth = air.bluetooth.delivered;
  air.wifi.unlink('a', 'b');
  await air.settle();

  assert.deepEqual(ids(b), ['in-the-air']);
  assert.ok(air.bluetooth.delivered > overBluetooth, 'it arrived over Bluetooth');
});

test('the peer is gone only when its last radio drops', async () => {
  const air = radios();
  const a = await phone(air, 'a');
  const b = await phone(air, 'b');
  air.wifi.link('a', 'b');
  air.bluetooth.link('a', 'b');
  await air.settle();

  air.bluetooth.unlink('a', 'b');
  await air.settle();
  assert.deepEqual(peers(a), ['b via wifi']);

  air.wifi.unlink('a', 'b');
  await air.settle();
  assert.deepEqual(peers(a), []);
  assert.deepEqual(peers(b), []);
});

test('a marker crosses a chain made of different radios', async () => {
  const air = radios();
  const a = await phone(air, 'a');
  const b = await phone(air, 'b');
  const c = await phone(air, 'c');
  air.wifi.link('a', 'b'); // a and b share a Wi-Fi network
  air.bluetooth.link('b', 'c'); // c is in Bluetooth range of b only
  await air.settle();

  a.store.upsert('tactical_markers', { ...marker('big'), notes: 'x'.repeat(3000) });
  await air.settle();

  assert.deepEqual(ids(c), ['big']);
  assert.equal(c.store.get('tactical_markers', 'big').notes.length, 3000);
});

test('messages are sized for the radio with the smallest limit', () => {
  const transport = new MultiTransport([new ScriptedTransport({ maxPayloadBytes: 30000 }), new ScriptedTransport({ maxPayloadBytes: 512 })]);
  assert.equal(transport.maxPayloadBytes, 512);
});

test('when the preferred radio fails to send, the next one is tried', async () => {
  const broken = new ScriptedTransport({ sendError: new Error('radio fault') });
  const working = new ScriptedTransport();
  const transport = new MultiTransport([broken, working]);
  await transport.start({ nodeId: 'a', name: 'A' });
  broken.emit('peerConnected', { id: 'b', name: 'B', link: 'wifi' });
  working.emit('peerConnected', { id: 'b', name: 'B', link: 'bluetooth' });

  await transport.send('b', 'hello');
  assert.deepEqual(working.sent, [['b', 'hello']]);

  working.sendError = new Error('also broken');
  await assert.rejects(() => transport.send('b', 'again'), /also broken/);
  await assert.rejects(() => transport.send('nobody', 'hello'), /Not connected/);
});

test('a radio that will not start is left out; starting fails only if none start', async () => {
  const dead = new ScriptedTransport({ startError: new Error('Bluetooth is off') });
  const working = new ScriptedTransport();
  const transport = new MultiTransport([dead, working]);
  const log = [];
  transport.on('log', (message) => log.push(message));

  await transport.start({ nodeId: 'a', name: 'A' });
  assert.match(log.join('\n'), /Bluetooth is off/);
  await transport.stop();
  assert.equal(working.stopped, true);
  assert.equal(dead.stopped, false, 'a radio that never started is not stopped');

  const none = new MultiTransport([new ScriptedTransport({ startError: new Error('no radio') })]);
  await assert.rejects(() => none.start({ nodeId: 'a', name: 'A' }), /no radio/);
  assert.throws(() => new MultiTransport([]), /at least one/);
});

test('stopping drops every peer and stops listening to the radios', async () => {
  const air = radios();
  const a = await phone(air, 'a');
  const b = await phone(air, 'b');
  air.wifi.link('a', 'b');
  await air.settle();

  await a.engine.stop();
  await air.settle();
  assert.deepEqual(peers(a), []);
  assert.deepEqual(peers(b), []);
  assert.equal(a.transport.peers.size, 0);
});
