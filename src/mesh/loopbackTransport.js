import { Transport } from './transport.js';

/**
 * A pretend radio, for tests.
 *
 * A hub stands in for the air between phones. Tests decide which nodes are in
 * range of each other with `link` and `unlink`, which makes it easy to build
 * chains (A can reach B, B can reach C, A cannot reach C) and to split and
 * rejoin the mesh.
 */
export class LoopbackHub {
  constructor({ maxPayloadBytes = 4096, label = 'loopback' } = {}) {
    this.maxPayloadBytes = maxPayloadBytes;
    // What peers on this hub report as their link, to tell pretend radios apart
    this.label = label;
    this.transports = new Map();
    this.links = new Set();
    this.inFlight = 0;
    this.delivered = 0;
    this.waiters = [];
    this.losing = new Map();
  }

  createTransport() {
    return new LoopbackTransport(this);
  }

  /** Puts two started nodes in range of each other. */
  link(a, b) {
    const key = linkKey(a, b);
    if (this.links.has(key)) return;
    this.links.add(key);
    const first = this.transports.get(a);
    const second = this.transports.get(b);
    if (!first || !second) throw new Error('Both nodes must be started before linking');
    first.emit('peerConnected', { id: b, name: second.name, link: this.label });
    second.emit('peerConnected', { id: a, name: first.name, link: this.label });
  }

  /** Takes two nodes out of range. */
  unlink(a, b) {
    if (!this.links.delete(linkKey(a, b))) return;
    this.transports.get(a)?.emit('peerDisconnected', b);
    this.transports.get(b)?.emit('peerDisconnected', a);
  }

  /** The next `count` messages to `to` vanish, like a radio that is not ready yet. */
  loseNext(to, count) {
    this.losing.set(to, count);
  }

  linked(a, b) {
    return this.links.has(linkKey(a, b));
  }

  /**
   * Resolves once no message is on its way, i.e. the mesh has gone quiet.
   * Handling one message often queues the next a moment later, so "quiet"
   * means still nothing in flight after giving those a chance to be sent.
   */
  idle() {
    return new Promise((resolve) => {
      const check = () => setImmediate(() => {
        if (this.inFlight === 0) resolve();
        else this.waiters.push(check);
      });
      check();
    });
  }

  deliver(from, to, text) {
    this.inFlight += 1;
    setImmediate(() => {
      // A message already in the air is lost if the link drops before it lands
      const toLose = this.losing.get(to) || 0;
      if (toLose > 0) {
        this.losing.set(to, toLose - 1);
      } else if (this.linked(from, to)) {
        this.delivered += 1;
        this.transports.get(to)?.emit('message', from, text);
      }
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        // Each waiter looks again after pending sends have had their turn
        waiters.forEach((recheck) => recheck());
      }
    });
  }
}

const linkKey = (a, b) => [a, b].sort().join('|');

class LoopbackTransport extends Transport {
  constructor(hub) {
    super();
    this.hub = hub;
    this.nodeId = null;
    this.name = null;
  }

  get maxPayloadBytes() {
    return this.hub.maxPayloadBytes;
  }

  async start({ nodeId, name }) {
    this.nodeId = nodeId;
    this.name = name;
    this.hub.transports.set(nodeId, this);
  }

  async stop() {
    for (const other of [...this.hub.transports.keys()]) this.hub.unlink(this.nodeId, other);
    this.hub.transports.delete(this.nodeId);
  }

  async send(peerId, text) {
    if (Buffer.byteLength(text, 'utf8') > this.maxPayloadBytes) throw new Error('Message exceeds maxPayloadBytes');
    if (!this.hub.linked(this.nodeId, peerId)) throw new Error(`Not connected to ${peerId}`);
    this.hub.deliver(this.nodeId, peerId, text);
  }
}
