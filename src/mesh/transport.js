import { Emitter } from './emitter.js';

/**
 * The line between "the mesh" and "the radio".
 *
 * Everything above this file (store, sync engine, the app) is the same no
 * matter how phones reach each other. A transport is the only part that knows
 * about Bluetooth, Wi-Fi or any particular library, and it does just five
 * things:
 *
 *   start({ nodeId, name })     begin advertising and looking for peers
 *   stop()                      stop, and drop every connection
 *   send(peerId, text)          deliver a text message to a connected peer
 *   maxPayloadBytes             the largest message `send` accepts
 *
 *   events
 *     'peerConnected'    { id, name, link }   a peer is ready to exchange messages
 *     'peerDisconnected' id
 *     'message'          peerId, text
 *     'log'              text                 optional, for diagnostics
 *
 * Rules a transport must keep:
 *
 * - `id` is the peer's own mesh node id (the one it passed to `start`), not a
 *   connection handle that changes between sessions. If the radio library
 *   only gives temporary handles, the transport maps them.
 * - `send` either delivers the whole message or rejects. It never delivers
 *   part of one, and messages to one peer arrive in the order they were sent.
 * - Messages are text. The sync engine sends JSON; a transport that moves
 *   bytes encodes it as UTF-8.
 * - `link` is a short label for display only ('bluetooth', 'wifi', 'loopback').
 *
 * Transports:
 *   LoopbackTransport   in-memory, for tests (this folder)
 *   NearbyTransport     Google Nearby Connections (what the app uses today)
 *   MultiTransport      several of these at once, shown to the engine as one
 *   open-source ones    local Wi-Fi and Bluetooth, to replace Nearby (planned)
 */
export class Transport extends Emitter {
  get maxPayloadBytes() {
    throw new Error('Transport must define maxPayloadBytes');
  }

  // eslint-disable-next-line no-unused-vars
  async start({ nodeId, name }) {
    throw new Error('Transport must implement start');
  }

  async stop() {
    throw new Error('Transport must implement stop');
  }

  // eslint-disable-next-line no-unused-vars
  async send(peerId, text) {
    throw new Error('Transport must implement send');
  }
}
