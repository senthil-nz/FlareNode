import { Transport } from './transport.js';
import { NearbyNative, nearbyEvents } from '../../modules/flarenode-nearby';

/**
 * Google Nearby Connections, presented as a mesh transport.
 *
 * All the radio work is in the native module (modules/flarenode-nearby).
 * This file only adapts its events and calls to the Transport interface.
 *
 * Unlike the rest of src/mesh, this file needs React Native and a phone.
 */
export class NearbyTransport extends Transport {
  constructor() {
    super();
    this.subscriptions = [];
  }

  static get available() {
    return !!NearbyNative;
  }

  get maxPayloadBytes() {
    return NearbyNative.maxPayloadBytes;
  }

  async start({ nodeId, name }) {
    if (!NearbyNative) throw new Error('Nearby Connections is not built into this app');
    this.subscriptions = [
      nearbyEvents.addListener('onPeerConnected', (peer) => this.emit('peerConnected', peer)),
      nearbyEvents.addListener('onPeerDisconnected', ({ id }) => this.emit('peerDisconnected', id)),
      nearbyEvents.addListener('onMessage', ({ id, text }) => this.emit('message', id, text)),
      nearbyEvents.addListener('onLog', ({ message }) => this.emit('log', message)),
    ];
    await NearbyNative.start(nodeId, name);
  }

  async stop() {
    if (NearbyNative) await NearbyNative.stop();
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions = [];
  }

  async send(peerId, text) {
    await NearbyNative.send(peerId, text);
  }
}
