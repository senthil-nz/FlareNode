import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ed25519 as ed } from '@noble/curves/ed25519';

import { HybridClock, versionMillis } from '../clock.js';
import { MeshStore } from '../store.js';
import { MeshService } from '../meshService.js';
import { createSqlPersistence } from '../sqlPersistence.js';
import { LoopbackHub } from '../loopbackTransport.js';
import { SyncEngine } from '../syncEngine.js';
import { toBase64, fromBase64, canonicalJson } from '../bytes.js';
import { createAuthority, verifyCertificate, signRecord, verifyRecord, generateKeyPair, certificateId } from '../identity.js';
import { createPolicy, certificateRecord, CERTIFICATES } from '../policy.js';

console.log = () => {};

const DAY = 24 * 60 * 60 * 1000;
const random = (count) => new Uint8Array(randomBytes(count));

// The Mothership's side
const authority = createAuthority(ed, random(32));

// A responder's identity, as their phone holds it after signing in
const identityFor = (id, role = 'responder', { now = Date.now(), lifetimeMs = 90 * DAY } = {}) => {
  const keys = generateKeyPair(ed, random);
  const certificate = authority.issue({ id, name: `Responder ${id}`, role, key: keys.publicKey, now, lifetimeMs });
  return { certificate, privateKey: keys.privateKey, authorityKey: authority.publicKey };
};

const user = (identity) => ({ id: identity.certificate.id, name: identity.certificate.name });

// A phone running the service as a given responder
async function phone(hub, nodeId, identity, { persistence = null, now } = {}) {
  const service = new MeshService({
    createTransport: () => hub.createTransport(),
    getNodeId: async () => nodeId,
    getIdentity: async () => identity,
    ed,
    persistence,
    now,
  });
  await service.init(identity ? identity.certificate.name : nodeId);
  await service.startP2PSync();
  return service;
}

const point = (id, extra = {}) => ({ id, latitude: -41.29, longitude: 174.78, type: 'hazard', timestamp: 1000, ...extra });
const markerIds = async (service) => (await service.getTacticalMarkers()).map((doc) => doc._id).sort();

// ---------------------------------------------------------------- building blocks

test('canonical JSON: the same value always gives the same text', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), canonicalJson({ a: { c: 'x', d: [3, { y: 2, z: 1 }] }, b: 1 }));
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: '1' }));
});

test('a certificate from the Mothership verifies; a forged or altered one does not', () => {
  const { certificate } = identityFor('alpha');
  assert.equal(verifyCertificate(ed, authority.publicKey, certificate), true);

  assert.equal(verifyCertificate(ed, authority.publicKey, { ...certificate, role: 'admin' }), false); // promoted themselves
  assert.equal(verifyCertificate(ed, authority.publicKey, { ...certificate, id: 'bravo' }), false);
  assert.equal(verifyCertificate(ed, authority.publicKey, { ...certificate, expires: certificate.expires + DAY }), false);

  const impostor = createAuthority(ed, random(32));
  const fake = impostor.issue({ id: 'alpha', name: 'Responder alpha', role: 'admin', key: certificate.key, now: Date.now(), lifetimeMs: DAY });
  assert.equal(verifyCertificate(ed, authority.publicKey, fake), false);
  assert.equal(verifyCertificate(ed, authority.publicKey, null), false);
  assert.equal(verifyCertificate(ed, authority.publicKey, { ...certificate, sig: 'not base64 !!' }), false);
});

test('a signed record verifies; any change to it breaks the signature', () => {
  const identity = identityFor('alpha');
  const record = { collection: 'tactical_markers', id: 'alpha-1', version: '000000000001000:00000:n', fields: { _id: 'alpha-1', type: 'hazard', author_id: 'alpha' } };
  record.auth = signRecord(ed, fromBase64(identity.privateKey), certificateId(identity.certificate), record);

  assert.equal(verifyRecord(ed, identity.certificate, record), true);
  assert.equal(verifyRecord(ed, identity.certificate, { ...record, fields: { ...record.fields, type: 'responder' } }), false);
  assert.equal(verifyRecord(ed, identity.certificate, { ...record, id: 'alpha-2' }), false);
  assert.equal(verifyRecord(ed, identity.certificate, { ...record, version: '000000000002000:00000:n' }), false);
  assert.equal(verifyRecord(ed, identityFor('bravo').certificate, record), false);
});

// ---------------------------------------------------------------- the rules

// A store acting as one responder, with certificates for everyone it should know
const storeAs = (identity, known = []) => {
  const store = new MeshStore({
    nodeId: `node-${identity.certificate.id}`,
    policy: createPolicy({ ed, authorityKey: authority.publicKey }),
    signer: (record) => signRecord(ed, fromBase64(identity.privateKey), certificateId(identity.certificate), record),
  });
  store.applyRemote([identity, ...known].map((item) => certificateRecord(item.certificate)), 'setup');
  return store;
};

// Hands every record one store holds to another, as a peer would
const offer = (from, to) => to.applyRemote(from.recordsNewerThan(to.digest([CERTIFICATES, 'tactical_markers', 'connectivity_logs', 'quake_feed'])), 'peer');

test('rules: a responder adds markers as themselves and removes their own', () => {
  const alpha = identityFor('alpha');
  const a = storeAs(alpha);
  const b = storeAs(identityFor('bravo'));
  a.upsert('tactical_markers', { _id: 'alpha-1', type: 'hazard', author_id: 'alpha' });
  offer(a, b);
  assert.ok(b.get('tactical_markers', 'alpha-1'));

  a.upsert('tactical_markers', { _id: 'alpha-1', deleted: true, deleted_by: 'alpha' });
  offer(a, b);
  assert.equal(b.get('tactical_markers', 'alpha-1').deleted, true);
});

test('rules: a responder cannot remove or change someone else\'s marker, even on their own phone', () => {
  const alpha = identityFor('alpha');
  const bravo = identityFor('bravo');
  const a = storeAs(alpha, [bravo]);
  const b = storeAs(bravo, [alpha]);
  a.upsert('tactical_markers', { _id: 'alpha-1', type: 'hazard', author_id: 'alpha' });
  offer(a, b);

  assert.throws(() => b.upsert('tactical_markers', { _id: 'alpha-1', deleted: true, deleted_by: 'bravo' }), /author or an admin/);
  assert.throws(() => b.upsert('tactical_markers', { _id: 'alpha-1', type: 'responder' }), /author or an admin/);
  assert.equal(b.get('tactical_markers', 'alpha-1').deleted, undefined);
});

test('rules: an admin can remove anyone\'s marker', () => {
  const alpha = identityFor('alpha');
  const admin = identityFor('admin', 'admin');
  const a = storeAs(alpha, [admin]);
  const boss = storeAs(admin, [alpha]);
  a.upsert('tactical_markers', { _id: 'alpha-1', type: 'hazard', author_id: 'alpha' });
  offer(a, boss);

  boss.upsert('tactical_markers', { _id: 'alpha-1', deleted: true, deleted_by: 'admin' });
  offer(boss, a);
  assert.equal(a.get('tactical_markers', 'alpha-1').deleted, true);
});

test('rules: a cheating phone that skips its own checks is refused by every other phone', () => {
  const alpha = identityFor('alpha');
  const bravo = identityFor('bravo');
  const a = storeAs(alpha, [bravo]);
  const cheat = storeAs(bravo, [alpha]);
  const bystander = storeAs(identityFor('charlie'), [alpha, bravo]);
  a.upsert('tactical_markers', { _id: 'alpha-1', type: 'hazard', author_id: 'alpha' });
  offer(a, cheat);
  offer(a, bystander);

  // bravo's modified app turns its own rule-checking off and signs a removal
  cheat.policy = null;
  cheat.upsert('tactical_markers', { _id: 'alpha-1', deleted: true, deleted_by: 'bravo' });
  assert.equal(cheat.get('tactical_markers', 'alpha-1').deleted, true); // on the cheating phone only

  const refused = [];
  a.on('rejected', ({ reason }) => refused.push(reason));
  assert.deepEqual(offer(cheat, a), []);
  assert.deepEqual(offer(cheat, bystander), []);
  assert.equal(a.get('tactical_markers', 'alpha-1').deleted, undefined);
  assert.equal(bystander.get('tactical_markers', 'alpha-1').deleted, undefined);
  assert.match(refused[0], /author or an admin/);
});

test('rules: claiming to be the author of someone else\'s marker does not work either', () => {
  const alpha = identityFor('alpha');
  const bravo = identityFor('bravo');
  const a = storeAs(alpha, [bravo]);
  const cheat = storeAs(bravo, [alpha]);
  const newcomer = storeAs(identityFor('charlie'), [alpha, bravo]); // has not seen the marker yet
  a.upsert('tactical_markers', { _id: 'alpha-1', type: 'hazard', author_id: 'alpha' });

  // bravo writes a removed record under alpha's marker id, naming bravo as author,
  // hoping phones that have not seen the original will take it
  cheat.policy = null;
  cheat.upsert('tactical_markers', { _id: 'alpha-1', type: 'hazard', author_id: 'bravo', deleted: true });

  assert.deepEqual(offer(cheat, newcomer), []);
  offer(a, newcomer);
  assert.equal(newcomer.get('tactical_markers', 'alpha-1').deleted, undefined);
  assert.equal(newcomer.get('tactical_markers', 'alpha-1').author_id, 'alpha');
});

test('rules: unsigned records, unknown signers and tampered records are refused', () => {
  const alpha = identityFor('alpha');
  const a = storeAs(alpha);
  const b = storeAs(identityFor('bravo')); // has never seen alpha's certificate
  a.upsert('tactical_markers', { _id: 'alpha-1', type: 'hazard', author_id: 'alpha' });
  const [signed] = a.recordsNewerThan({ tactical_markers: {} });

  assert.deepEqual(b.applyRemote([signed], 'peer'), []); // signer not known
  b.applyRemote([certificateRecord(alpha.certificate)], 'peer');
  assert.deepEqual(b.applyRemote([{ ...signed, auth: undefined }], 'peer'), []); // not signed
  assert.deepEqual(b.applyRemote([{ ...signed, fields: { ...signed.fields, type: 'responder' } }], 'peer'), []); // altered in transit
  assert.equal(b.applyRemote([signed], 'peer').length, 1); // the genuine one
});

test('rules: a forged certificate is not stored, so nothing signed with it is accepted', () => {
  const impostor = createAuthority(ed, random(32));
  const keys = generateKeyPair(ed, random);
  const forged = impostor.issue({ id: 'admin', name: 'Admin', role: 'admin', key: keys.publicKey, now: Date.now(), lifetimeMs: DAY });
  const b = storeAs(identityFor('bravo'));

  assert.deepEqual(b.applyRemote([certificateRecord(forged)], 'peer'), []);
  assert.equal(b.get(CERTIFICATES, certificateId(forged)), null);
});

test('rules: a record written after the certificate of its signer ran out is refused', () => {
  const start = 1000 * DAY;
  const expired = identityFor('alpha', 'responder', { now: start, lifetimeMs: 30 * DAY });
  const reader = new MeshStore({ nodeId: 'reader', policy: createPolicy({ ed, authorityKey: authority.publicKey }) });
  reader.applyRemote([certificateRecord(expired.certificate)], 'setup');

  const written = (millis) => {
    const record = { collection: 'tactical_markers', id: `alpha-${millis}`, version: `${String(millis).padStart(15, '0')}:00000:n`, fields: { _id: `alpha-${millis}`, author_id: 'alpha' } };
    record.auth = signRecord(ed, fromBase64(expired.privateKey), certificateId(expired.certificate), record);
    return record;
  };

  assert.equal(reader.applyRemote([written(start + DAY)], 'peer').length, 1); // while valid
  assert.equal(reader.applyRemote([written(start + 60 * DAY)], 'peer').length, 0); // after it ran out
  // Written before the certificate's start date: accepted. Reissuing a certificate
  // moves its start, and must not turn its holder's earlier records away.
  assert.equal(reader.applyRemote([written(start - 5 * DAY)], 'peer').length, 1);
});

test('rules: anyone logs a dead zone as themselves; only an admin clears one', () => {
  const alpha = identityFor('alpha');
  const bravo = identityFor('bravo');
  const admin = identityFor('admin', 'admin');
  const a = storeAs(alpha, [bravo, admin]);
  const b = storeAs(bravo, [alpha, admin]);
  const boss = storeAs(admin, [alpha, bravo]);

  a.upsert('connectivity_logs', { _id: 'gap_alpha_1', reporter_id: 'alpha', latitude: -41.3, longitude: 174.8 });
  assert.throws(() => a.upsert('connectivity_logs', { _id: 'gap_bravo_1', reporter_id: 'bravo' }), /own name/);
  assert.throws(() => a.upsert('connectivity_logs', { _id: 'gap_alpha_1', deleted: true }), /admin/);
  offer(a, b);
  offer(a, boss);
  assert.throws(() => b.upsert('connectivity_logs', { _id: 'gap_alpha_1', deleted: true }), /admin/);

  boss.upsert('connectivity_logs', { _id: 'gap_alpha_1', deleted: true });
  offer(boss, b);
  assert.equal(b.get('connectivity_logs', 'gap_alpha_1').deleted, true);
});

// ---------------------------------------------------------------- whole phones

test('phones: markers and removals flow between responders, each checked on arrival', async () => {
  const hub = new LoopbackHub();
  const alpha = identityFor('alpha');
  const bravo = identityFor('bravo');
  const a = await phone(hub, 'node-a', alpha);
  const b = await phone(hub, 'node-b', bravo);
  hub.link('node-a', 'node-b');

  await a.saveMarker(point('m1'), user(alpha));
  await b.saveMarker(point('m2'), user(bravo));
  await hub.idle();
  assert.deepEqual(await markerIds(a), ['alpha-m1', 'bravo-m2']);
  assert.deepEqual(await markerIds(b), ['alpha-m1', 'bravo-m2']);

  await assert.rejects(() => b.removeMarker('alpha-m1', user(bravo)), /author or an admin/);
  await a.removeMarker('alpha-m1', user(alpha));
  await hub.idle();
  assert.deepEqual(await markerIds(b), ['bravo-m2']);
  assert.deepEqual(a.whoAmI(), { id: 'alpha', role: 'responder' });
});

test('phones: a responder is recognised by phones that have never met them, through a relay', async () => {
  const hub = new LoopbackHub();
  const alpha = identityFor('alpha');
  const a = await phone(hub, 'node-a', alpha);
  const b = await phone(hub, 'node-b', identityFor('bravo'));
  const c = await phone(hub, 'node-c', identityFor('charlie'));
  hub.link('node-a', 'node-b');
  hub.link('node-b', 'node-c'); // a and c are never in range of each other

  await a.saveMarker(point('far'), user(alpha));
  await hub.idle();

  // c accepted it because alpha's certificate travelled through b as well
  assert.deepEqual(await markerIds(c), ['alpha-far']);
});

test('phones: an admin removes another responder\'s marker across the mesh', async () => {
  const hub = new LoopbackHub();
  const alpha = identityFor('alpha');
  const admin = identityFor('admin', 'admin');
  const a = await phone(hub, 'node-a', alpha);
  const boss = await phone(hub, 'node-x', admin);
  hub.link('node-a', 'node-x');
  await a.saveMarker(point('m1'), user(alpha));
  await hub.idle();

  await boss.removeMarker('alpha-m1', user(admin));
  await hub.idle();
  assert.deepEqual(await markerIds(a), []);
  assert.equal((await a.getAllMarkerDocs())[0].deleted_by, 'admin');
});

test('phones: with no credentials a phone can neither write nor be fed records', async () => {
  const hub = new LoopbackHub();
  const alpha = identityFor('alpha');
  const a = await phone(hub, 'node-a', alpha);
  const blank = await phone(hub, 'node-n', null);
  hub.link('node-a', 'node-n');
  await a.saveMarker(point('m1'), user(alpha));
  await hub.idle();

  assert.deepEqual(await markerIds(blank), []);
  assert.equal(blank.whoAmI(), null);
  await assert.rejects(() => blank.saveMarker(point('m2'), { id: 'nobody', name: 'Nobody' }), /no mesh credentials/);
});

test('phones: signing in as someone else changes who the phone writes as', async () => {
  const hub = new LoopbackHub();
  const alpha = identityFor('alpha');
  const bravo = identityFor('bravo');
  let current = alpha;
  const shared = new MeshService({ createTransport: () => hub.createTransport(), getNodeId: async () => 'node-s', getIdentity: async () => current, ed });
  await shared.init('Responder alpha');
  await shared.saveMarker(point('m1'), user(alpha));

  current = bravo;
  await shared.init('Responder bravo'); // what the map screen does after a new sign-in
  assert.deepEqual(shared.whoAmI(), { id: 'bravo', role: 'responder' });
  await shared.saveMarker(point('m2'), user(bravo));
  await assert.rejects(() => shared.removeMarker('alpha-m1', user(bravo)), /author or an admin/);
  await shared.removeMarker('bravo-m2', user(bravo));
});

// ---------------------------------------------------------------- Mothership and storage

test('relay: records carried by the Mothership are checked like any others', async () => {
  const hub = new LoopbackHub();
  const alpha = identityFor('alpha');
  const a = await phone(hub, 'node-a', alpha);
  const fresh = await phone(hub, 'node-f', identityFor('foxtrot')); // never in range of a
  await a.saveMarker(point('m1'), user(alpha));
  await a.saveMarker(point('m2'), user(alpha));

  // what the Mothership would hold after a's upload, and hand to another phone
  const held = JSON.parse(JSON.stringify(await a.getAllMarkerRecords()));
  const certificates = [alpha.certificate];
  const tampered = { ...held[0], fields: { ...held[0].fields, type: 'responder' } }; // a dishonest or broken server

  assert.equal(await fresh.applyRelayed(certificates, [tampered, held[1]]), 1);
  assert.deepEqual(await markerIds(fresh), [held[1].id]);
  assert.equal(await fresh.applyRelayed(certificates, held), 1); // the genuine copy of the other one
  assert.deepEqual(await markerIds(fresh), ['alpha-m1', 'alpha-m2']);
});

test('storage: signatures survive a restart, so records can still be passed on afterwards', async () => {
  const database = new DatabaseSync(':memory:');
  const db = {
    exec: async (sql) => { database.exec(sql); },
    run: async (sql, params) => { database.prepare(sql).run(...params); },
    all: async (sql, params) => database.prepare(sql).all(...params),
  };
  const hub = new LoopbackHub();
  const alpha = identityFor('alpha');

  const first = await phone(hub, 'node-a', alpha, { persistence: createSqlPersistence(db) });
  await first.saveMarker(point('m1'), user(alpha));
  await first.shutdown();

  const reopened = await phone(hub, 'node-a', alpha, { persistence: createSqlPersistence(db) });
  const b = await phone(hub, 'node-b', identityFor('bravo'));
  hub.link('node-a', 'node-b');
  await hub.idle();

  assert.deepEqual(await markerIds(b), ['alpha-m1']);
});

test('upgrade: unsigned records left by an earlier version are dropped when signing starts', async () => {
  const database = new DatabaseSync(':memory:');
  const db = {
    exec: async (sql) => { database.exec(sql); },
    run: async (sql, params) => { database.prepare(sql).run(...params); },
    all: async (sql, params) => database.prepare(sql).all(...params),
  };
  const hub = new LoopbackHub();
  const alpha = identityFor('alpha');

  // the earlier version: no identities, so nothing is signed
  const before = new MeshService({ createTransport: () => hub.createTransport(), getNodeId: async () => 'node-a', persistence: createSqlPersistence(db) });
  await before.init('Responder alpha');
  await before.saveMarker(point('old'), user(alpha));
  await before.shutdown();

  const after = await phone(hub, 'node-a', alpha, { persistence: createSqlPersistence(db) });
  assert.deepEqual(await markerIds(after), []);
  await after.saveMarker(point('new'), user(alpha));
  await after.shutdown();

  const reopened = await phone(hub, 'node-a', alpha, { persistence: createSqlPersistence(db) });
  assert.deepEqual(await markerIds(reopened), ['alpha-new']);
});

test('keys: a generated pair signs and verifies, and the private half is not in the certificate', () => {
  const identity = identityFor('alpha');
  assert.equal(fromBase64(identity.privateKey).length, 32);
  assert.equal(identity.certificate.key, toBase64(ed.getPublicKey(fromBase64(identity.privateKey))));
  assert.ok(!JSON.stringify(identity.certificate).includes(identity.privateKey));
});

/**
 * Found with three real phones: a phone joining late refused most of what the
 * others held. Each time a responder's phone came online it was given a fresh
 * certificate starting "now", which replaced the one before, so everything
 * they had written earlier looked as if it predated their certificate.
 */
test('renewal: a renewed certificate still covers what its holder wrote before the renewal', () => {
  const start = 2000 * DAY;
  const keys = generateKeyPair(ed, random);
  const issue = (now) => authority.issue({ id: 'alpha', name: 'Responder alpha', role: 'responder', key: keys.publicKey, now, lifetimeMs: 90 * DAY, since: start });
  const first = issue(start);
  const renewed = issue(start + 30 * DAY);

  assert.equal(renewed.issued, first.issued, 'the renewal starts when the first certificate did');
  assert.ok(renewed.expires > first.expires, 'and runs for longer');
  assert.equal(certificateId(renewed), certificateId(first));

  // Written under the first certificate, a day after it was issued
  const millis = start + DAY;
  const early = { collection: 'tactical_markers', id: `alpha-${millis}`, version: `${String(millis).padStart(15, '0')}:00000:n`, fields: { _id: `alpha-${millis}`, author_id: 'alpha', type: 'hazard' } };
  early.auth = signRecord(ed, fromBase64(keys.privateKey), certificateId(first), early);

  // A phone that joins after the renewal is only ever given the renewed certificate
  const newcomer = new MeshStore({ nodeId: 'newcomer', policy: createPolicy({ ed, authorityKey: authority.publicKey }) });
  newcomer.applyRemote([certificateRecord(renewed)], 'peer');
  assert.equal(newcomer.applyRemote([early], 'peer').length, 1);

  // A phone holding the first certificate takes the renewal in its place, not the other way round
  const veteran = new MeshStore({ nodeId: 'veteran', policy: createPolicy({ ed, authorityKey: authority.publicKey }) });
  veteran.applyRemote([certificateRecord(first)], 'peer');
  assert.equal(veteran.applyRemote([certificateRecord(renewed)], 'peer').length, 1);
  assert.equal(veteran.get(CERTIFICATES, certificateId(first)).expires, renewed.expires);
  assert.equal(veteran.applyRemote([certificateRecord(first)], 'peer').length, 0);
});

test('sync: a record a phone refuses is not sent to it again at every sync', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hub = new LoopbackHub();
  // The sender applies no rules and holds an unsigned record; the receiver refuses it
  const sender = new MeshStore({ nodeId: 'sender' });
  const receiver = new MeshStore({ nodeId: 'receiver', policy: createPolicy({ ed, authorityKey: authority.publicKey }) });
  const a = new SyncEngine({ store: sender, transport: hub.createTransport(), nodeId: 'sender', name: 'Sender', earlyResyncMs: [], resyncMs: 0 });
  const b = new SyncEngine({ store: receiver, transport: hub.createTransport(), nodeId: 'receiver', name: 'Receiver', earlyResyncMs: [], resyncMs: 0 });
  await a.start();
  await b.start();
  sender.upsert('tactical_markers', { _id: 'unsigned-1', type: 'hazard' });

  let batchesSent = 0;
  a.on('sent', () => { batchesSent += 1; });
  const settle = async () => {
    await hub.idle();
    await wait(20);
    await hub.idle();
  };
  const syncAgain = async () => {
    a._greet('receiver');
    b._greet('sender');
    await settle();
  };

  hub.link('sender', 'receiver'); // connecting starts the first sync
  await settle();
  assert.equal(batchesSent, 1, 'offered once');
  assert.equal(receiver.get('tactical_markers', 'unsigned-1'), null, 'and refused');

  await syncAgain();
  await syncAgain();
  assert.equal(batchesSent, 1, 'not offered again');

  // A different version of the same record is still offered
  sender.upsert('tactical_markers', { _id: 'unsigned-1', type: 'hazard', note: 'changed' });
  await syncAgain();
  assert.ok(batchesSent >= 1);
  const declined = a.declined.get('receiver');
  assert.equal(declined.size, 2, 'each refused version is remembered separately');

  await a.stop();
  await b.stop();
});

// Found while adding to this change: a certificate's record version follows
// its expiry, months ahead, and every phone that received one moved its clock
// that far forward, so everything it wrote afterwards was stamped months ahead.
test('clock: certificates do not move the clock of a phone', () => {
  const alpha = identityFor('alpha');
  const phone = storeAs(alpha, [identityFor('bravo')]); // has taken two certificates, each expiring in 90 days
  phone.upsert('tactical_markers', { _id: 'alpha-1', type: 'hazard', author_id: 'alpha' });
  const written = phone.recordsNewerThan({ tactical_markers: {} })[0].version;
  assert.ok(versionMillis(written) < Date.now() + 60 * 1000, 'stamped with the real time, not months ahead');
});
