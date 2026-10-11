import { Emitter } from './emitter.js';
import { MeshStore } from './store.js';
import { HybridClock } from './clock.js';
import { SyncEngine } from './syncEngine.js';
import { createPolicy, certificateRecord, CERTIFICATES } from './policy.js';
import { signRecord, certificateId } from './identity.js';
import { fromBase64 } from './bytes.js';

/**
 * The mesh as the app sees it.
 *
 * This offers the functions the screens call (saveMarker, subscribeToMarkers,
 * observePeers, ...), built on the store and sync engine in this folder. The
 * names and document shapes are the ones the app used with the Ditto SDK it
 * ran on before, which is why the screens did not change when the backend did.
 *
 * It is plain JavaScript. The three things that need a phone are passed in:
 *
 *   createTransport()  a new Transport (Nearby on a phone, loopback in tests)
 *   persistence        where the store is saved, or null to keep it in memory
 *   getNodeId()        this phone's permanent mesh id
 *   createCipher(token) the cipher for an operational token (see cipher.js),
 *                      or leave it out to run an unsealed mesh
 *   retentionMs        how long removed records are remembered before being
 *                      dropped (see MeshStore.compact); leave out to keep them
 *   getIdentity()      this responder's signing identity, or null if they have
 *                      none yet: { certificate, privateKey, authorityKey }.
 *                      With `ed` (an Ed25519 implementation) this turns on
 *                      signed records and the rules in policy.js. Leave both
 *                      out to run without them.
 */

// Shown when a responder has no certificate yet, which needs one sign-in
// while the Mothership is reachable
const NO_CREDENTIALS = 'This phone has no mesh credentials yet. Sign in once while connected to the Mothership.';

const refuseEverything = { check: () => ({ ok: false, reason: NO_CREDENTIALS }) };
const refuseToSign = () => {
  throw new Error(NO_CREDENTIALS);
};

const MARKERS = 'tactical_markers';
const GAPS = 'connectivity_logs';
const QUAKES = 'quake_feed';
const QUAKE_DOC_ID = 'geonet';

const newestFirst = (docs) => [...docs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

// The screens expect peers in this shape (it was the Ditto SDK's)
const toScreenPeer = (peer) => ({
  peerKeyString: peer.id,
  deviceName: peer.name,
  connections: [{ connectionType: peer.link }],
});

export class MeshService {
  constructor({ createTransport, persistence = null, getNodeId, createCipher = null, retentionMs = null, getIdentity = null, ed = null, now = () => Date.now() }) {
    this.createTransport = createTransport;
    this.createCipher = createCipher;
    this.retentionMs = retentionMs;
    this.getIdentity = getIdentity;
    this.ed = ed;
    this.identity = null;
    this.opToken = null;
    this.persistence = persistence;
    this.getNodeId = getNodeId;
    this.now = now;

    this.store = null;
    this.engine = null;
    this.nodeId = null;
    this.deviceName = null;
    this.initialized = false;
    this.syncEnabled = false;
    this.readyListeners = [];
    this.events = new Emitter();
    this.initializing = null;
  }

  /** Runs the callback once the mesh is initialized (immediately if it already is). */
  onReady(callback) {
    if (this.initialized) {
      callback();
      return () => {};
    }
    this.readyListeners.push(callback);
    return () => {
      this.readyListeners = this.readyListeners.filter((listener) => listener !== callback);
    };
  }

  /** Opens the store. The radio stays off until startP2PSync. */
  async init(deviceName) {
    if (this.initialized) {
      // The map screen calls this again after a new sign-in
      await this._loadIdentity();
      await this.setDeviceName(deviceName);
      return true;
    }
    if (!this.initializing) {
      this.initializing = (async () => {
        try {
          this.nodeId = await this.getNodeId();
          this.deviceName = deviceName ? String(deviceName) : this.nodeId;
          this.store = new MeshStore({
            nodeId: this.nodeId,
            clock: new HybridClock(this.nodeId, this.now),
            persistence: this.persistence,
            retentionMs: this.retentionMs,
          });
          await this.store.load();
          console.log(`Mesh store: ${this.store.size()} records loaded`);
          this.store.on('persistenceError', (error) => console.warn('Mesh store: could not save:', error?.message || error));
          this.store.on('rejected', ({ record, reason }) => console.log(`P2P Mesh: refused ${record.collection}/${record.id}: ${reason}`));
          await this._loadIdentity();
          // Tidy removed records left over from earlier sessions
          const { shrunk, dropped } = this.store.compact();
          if (shrunk || dropped) console.log(`Mesh store tidied: ${shrunk} removed records trimmed, ${dropped} dropped`);
          this.initialized = true;
          console.log('Mesh initialized successfully');
          const listeners = this.readyListeners;
          this.readyListeners = [];
          listeners.forEach((listener) => listener());
          return true;
        } catch (error) {
          console.error('Mesh initialization failed:', error);
          this.store = null;
          return false;
        } finally {
          this.initializing = null;
        }
      })();
    }
    return this.initializing;
  }

  /**
   * Reads the signed-in responder's identity and applies it to the store:
   * local writes are signed with their key, and every record must pass the
   * rules. Does nothing when the service was built without identities.
   */
  async _loadIdentity() {
    if (!this.getIdentity || !this.ed) return;
    let identity = null;
    try {
      identity = await this.getIdentity();
    } catch (error) {
      console.warn('Mesh identity unavailable:', error?.message || error);
    }
    this.identity = identity;
    if (!identity) {
      // Nothing can be checked without the Mothership's key, so nothing is
      // accepted, and nothing can be written, until the responder has one.
      this.store.policy = refuseEverything;
      this.store.signer = refuseToSign;
      console.log('Mesh identity: none. Records cannot be written or accepted until this phone signs in online once.');
      return;
    }
    const privateKey = fromBase64(identity.privateKey);
    const certId = certificateId(identity.certificate);
    this.store.policy = createPolicy({ ed: this.ed, authorityKey: identity.authorityKey });
    this.store.signer = (record) => signRecord(this.ed, privateKey, certId, record);
    // Records from before signing was introduced carry no signature. No phone
    // can check them, so none would accept them, and they would be offered
    // and refused on every sync for ever. They are dropped here.
    const unsigned = this.store.removeWhere((record) => record.collection !== CERTIFICATES && !record.auth);
    if (unsigned > 0) console.log(`Mesh store: dropped ${unsigned} unsigned records from an earlier version`);
    // Publish the certificate so other phones can check this responder's records
    this.store.applyRemote([certificateRecord(identity.certificate)], 'local');
    console.log(`Mesh identity: ${identity.certificate.id} (${identity.certificate.role})`);
  }

  /** The signed-in responder as the mesh knows them: { id, role }, or null. */
  whoAmI() {
    return this.identity ? { id: this.identity.certificate.id, role: this.identity.certificate.role } : null;
  }

  /**
   * Turns the radio on. The operational token decides which mesh this phone
   * is part of: only phones started with the same token can read each
   * other's messages or have theirs accepted.
   */
  async startP2PSync(token) {
    if (!this.initialized) throw new Error('Mesh not initialized');
    if (token) {
      // A different token means a different mesh, so restart on it
      if (this.engine && token !== this.opToken) await this.stopP2PSync();
      this.opToken = token;
    }
    if (this.engine) return;
    const cipher = this.createCipher ? await this.createCipher(this.opToken) : null;
    const engine = new SyncEngine({
      store: this.store,
      transport: this.createTransport(),
      nodeId: this.nodeId,
      name: this.deviceName,
      cipher,
    });
    engine.on('rejectedPeer', ({ name }) => console.log(`P2P Mesh: ignoring ${name} (different operational token)`));
    engine.on('received', ({ from, records, accepted }) => console.log(`P2P Mesh: received ${records} records from ${from} (${accepted} new)`));
    engine.on('sent', ({ to, records }) => console.log(`P2P Mesh: sending ${records} records to ${to}`));
    engine.on('sendFailed', ({ bytes, error }) => console.log(`P2P Mesh: a ${bytes}-character message was not sent: ${error?.message || error}`));
    engine.transport.on('log', (message) => console.log(`P2P Mesh: ${message}`));
    engine.observePeers((peers) => {
      const links = [...new Set(peers.map((peer) => peer.link))];
      console.log(`P2P Mesh: ${peers.length} peer(s)${links.length ? ` via ${links.join(', ')}` : ''}`);
      this.events.emit('peers', peers.map(toScreenPeer));
    });
    try {
      await engine.start();
    } catch (error) {
      console.error('P2P Sync failed to start:', error);
      throw error;
    }
    this.engine = engine;
    this.syncEnabled = true;
    console.log('P2P Mesh Networking active');
  }

  async stopP2PSync() {
    if (!this.engine) return;
    const engine = this.engine;
    this.engine = null;
    this.syncEnabled = false;
    try {
      await engine.stop();
      console.log('P2P Mesh Networking disabled');
    } catch (error) {
      console.error('P2P Sync stop failed:', error);
    }
    this.events.emit('peers', []);
  }

  /** The name other phones see. Takes effect by restarting the radio if it is on. */
  async setDeviceName(deviceName) {
    if (!deviceName || String(deviceName) === this.deviceName) return;
    this.deviceName = String(deviceName);
    if (this.engine) {
      await this.stopP2PSync();
      await this.startP2PSync();
    }
  }

  /** Phones directly connected right now. */
  getRemotePeers() {
    return this.engine ? this.engine.connectedPeers().map(toScreenPeer) : [];
  }

  /** Calls back with the peer list now and whenever it changes. */
  observePeers(callback) {
    if (!this.initialized) return null;
    callback(this.getRemotePeers());
    return this.events.on('peers', callback);
  }

  async upsertDocument(collectionName, doc) {
    this.store.upsert(collectionName, doc);
  }

  async saveMarker(marker, userProfile) {
    if (!this.initialized) throw new Error('Mesh not initialized');
    await this.upsertDocument(MARKERS, {
      // The id starts with the author, which is what lets every phone check
      // that nobody else is writing under it
      _id: `${userProfile.id}-${marker.id}`,
      latitude: Number(marker.latitude),
      longitude: Number(marker.longitude),
      type: String(marker.type),
      timestamp: Number(marker.timestamp),
      author_id: String(userProfile.id),
      author_name: String(userProfile.name),
    });
  }

  /** Flags a marker as removed. The flag syncs like any other change. */
  async removeMarker(markerId, userProfile) {
    if (!this.initialized) throw new Error('Mesh not initialized');
    await this.upsertDocument(MARKERS, {
      _id: String(markerId),
      deleted: true,
      deleted_at: this.now(),
      deleted_by: String(userProfile?.id ?? ''),
    });
  }

  async logConnectivityGap(latitude, longitude, userProfile) {
    if (!this.initialized) return;
    const at = this.now();
    await this.upsertDocument(GAPS, {
      _id: `gap_${userProfile?.id ?? 'device'}_${at}`,
      latitude: Number(latitude),
      longitude: Number(longitude),
      timestamp: at,
      event: 'DEAD_ZONE_DETECTED',
      reporter_id: String(userProfile?.id ?? ''),
      reporter_name: String(userProfile?.name ?? ''),
    });
  }

  async clearConnectivityLogs(logs) {
    if (!this.initialized) throw new Error('Mesh not initialized');
    for (const log of logs) {
      await this.upsertDocument(GAPS, { _id: String(log._id), deleted: true, deleted_at: this.now() });
    }
  }

  // The map screen decides when a dead zone is logged; nothing to do here
  startConnectivityMonitoring() {}

  async getConnectivityLogs(hoursAgo = 24) {
    if (!this.initialized) return [];
    const cutoff = this.now() - hoursAgo * 60 * 60 * 1000;
    return newestFirst(this.store.all(GAPS).filter((log) => log.timestamp > cutoff));
  }

  /** One record holding the latest feed, so a phone with internet shares it. */
  async saveQuakeFeed(quakes) {
    if (!this.initialized) return;
    await this.upsertDocument(QUAKES, { _id: QUAKE_DOC_ID, fetched_at: this.now(), payload: JSON.stringify(quakes) });
  }

  /** Calls back with { fetchedAt, quakes } whenever the stored feed changes. */
  subscribeToQuakeFeed(callback) {
    if (!this.initialized) return null;
    return this.store.observe(QUAKES, (docs) => {
      const doc = docs.find((candidate) => candidate._id === QUAKE_DOC_ID);
      if (!doc?.payload) return;
      try {
        callback({ fetchedAt: doc.fetched_at, quakes: JSON.parse(doc.payload) });
      } catch (error) {
        console.warn('Stored quake feed is unreadable:', error?.message || error);
      }
    });
  }

  subscribeToConnectivityLogs(callback) {
    if (!this.initialized) return null;
    return this.store.observe(GAPS, (docs) => callback(newestFirst(docs)));
  }

  async exportConnectivityLogsAsGeoJSON(hoursAgo = 24) {
    const logs = await this.getConnectivityLogs(hoursAgo);
    return {
      type: 'FeatureCollection',
      features: logs.filter((log) => !log.deleted).map((log) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [log.longitude, log.latitude] },
        properties: { timestamp: log.timestamp, event: log.event },
      })),
    };
  }

  subscribeToMarkers(callback) {
    return this.subscribeToMarkerDocs((docs) => callback(docs.filter((doc) => !doc.deleted)));
  }

  /** Like subscribeToMarkers, but includes removed markers. */
  subscribeToMarkerDocs(callback) {
    if (!this.initialized) return null;
    return this.store.observe(MARKERS, (docs) => callback(newestFirst(docs)));
  }

  async getTacticalMarkers() {
    return (await this.getAllMarkerDocs()).filter((doc) => !doc.deleted);
  }

  /** Every marker record, removed ones included (the Mothership needs those). */
  async getAllMarkerDocs() {
    if (!this.initialized) return [];
    return newestFirst(this.store.all(MARKERS));
  }

  /** Marker records with their versions and signatures, for the Mothership. */
  async getAllMarkerRecords() {
    if (!this.initialized) return [];
    return [...this.store.collections.get(MARKERS)?.values() || []];
  }

  /**
   * Takes records relayed by the Mothership. They go through exactly the same
   * checks as records from a phone: the Mothership is a carrier here, and is
   * not trusted to have written or altered anything.
   */
  async applyRelayed(certificates, records) {
    if (!this.initialized) return 0;
    const all = [...(certificates || []).map(certificateRecord), ...(records || [])];
    return this.store.applyRemote(all, 'mothership').filter((record) => record.collection !== CERTIFICATES).length;
  }

  async shutdown() {
    await this.stopP2PSync();
    if (this.store) await this.store.flush();
    this.store = null;
    this.initialized = false;
  }
}
