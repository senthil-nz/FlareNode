import NetInfo from '@react-native-community/netinfo';
import MeshBackend from './MeshBackend';
import * as SecureStore from 'expo-secure-store';
import { ServerConfig } from './ServerConfig';

const HEARTBEAT_MS = 15000;
const REQUEST_TIMEOUT_MS = 10000;

// A request with no timeout can hang forever when the network drops mid-flight,
// which would leave `syncing` set and block every later sync until restart.
const postJson = async (url, token, payload) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * CloudSyncService (Secured)
 * Handles JWT-authenticated sync to the Mothership.
 */
export const CloudSyncService = {
  started: false,
  syncing: false,
  syncQueued: false,

  async initializeCloudSync() {
    if (this.started) return;
    this.started = true;

    NetInfo.addEventListener(state => {
      if (state.isConnected) {
        this.syncToMothership();
      }
    });

    // Push every change, whether made on this phone or received over the mesh
    MeshBackend.onReady(() => {
      MeshBackend.subscribeToMarkerDocs(() => this.syncToMothership());
    });

    // Heartbeat keeps the dashboard uplink live and retries after an outage
    setInterval(() => this.syncToMothership(), HEARTBEAT_MS);
  },

  async syncToMothership() {
    if (this.syncing) {
      this.syncQueued = true;
      return;
    }
    this.syncing = true;
    try {
      // Task 3: Retrieve and attach JWT Bearer token
      const token = await SecureStore.getItemAsync('mothership_jwt');
      if (!token) {
        console.log('Cloud Sync skipped: No authenticated session found.');
        return;
      }

      const serverUrl = await ServerConfig.getUrl();
      const markers = await this.fetchAllLocalMarkers();

      const response = await postJson(`${serverUrl}/api/sync/markers`, token, markers);

      if (response.ok) {
        console.log(`Securely synced ${markers.length} markers to Mothership.`);
      } else {
        console.log(`Cloud Sync rejected by Mothership: HTTP ${response.status}`);
      }

      // Also take what the Mothership has that this phone lacks, so it relays
      // between phones that never meet.
      if (response.ok) await this.pullFromMothership(serverUrl, token);

      // Dead zones logged while cut off, so commanders can see coverage gaps.
      // Every record is sent, including cleared ones, so removals reach the server.
      const gaps = await MeshBackend.getConnectivityLogs(24 * 365);
      if (gaps.length > 0) {
        await postJson(`${serverUrl}/api/sync/gaps`, token, gaps);
      }
    } catch (error) {
      // Expected in the field: no route to the Mothership, mesh keeps working
      console.log('Cloud Sync unavailable:', error?.message || error);
    } finally {
      this.syncing = false;
      if (this.syncQueued) {
        this.syncQueued = false;
        this.syncToMothership();
      }
    }
  },

  async pullFromMothership(serverUrl, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${serverUrl}/api/sync/markers`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const held = await response.json();
      // The Mothership hands back records exactly as their authors signed
      // them. They are checked like records from any phone, so it is only a
      // carrier: it cannot add, change or remove one unnoticed.
      const taken = await MeshBackend.applyRelayed(held.certificates, [...(held.records || []), ...(held.removedRecords || [])], held.cancellations);
      if (taken > 0) console.log(`Pulled from Mothership: ${taken} records.`);
    } finally {
      clearTimeout(timer);
    }
  },

  async fetchAllLocalMarkers() {
    try {
      // Each marker goes up with its version and signature, so the
      // Mothership can hand it to other phones in a form they can check.
      // Removed markers are included so removals reach the Mothership.
      return (await MeshBackend.getAllMarkerRecords()).map((record) => ({
        ...record.fields,
        _mesh: { version: record.version, auth: record.auth },
      }));
    } catch (e) {
      console.error('Failed to fetch markers for sync:', e);
      return [];
    }
  }
};
