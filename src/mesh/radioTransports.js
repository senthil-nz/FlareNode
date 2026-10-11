import { Transport } from './transport.js';
import { Lan, Aware, Bluetooth } from '../../modules/flarenode-radio';

/**
 * FlareNode's own radios, presented as mesh transports. None of them depends
 * on Google Play services; they use what Android itself provides.
 *
 *   LanTransport        phones on the same Wi-Fi network, or one phone's hotspot
 *   AwareTransport      Wi-Fi Aware: direct Wi-Fi between phones, no router
 *   BluetoothTransport  Bluetooth Low Energy: no network of any kind
 *
 * The radio work is in the native module (modules/flarenode-radio). Each
 * native radio offers the same three calls and four events, so one adapter
 * fits them all.
 *
 * Unlike the rest of src/mesh, this file needs React Native and a phone.
 */
const radioTransport = ({ native, events }, description) => class extends Transport {
  constructor() {
    super();
    this.subscriptions = [];
  }

  static get available() {
    return !!native;
  }

  get maxPayloadBytes() {
    return native.maxPayloadBytes;
  }

  async start({ nodeId, name }) {
    if (!native) throw new Error(`${description} is not built into this app`);
    this.subscriptions = [
      events.addListener('onPeerConnected', (peer) => this.emit('peerConnected', peer)),
      events.addListener('onPeerDisconnected', ({ id }) => this.emit('peerDisconnected', id)),
      events.addListener('onMessage', ({ id, text }) => this.emit('message', id, text)),
      events.addListener('onLog', ({ message }) => this.emit('log', message)),
    ];
    try {
      await native.start(nodeId, name);
    } catch (error) {
      this._unsubscribe();
      throw error;
    }
  }

  async stop() {
    if (native) await native.stop();
    this._unsubscribe();
  }

  async send(peerId, text) {
    await native.send(peerId, text);
  }

  _unsubscribe() {
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions = [];
  }
};

export const LanTransport = radioTransport(Lan, 'The local network transport');
export const AwareTransport = radioTransport(Aware, 'The Wi-Fi Aware transport');
export const BluetoothTransport = radioTransport(Bluetooth, 'The Bluetooth transport');
