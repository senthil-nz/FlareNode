import { Emitter } from './emitter.js';
import { HybridClock, compareVersions, versionMillis, nextAfter } from './clock.js';
import { CERTIFICATES } from './policy.js';

// Certificates take their versions from their expiry dates, months ahead, not
// from when they were written, so they must not move this phone's clock.
const movesClock = (record) => record.collection !== CERTIFICATES;

/**
 * The on-device document store.
 *
 * Documents live in named collections and are keyed by `_id`, like the Ditto
 * collections this replaces. Each stored record carries the version of its
 * last write:
 *
 *   { collection, id, version, fields }
 *
 * Conflict rule: the whole record with the highest version wins. That is
 * simpler than merging field by field, and enough here because records are
 * created and flagged, rarely edited by two people at once.
 *
 * Removing a marker does not delete its record; it sets `deleted: true`, as
 * the app already does. The flagged record (a "tombstone") is what stops a
 * phone that missed the removal from bringing the marker back. Tombstones are
 * cleaned up later by `compact`.
 *
 * `persistence` is optional:
 *   load()                    -> Promise<records[]>
 *   saveRecords(records)      -> Promise   only the records that changed
 *   removeRecords(keys)       -> Promise   keys are { collection, id }
 *
 * `retentionMs` is how long a tombstone is kept. Leave it out to keep them
 * for ever. See `compact` for what setting it means.
 *
 * `signer` and `policy` are optional and go together (see identity.js and
 * policy.js). With them, every local write is signed, and every record,
 * local or from a peer, must pass the policy before it is stored. Both can
 * be replaced while running, for when a different responder signs in.
 *   signer(record)                          -> the `auth` to attach
 *   policy.check(record, existing, getCert) -> { ok } or { ok: false, reason }
 */

// Enough to tell who removed a record and when; the rest of a removed record is dead weight
const TOMBSTONE_FIELDS = ['_id', 'deleted', 'deleted_at', 'deleted_by', 'timestamp', 'author_id'];

export class MeshStore extends Emitter {
  constructor({ nodeId, clock, persistence = null, retentionMs = null, signer = null, policy = null } = {}) {
    super();
    if (!nodeId) throw new Error('MeshStore needs a nodeId');
    this.nodeId = nodeId;
    this.clock = clock || new HybridClock(nodeId);
    this.persistence = persistence;
    this.retentionMs = retentionMs;
    this.signer = signer;
    this.policy = policy;
    this.collections = new Map();
    this.saving = Promise.resolve();
  }

  /** Reads saved records from persistence. Call once before use. */
  async load() {
    if (!this.persistence) return;
    const records = (await this.persistence.load()) || [];
    for (const record of records) {
      this._put(record);
      if (movesClock(record)) this.clock.observe(record.version);
    }
  }

  /**
   * Local write. The given fields are merged into the existing document (or
   * create it) and the result is stamped with a new version.
   */
  upsert(collection, doc) {
    if (!doc || doc._id === undefined || doc._id === null) throw new Error('Document needs an _id');
    const id = String(doc._id);
    const existing = this._collection(collection).get(id);
    // A change must be newer than what it replaces, even if that carries a
    // version from a clock that was ahead
    let version = this.clock.tick();
    if (existing && compareVersions(version, existing.version) <= 0) version = nextAfter(existing.version, this.clock.nodeId);
    const record = {
      collection,
      id,
      version,
      fields: { ...(existing?.fields || {}), ...doc, _id: id },
    };
    if (this.signer) record.auth = this.signer(record);
    // The same rules as for records from other phones, so a change that
    // others would refuse fails here, straight away, instead of silently
    // existing on this phone only.
    const verdict = this._verdict(record, existing);
    if (!verdict.ok) throw new Error(`Not allowed: ${verdict.reason}`);
    this._put(record);
    this._changed([record], 'local');
    return record.fields;
  }

  get(collection, id) {
    return this._collection(collection).get(String(id))?.fields || null;
  }

  /** Every document in a collection, soft-deleted ones included. */
  all(collection) {
    return [...this._collection(collection).values()].map((record) => record.fields);
  }

  /** Number of records held, across all collections. */
  size() {
    let count = 0;
    for (const records of this.collections.values()) count += records.size;
    return count;
  }

  /** Calls back with the whole collection now and after every change to it. */
  observe(collection, callback) {
    callback(this.all(collection));
    return this.on('change', ({ records }) => {
      if (records.some((record) => record.collection === collection)) callback(this.all(collection));
    });
  }

  /**
   * A short fingerprint of each collection: { collection: "count:sum:xor" }.
   * Two phones holding exactly the same records and versions get the same
   * fingerprint, whatever order the records arrived in. Comparing these first
   * lets phones that are already in step skip exchanging full lists.
   */
  summary() {
    const summary = {};
    for (const [name, records] of this.collections) {
      if (records.size === 0) continue;
      let sum = 0;
      let xor = 0;
      for (const [id, record] of records) {
        const hash = fnv1a(`${id}\u0000${record.version}`);
        sum = (sum + hash) >>> 0;
        xor = (xor ^ hash) >>> 0;
      }
      summary[name] = `${records.size}:${sum.toString(36)}:${xor.toString(36)}`;
    }
    return summary;
  }

  /**
   * What this phone has, as { collection: { id: version } }. Sent to peers.
   * Pass collection names to limit it to those.
   */
  digest(only = null) {
    const digest = {};
    for (const [name, records] of this.collections) {
      if (only && !only.includes(name)) continue;
      digest[name] = {};
      for (const [id, record] of records) digest[name][id] = record.version;
    }
    for (const name of only || []) digest[name] = digest[name] || {};
    return digest;
  }

  /**
   * Records a peer is missing or holds an older version of, given its digest.
   * Only the collections named in the digest are considered: a peer that did
   * not list a collection has said nothing about it.
   */
  recordsNewerThan(peerDigest = {}) {
    const out = [];
    // Certificates go first, so the receiver can check the records that follow
    const names = Object.keys(peerDigest).sort((a, b) => (b === CERTIFICATES) - (a === CERTIFICATES));
    for (const name of names) {
      const theirs = peerDigest[name] || {};
      for (const [id, record] of this._collection(name)) {
        if (theirs[id] === undefined || compareVersions(record.version, theirs[id]) > 0) out.push(record);
      }
    }
    return out;
  }

  /**
   * The certificates needed to check these records' signatures. A peer that
   * has not seen a signer before must receive that signer's certificate
   * first, or it has no way to check the record and will refuse it.
   */
  certificatesFor(records) {
    const out = new Map();
    for (const record of records) {
      const id = record.auth?.k;
      if (!id || out.has(id)) continue;
      const certificate = this._collection(CERTIFICATES).get(id);
      if (certificate) out.set(id, certificate);
    }
    return [...out.values()];
  }

  /**
   * Applies records received from a peer. Returns only those that were newer
   * than what was stored; only those need passing on to other peers, which is
   * what stops records circulating forever.
   */
  applyRemote(records, origin) {
    const accepted = [];
    const horizon = this._horizon();
    // Certificates first, whatever order they arrived in
    const ordered = [...records].sort((a, b) => (b?.collection === CERTIFICATES) - (a?.collection === CERTIFICATES));
    for (const record of ordered) {
      if (!isValidRecord(record)) continue;
      const existing = this._collection(record.collection).get(record.id);
      // Older than the retention period and unknown here: it may be a record
      // whose tombstone has already been cleaned up, so it is not taken.
      if (!existing && horizon !== null && versionMillis(record.version) < horizon) continue;
      if (movesClock(record)) this.clock.observe(record.version);
      if (existing && compareVersions(record.version, existing.version) <= 0) continue;
      const verdict = this._verdict(record, existing);
      if (!verdict.ok) {
        this.emit('rejected', { record, reason: verdict.reason, origin });
        continue;
      }
      const stored = { collection: record.collection, id: record.id, version: record.version, fields: { ...record.fields, _id: record.id } };
      if (record.auth) stored.auth = { k: record.auth.k, sig: record.auth.sig };
      this._put(stored);
      accepted.push(stored);
    }
    if (accepted.length > 0) this._changed(accepted, origin);
    return accepted;
  }

  /**
   * Housekeeping for removed records, so the store does not grow for ever.
   *
   * - Tombstones older than `shrinkAfterMs` lose everything except who
   *   removed them and when. They keep their version, so they still win
   *   against old copies. Signed records are left whole: their signature
   *   covers their content, so trimming them would make them unverifiable.
   * - Tombstones older than the retention period are dropped altogether.
   *
   * Dropping a tombstone would normally let a phone that was away for longer
   * than the retention period bring the record back. `applyRemote` closes
   * that door by refusing unknown records older than the retention period.
   * The cost: a phone that was offline for longer than that cannot deliver
   * its oldest records. With no `retentionMs`, nothing is ever dropped.
   *
   * Returns how many records were shrunk and dropped.
   */
  compact({ shrinkAfterMs = 24 * 60 * 60 * 1000 } = {}) {
    const now = this.clock.now();
    const horizon = this._horizon();
    const shrunk = [];
    const dropped = [];
    for (const [name, records] of this.collections) {
      for (const [id, record] of [...records]) {
        if (record.fields.deleted !== true) continue;
        const written = versionMillis(record.version);
        if (horizon !== null && written < horizon) {
          records.delete(id);
          dropped.push({ collection: name, id });
        } else if (!record.auth && written < now - shrinkAfterMs && Object.keys(record.fields).some((key) => !TOMBSTONE_FIELDS.includes(key))) {
          const fields = {};
          for (const key of TOMBSTONE_FIELDS) if (record.fields[key] !== undefined) fields[key] = record.fields[key];
          const slim = { ...record, fields };
          records.set(id, slim);
          shrunk.push(slim);
        }
      }
    }
    if (this.persistence) {
      if (shrunk.length) this._persist(() => this.persistence.saveRecords(shrunk));
      if (dropped.length) this._persist(() => this.persistence.removeRecords(dropped));
    }
    return { shrunk: shrunk.length, dropped: dropped.length };
  }

  /**
   * Drops every record the test says to, from memory and from storage.
   * Returns how many went. Nothing is sent to peers about it.
   */
  removeWhere(shouldRemove) {
    const gone = [];
    for (const [name, records] of this.collections) {
      for (const [id, record] of [...records]) {
        if (!shouldRemove(record)) continue;
        records.delete(id);
        gone.push({ collection: name, id });
      }
    }
    if (gone.length > 0) {
      if (this.persistence) this._persist(() => this.persistence.removeRecords(gone));
      this.emit('change', { records: gone.map((key) => ({ ...key, fields: {} })), origin: 'cleanup' });
    }
    return gone.length;
  }

  /** Resolves when every write so far has reached persistence. */
  flush() {
    return this.saving;
  }

  _verdict(record, existing) {
    if (!this.policy) return { ok: true };
    // The signature must cover the fields the record arrived with
    const candidate = record.fields._id === record.id ? record : { ...record, fields: { ...record.fields, _id: record.id } };
    return this.policy.check(candidate, existing, (id) => this.get(CERTIFICATES, id));
  }

  _horizon() {
    return this.retentionMs === null ? null : this.clock.now() - this.retentionMs;
  }

  _collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  _put(record) {
    this._collection(record.collection).set(record.id, record);
  }

  _changed(records, origin) {
    if (this.persistence) this._persist(() => this.persistence.saveRecords(records));
    this.emit('change', { records, origin });
  }

  // Writes queue behind each other. A failed write is reported, not hidden:
  // the record stays in memory, but would be gone after a restart.
  _persist(write) {
    this.saving = this.saving.then(write).catch((error) => this.emit('persistenceError', error));
  }
}

// 32-bit FNV-1a: small, fast and well spread; not a security measure
const fnv1a = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const isValidRecord = (record) =>
  !!record &&
  typeof record.collection === 'string' &&
  typeof record.id === 'string' &&
  typeof record.version === 'string' &&
  !!record.fields &&
  typeof record.fields === 'object';
