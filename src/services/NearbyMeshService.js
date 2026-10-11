import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { MeshService } from '../mesh/meshService.js';
import { NearbyTransport } from '../mesh/nearbyTransport.js';
import { LanTransport, AwareTransport, BluetoothTransport } from '../mesh/radioTransports.js';
import { MultiTransport } from '../mesh/multiTransport.js';
import { NearbyNative } from '../../modules/flarenode-nearby';
import { deriveMeshKey, createCipher } from '../mesh/cipher.js';
import { phonePersistence } from './meshPersistence';
import { MeshIdentity } from './MeshIdentity';

/**
 * The mesh, wired up for a phone: the radios it runs on (see createTransport),
 * a SQLite database for storage, and a permanent id for this phone.
 */

const NODE_ID_KEY = 'mesh_node_id';

// Removed records are remembered this long, then dropped. A phone that was
// away for longer cannot deliver records older than this (see MeshStore.compact).
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// The id identifies this phone on the mesh for good; it is not tied to who is signed in
const getNodeId = async () => {
  let id = await SecureStore.getItemAsync(NODE_ID_KEY);
  if (!id) {
    id = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    await SecureStore.setItemAsync(NODE_ID_KEY, id);
  }
  return id;
};

// The radios the mesh runs on. The normal build uses Google Nearby Connections
// alone. The Mesh Lab build also runs FlareNode's own open-source radios, so
// they can be proven next to Nearby before they are relied on. They are
// listed fastest first, and ahead of Nearby so that they carry the traffic
// whenever they can; Nearby is the fallback.
const IS_MESH_LAB_BUILD = !!NearbyNative?.packageName?.endsWith('.meshlab');
const createTransport = () => {
  if (!IS_MESH_LAB_BUILD) return new NearbyTransport();
  const own = [LanTransport, AwareTransport, BluetoothTransport].filter((Radio) => Radio.available);
  return new MultiTransport([...own.map((Radio) => new Radio()), new NearbyTransport()]);
};

// Deriving the key is deliberately slow, so do it once per token
const keys = new Map();
const cipherForToken = async (token) => {
  if (!keys.has(token)) keys.set(token, await deriveMeshKey(token));
  return createCipher(keys.get(token), (count) => Crypto.getRandomBytes(count));
};

export default new MeshService({
  createTransport,
  createCipher: cipherForToken,
  persistence: phonePersistence(`${FileSystem.documentDirectory}mesh/store.json`),
  retentionMs: RETENTION_MS,
  // Records are signed by the responder who wrote them and checked on arrival
  getIdentity: () => MeshIdentity.current(),
  ed: MeshIdentity.ed,
  getNodeId,
});
