import { Emitter } from './emitter.js';

// A refusal may stop being one (the phone may since have learned the signer's
// certificate), so it is remembered for a while, not for good
const DECLINED_FOR_MS = 10 * 60 * 1000;
const MAX_DECLINED_PER_PEER = 5000;
const DECLINED_PER_MESSAGE = 100;

/**
 * Keeps this phone's store in step with every phone it can reach.
 *
 * How two phones catch up when they meet:
 *
 *   1. each sends `hello` (protocol version)
 *   2. each sends a `summary`: a short fingerprint per collection
 *   3. for collections whose fingerprints differ, each sends a `digest`: the
 *      id and version of every record it holds in them
 *   4. each replies with `docs`: the records the other is missing or holds an
 *      older version of
 *   5. a phone that refuses any of those records (see policy.js) says which
 *      with `declined`, and is not sent those exact versions again for a
 *      while. Without this, a refused record would be sent again at every
 *      sync for as long as the phones stayed in range.
 *
 * Step 2 is what keeps reconnecting cheap. Phones drop and regain each other
 * often, and most of the time nothing changed in between; matching
 * fingerprints end the exchange there instead of listing every record.
 *
 * Radios lose messages, most often right as a connection forms. So steps 1
 * and 2 are not sent just once: they are repeated shortly after connecting
 * and then every so often for as long as the phones stay connected. Because
 * matching fingerprints cost almost nothing, this is cheap, and it means a
 * lost message delays catching up instead of preventing it.
 *
 * How changes spread afterwards:
 *
 *   - a local write is sent to every connected peer straight away
 *   - a record received from a peer is passed on to the other peers, but only
 *     if it was newer than what this phone had
 *
 * That last rule is what makes the mesh multi-hop without any routing: if A
 * can reach B and B can reach C, B passes A's records on to C. It also stops
 * records going round in circles, because a phone that already has a record
 * does not pass it on again.
 *
 * Wire format: JSON text. Every message has `t` (type). Messages larger than
 * the transport allows are split into `frag` messages and reassembled.
 *
 * With a `cipher` (see cipher.js) every message is sealed before it is sent.
 * A connected phone then only counts as a peer once it has sent something
 * that opens with the mesh key; until then it is not listed, and nothing it
 * sends is acted on. Without a cipher, messages travel as plain JSON.
 */

export const PROTOCOL_VERSION = 3;

// When hello and summary are repeated: soon after connecting, then steadily
const EARLY_RESYNC_MS = [1500, 5000];
const RESYNC_MS = 20000;

// Timers must not keep a Node process alive in tests; phones have no unref
const background = (timer) => {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};

// JSON-escaping a fragment's text can at worst double its size
const fragmentSize = (maxPayloadBytes) => Math.max(64, Math.floor((maxPayloadBytes - 96) / 2));

// UTF-8 length without relying on Buffer or TextEncoder being present
const byteLength = (text) => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
};

// Cuts text into pieces of at most `size` UTF-8 bytes without splitting a character
const splitByBytes = (text, size) => {
  const parts = [];
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const bytes = byteLength(char);
    if (currentBytes + bytes > size && current) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current) parts.push(current);
  return parts;
};

export class SyncEngine extends Emitter {
  constructor({ store, transport, nodeId, name, cipher = null, resyncMs = RESYNC_MS, earlyResyncMs = EARLY_RESYNC_MS }) {
    super();
    this.store = store;
    this.transport = transport;
    this.nodeId = nodeId;
    this.name = name || nodeId;
    this.cipher = cipher;
    this.resyncMs = resyncMs;
    this.earlyResyncMs = earlyResyncMs;
    this.timers = new Set();
    this.resyncTimer = null;
    this.peers = new Map();
    this.partial = new Map();
    // Records each peer has said it refused: peer id -> (record key -> when to forget)
    this.declined = new Map();
    this.refusing = null;
    this.nextFragmentId = 1;
    this.unsubscribers = [];
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.unsubscribers = [
      this.transport.on('peerConnected', (peer) => this._onPeerConnected(peer)),
      this.transport.on('peerDisconnected', (id) => this._onPeerDisconnected(id)),
      this.transport.on('linkChanged', (id, link) => this._onLinkChanged(id, link)),
      this.transport.on('message', (peerId, text) => this._onMessage(peerId, text)),
      this.store.on('change', ({ records, origin }) => this._onStoreChange(records, origin)),
      this.store.on('rejected', ({ record }) => { if (this.refusing) this.refusing.push(record); }),
    ];
    await this.transport.start({ nodeId: this.nodeId, name: this.name });
    if (this.resyncMs > 0) {
      this.resyncTimer = background(setInterval(() => {
        for (const id of this.peers.keys()) this._greet(id);
      }, this.resyncMs));
    }
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.resyncTimer = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await this.transport.stop();
    this.peers.clear();
    this.partial.clear();
    this.emit('peers', this.connectedPeers());
  }

  /**
   * Peers this phone is directly connected to: [{ id, name, link }].
   * On a sealed mesh, only phones that have proved they hold the key.
   */
  connectedPeers() {
    return [...this.peers.values()]
      .filter((peer) => peer.trusted)
      .map(({ id, name, link }) => ({ id, name, link }));
  }

  /** Calls back with the peer list now and whenever it changes. */
  observePeers(callback) {
    callback(this.connectedPeers());
    return this.on('peers', callback);
  }

  _onPeerConnected(peer) {
    this.peers.set(peer.id, {
      id: peer.id,
      name: peer.name || peer.id,
      link: peer.link || 'unknown',
      // Without a cipher there is nothing to prove, so the peer counts at once
      trusted: !this.cipher,
      // Certificates already sent on this connection
      certificates: new Set(),
    });
    if (!this.cipher) this.emit('peers', this.connectedPeers());
    this._greet(peer.id);
    // Say it again shortly, in case the first went out before the other
    // phone was ready to hear it
    const connection = this.peers.get(peer.id);
    for (const delay of this.earlyResyncMs) {
      const timer = background(setTimeout(() => {
        this.timers.delete(timer);
        if (this.peers.get(peer.id) === connection) this._greet(peer.id);
      }, delay));
      this.timers.add(timer);
    }
  }

  /** Protocol version and fingerprints. Sealed, unreadable without the key. */
  _greet(peerId) {
    this._send(peerId, { t: 'hello', v: PROTOCOL_VERSION });
    this._send(peerId, { t: 'summary', s: this.store.summary() });
  }

  // The peer is now reached over a different radio (see MultiTransport). It
  // is the same phone, so trust stands, but messages on the old link may have
  // been lost: compare notes again.
  _onLinkChanged(id, link) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.link = link || 'unknown';
    for (const key of [...this.partial.keys()]) {
      if (key.startsWith(`${id}|`)) this.partial.delete(key);
    }
    if (peer.trusted) this.emit('peers', this.connectedPeers());
    this._greet(id);
  }

  _onPeerDisconnected(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    for (const key of [...this.partial.keys()]) {
      if (key.startsWith(`${id}|`)) this.partial.delete(key);
    }
    if (peer.trusted) this.emit('peers', this.connectedPeers());
  }

  _onStoreChange(records, origin) {
    if (origin === 'cleanup') return; // records were dropped, nothing to send
    for (const peer of this.peers.values()) {
      // Never send a record back to the peer it just came from
      if (peer.trusted && !peer.incompatible && peer.id !== origin) this._sendRecords(peer.id, records);
    }
  }

  _onMessage(peerId, text) {
    if (typeof text !== 'string' || text.length === 0) return;

    // Plain JSON: either a fragment of a larger message, or an unsealed message
    if (text[0] === '{') {
      let message;
      try {
        message = JSON.parse(text);
      } catch (error) {
        return; // not ours, or damaged in transit
      }
      if (!message || typeof message.t !== 'string') return;
      if (message.t === 'frag') {
        const whole = this._reassemble(peerId, message);
        if (whole !== null) this._onMessage(peerId, whole);
        return;
      }
      // On a sealed mesh an unsealed message is from someone without the key
      if (!this.cipher) this._handle(peerId, message);
      return;
    }

    if (!this.cipher) return;
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const opened = this.cipher.open(text, { from: peerId, to: this.nodeId });
    if (opened === null) {
      // Wrong token, or tampering. Say so once per connection.
      if (!peer.rejected) {
        peer.rejected = true;
        this.emit('rejectedPeer', { id: peerId, name: peer.name });
      }
      return;
    }
    let message;
    try {
      message = JSON.parse(opened);
    } catch (error) {
      return;
    }
    if (!message || typeof message.t !== 'string') return;
    if (!peer.trusted) {
      peer.trusted = true;
      this.emit('peers', this.connectedPeers());
    }
    this._handle(peerId, message);
  }

  _handle(peerId, message) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    if (message.t === 'hello') {
      // A peer speaking a newer protocol is ignored rather than misread
      peer.incompatible = message.v !== PROTOCOL_VERSION;
      if (peer.incompatible) this.emit('incompatiblePeer', { id: peerId, version: message.v });
      return;
    }
    if (peer.incompatible) return;

    if (message.t === 'summary' && message.s && typeof message.s === 'object') {
      // List records only for collections where the two phones differ
      const mine = this.store.summary();
      const differing = [...new Set([...Object.keys(mine), ...Object.keys(message.s)])].filter((name) => mine[name] !== message.s[name]);
      if (differing.length > 0) this._send(peerId, { t: 'digest', d: this.store.digest(differing) });
    } else if (message.t === 'digest' && message.d && typeof message.d === 'object') {
      const missing = this.store.recordsNewerThan(message.d).filter((record) => !this._hasDeclined(peerId, record));
      if (missing.length > 0) this.emit('sent', { to: peer.name, records: missing.length });
      this._sendRecords(peerId, missing);
    } else if (message.t === 'docs' && Array.isArray(message.r)) {
      // Accepted records reach the other peers through the store's change event
      this.refusing = [];
      const accepted = this.store.applyRemote(message.r, peerId);
      const refused = this.refusing;
      this.refusing = null;
      this.emit('received', { from: peer.name, records: message.r.length, accepted: accepted.length });
      // Tell the sender, so it stops offering these exact versions
      for (let start = 0; start < refused.length; start += DECLINED_PER_MESSAGE) {
        const batch = refused.slice(start, start + DECLINED_PER_MESSAGE);
        this._send(peerId, { t: 'declined', r: batch.map((record) => [record.collection, record.id, record.version]) });
      }
    } else if (message.t === 'declined' && Array.isArray(message.r)) {
      const forgetAt = Date.now() + DECLINED_FOR_MS;
      if (!this.declined.has(peerId)) this.declined.set(peerId, new Map());
      const byPeer = this.declined.get(peerId);
      for (const entry of message.r) {
        if (!Array.isArray(entry) || entry.length !== 3 || !entry.every((part) => typeof part === 'string')) continue;
        byPeer.set(entry.join('\u0000'), forgetAt);
        if (byPeer.size > MAX_DECLINED_PER_PEER) byPeer.delete(byPeer.keys().next().value);
      }
    }
  }

  // Only the exact version is skipped. A different version of the same record
  // is always offered, so a peer cannot be kept from a genuine record by
  // someone feeding it a bogus one under the same id.
  _hasDeclined(peerId, record) {
    const byPeer = this.declined.get(peerId);
    if (!byPeer) return false;
    const key = [record.collection, record.id, record.version].join('\u0000');
    const forgetAt = byPeer.get(key);
    if (forgetAt === undefined) return false;
    if (forgetAt > Date.now()) return true;
    byPeer.delete(key);
    return false;
  }

  /** Sends records in batches small enough to avoid fragmenting where possible. */
  _sendRecords(peerId, records) {
    if (records.length === 0) return;
    // Put each signer's certificate ahead of their records, once per
    // connection. A record can otherwise overtake the certificate needed to
    // check it, for instance a marker dropped the moment two phones connect.
    const peer = this.peers.get(peerId);
    if (peer) {
      const already = new Set(records.map((record) => record));
      const needed = this.store.certificatesFor(records).filter((certificate) => !peer.certificates.has(certificate.id) && !already.has(certificate));
      for (const certificate of needed) peer.certificates.add(certificate.id);
      if (needed.length > 0) records = [...needed, ...records];
    }
    const limit = Math.floor(this.transport.maxPayloadBytes / 2);
    let batch = [];
    let size = 0;
    for (const record of records) {
      const recordSize = byteLength(JSON.stringify(record));
      if (batch.length > 0 && size + recordSize > limit) {
        this._send(peerId, { t: 'docs', r: batch });
        batch = [];
        size = 0;
      }
      batch.push(record);
      size += recordSize;
    }
    this._send(peerId, { t: 'docs', r: batch });
  }

  _send(peerId, message) {
    let text = JSON.stringify(message);
    // Seal first, then split: a fragment is useless without the rest
    if (this.cipher) text = this.cipher.seal(text, { from: this.nodeId, to: peerId });
    const max = this.transport.maxPayloadBytes;
    if (byteLength(text) <= max) {
      this._transmit(peerId, text);
      return;
    }
    // Start from a size that fits after typical JSON escaping, and halve it if
    // unusual text (many control characters, say) makes a fragment too big.
    const id = this.nextFragmentId++;
    let size = fragmentSize(max);
    for (;;) {
      const fragments = splitByBytes(text, size).map((data, index, parts) =>
        JSON.stringify({ t: 'frag', id, i: index, n: parts.length, d: data })
      );
      if (fragments.every((fragment) => byteLength(fragment) <= max) || size <= 8) {
        fragments.forEach((fragment) => this._transmit(peerId, fragment));
        return;
      }
      size = Math.floor(size / 2);
    }
  }

  _transmit(peerId, text) {
    // A peer can drop out between deciding to send and sending. Nothing is
    // lost for good: the digest exchange on the next connection catches up.
    Promise.resolve()
      .then(() => this.transport.send(peerId, text))
      .catch((error) => this.emit('sendFailed', { to: peerId, bytes: text.length, error }));
  }

  _reassemble(peerId, { id, i, n, d }) {
    if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > 10000 || i < 0 || i >= n || typeof d !== 'string') return null;
    const key = `${peerId}|${id}`;
    if (!this.partial.has(key)) this.partial.set(key, { parts: new Array(n).fill(null), received: 0 });
    const entry = this.partial.get(key);
    if (entry.parts.length !== n) return null;
    if (entry.parts[i] === null) {
      entry.parts[i] = d;
      entry.received += 1;
    }
    if (entry.received < n) return null;
    this.partial.delete(key);
    return entry.parts.join('');
  }
}
