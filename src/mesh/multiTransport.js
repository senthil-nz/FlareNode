import { Transport } from './transport.js';

/**
 * Several radios presented as one transport.
 *
 * Phones may be able to reach each other in more than one way at once: over
 * Bluetooth, over the Wi-Fi network they share, through Nearby Connections.
 * This runs every radio it is given and shows the sync engine one peer per
 * phone, however many ways there are to reach it.
 *
 *   new MultiTransport([wifi, bluetooth])    most preferred first
 *
 * - A peer is connected from its first link until its last one drops.
 * - Messages go over the most preferred radio that reaches the peer. If that
 *   send fails, the next radio is tried before giving up.
 * - When the radio in use for a peer changes, 'linkChanged' (id, link) is
 *   emitted. Messages in the air on the old link may be lost, so the sync
 *   engine compares notes with the peer again when it hears this.
 * - A radio that fails to start is left out. Starting fails only if none start.
 *
 * It also lets a new radio be run next to a proven one until it is trusted.
 */
export class MultiTransport extends Transport {
  constructor(transports) {
    super();
    if (!transports || transports.length === 0) throw new Error('MultiTransport needs at least one transport');
    this.transports = transports;
    this.started = [];
    this.unsubscribers = [];
    // peer id -> Map(transport -> { name, link })
    this.peers = new Map();
  }

  // The engine splits messages to fit this, so it must hold for every radio
  get maxPayloadBytes() {
    return Math.min(...this.transports.map((transport) => transport.maxPayloadBytes));
  }

  async start(identity) {
    for (const transport of this.transports) {
      this.unsubscribers.push(
        transport.on('peerConnected', (peer) => this._onLinkUp(transport, peer)),
        transport.on('peerDisconnected', (id) => this._onLinkDown(transport, id)),
        transport.on('message', (peerId, text) => this.emit('message', peerId, text)),
        transport.on('log', (message) => this.emit('log', message)),
      );
    }
    const results = await Promise.allSettled(this.transports.map((transport) => transport.start(identity)));
    this.started = this.transports.filter((_, index) => results[index].status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (this.started.length === 0) {
      this._unsubscribe();
      throw failures[0];
    }
    for (const failure of failures) this.emit('log', `a radio did not start: ${failure?.message || failure}`);
  }

  async stop() {
    const started = this.started;
    this.started = [];
    await Promise.allSettled(started.map((transport) => transport.stop()));
    this._unsubscribe();
    this.peers.clear();
  }

  async send(peerId, text) {
    const routes = this._routes(peerId);
    if (routes.length === 0) throw new Error(`Not connected to ${peerId}`);
    let lastError;
    for (const transport of routes) {
      try {
        await transport.send(peerId, text);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /** The radios that reach a peer, most preferred first. */
  _routes(peerId) {
    const links = this.peers.get(peerId);
    return links ? this.transports.filter((transport) => links.has(transport)) : [];
  }

  _best(peerId) {
    const [transport] = this._routes(peerId);
    return transport ? { transport, ...this.peers.get(peerId).get(transport) } : null;
  }

  _onLinkUp(transport, peer) {
    const before = this._best(peer.id);
    if (!this.peers.has(peer.id)) this.peers.set(peer.id, new Map());
    this.peers.get(peer.id).set(transport, { name: peer.name, link: peer.link });
    const after = this._best(peer.id);
    if (!before) this.emit('peerConnected', { id: peer.id, name: after.name, link: after.link });
    else if (before.transport !== after.transport) this.emit('linkChanged', peer.id, after.link);
  }

  _onLinkDown(transport, id) {
    const links = this.peers.get(id);
    if (!links || !links.has(transport)) return;
    const before = this._best(id);
    links.delete(transport);
    if (links.size === 0) {
      this.peers.delete(id);
      this.emit('peerDisconnected', id);
      return;
    }
    const after = this._best(id);
    if (before.transport !== after.transport) this.emit('linkChanged', id, after.link);
  }

  _unsubscribe() {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
  }
}
