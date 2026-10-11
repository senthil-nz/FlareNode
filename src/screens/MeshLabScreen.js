import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, ScrollView } from 'react-native';
import { useNetInfo } from '@react-native-community/netinfo';
import * as SecureStore from 'expo-secure-store';
import { useKeepAwake } from 'expo-keep-awake';
import { PermissionService } from '../services/PermissionService';
import { MeshStore } from '../mesh/store.js';
import { SyncEngine } from '../mesh/syncEngine.js';
import { NearbyTransport } from '../mesh/nearbyTransport.js';

/**
 * Mesh Lab: a bench for the mesh.
 *
 * Runs the real sync engine (src/mesh) over Google Nearby Connections with
 * nothing else in the way: no login, no map. Two phones running
 * this should find each other with every network off and exchange notes.
 *
 * Notes live in memory only, so they are gone when the mesh is stopped.
 */

const NODE_ID_KEY = 'mesh_lab_node_id';
const NAME_KEY = 'mesh_lab_name';
const COLLECTION = 'lab_notes';
const MAX_LOG_LINES = 60;

const randomId = () => Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const clock = (millis) => new Date(millis).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const MeshLabScreen = ({ onClose }) => {
  useKeepAwake();
  const netInfo = useNetInfo();

  const [nodeId, setNodeId] = useState(null);
  const [name, setName] = useState('');
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [peers, setPeers] = useState([]);
  const [notes, setNotes] = useState([]);
  const [log, setLog] = useState([]);
  const mesh = useRef(null);

  const addLog = (message) =>
    setLog((lines) => [`${clock(Date.now())}  ${message}`, ...lines].slice(0, MAX_LOG_LINES));

  useEffect(() => {
    (async () => {
      let id = await SecureStore.getItemAsync(NODE_ID_KEY);
      if (!id) {
        id = randomId();
        await SecureStore.setItemAsync(NODE_ID_KEY, id);
      }
      setNodeId(id);
      setName((await SecureStore.getItemAsync(NAME_KEY)) || `Phone ${id.slice(0, 4)}`);
    })();
    return () => {
      mesh.current?.engine.stop().catch(() => {});
    };
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      if (!NearbyTransport.available) throw new Error('Nearby Connections is not built into this app');
      await SecureStore.setItemAsync(NAME_KEY, name);
      const granted = await PermissionService.requestMeshPermissions();
      if (!granted) addLog('Bluetooth / nearby-devices permission was not fully granted');

      const store = new MeshStore({ nodeId });
      const transport = new NearbyTransport();
      const engine = new SyncEngine({ store, transport, nodeId, name });
      transport.on('log', addLog);
      engine.observePeers(setPeers);
      store.observe(COLLECTION, (docs) => setNotes([...docs].sort((a, b) => b.at - a.at)));
      await engine.start();

      mesh.current = { store, engine };
      setRunning(true);
      addLog(`mesh started as ${name} (${nodeId})`);
    } catch (error) {
      addLog(`START FAILED: ${error?.message || error}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await mesh.current?.engine.stop();
    } catch (error) {
      addLog(`stop failed: ${error?.message || error}`);
    }
    mesh.current = null;
    setRunning(false);
    setPeers([]);
    setNotes([]);
    addLog('mesh stopped');
    setBusy(false);
  };

  const sendNote = () => {
    const at = Date.now();
    mesh.current.store.upsert(COLLECTION, {
      _id: `${nodeId}-${at}`,
      text: `Hello from ${name}`,
      from: name,
      fromId: nodeId,
      at,
    });
  };

  const network =
    netInfo.isInternetReachable === false || netInfo.isConnected === false
      ? 'No internet'
      : `Internet via ${netInfo.type || 'unknown'}`;

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Text style={[styles.title, styles.grow]}>Mesh test bench</Text>
        {onClose && (
          <TouchableOpacity
            onPress={async () => {
              if (mesh.current) await stop();
              onClose();
            }}
            disabled={busy}
          >
            <Text style={styles.close}>Close</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.subtitle}>Sync engine over Google Nearby Connections · {network}</Text>

      <View style={styles.row}>
        <TextInput
          style={[styles.input, running && styles.inputLocked]}
          value={name}
          onChangeText={setName}
          editable={!running}
          placeholder="Name shown to other phones"
          placeholderTextColor="#7d8a99"
        />
        <TouchableOpacity
          style={[styles.button, running ? styles.stop : styles.start, (busy || !nodeId) && styles.disabled]}
          onPress={running ? stop : start}
          disabled={busy || !nodeId}
        >
          <Text style={styles.buttonText}>{running ? 'Stop' : 'Start mesh'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.detail}>Node id: {nodeId || '…'}</Text>

      <Text style={styles.heading}>Connected phones ({peers.length})</Text>
      {peers.length === 0 ? (
        <Text style={styles.empty}>{running ? 'Searching…' : 'Mesh is stopped'}</Text>
      ) : (
        peers.map((peer) => (
          <Text key={peer.id} style={styles.peer}>🟢 {peer.name} · {peer.id} · {peer.link}</Text>
        ))
      )}

      <View style={styles.row}>
        <Text style={[styles.heading, styles.grow]}>Notes ({notes.length})</Text>
        <TouchableOpacity style={[styles.button, styles.send, !running && styles.disabled]} onPress={sendNote} disabled={!running}>
          <Text style={styles.buttonText}>Send a note</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.notes}>
        {notes.length === 0 && <Text style={styles.empty}>No notes yet</Text>}
        {notes.map((note) => (
          <Text key={note._id} style={[styles.note, note.fromId === nodeId && styles.own]}>
            {clock(note.at)}  {note.fromId === nodeId ? 'You' : note.from}: {note.text}
          </Text>
        ))}
      </ScrollView>

      <Text style={styles.heading}>Log</Text>
      <ScrollView style={styles.log}>
        {log.map((line, index) => (
          <Text key={`${index}-${line}`} style={styles.logLine}>{line}</Text>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f14', paddingHorizontal: 16, paddingTop: 54, paddingBottom: 16 },
  title: { color: '#ffffff', fontSize: 22, fontWeight: 'bold' },
  close: { color: '#7fb8ff', fontSize: 15, fontWeight: '700', padding: 6 },
  subtitle: { color: '#8b98a5', fontSize: 12, marginTop: 2, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center' },
  grow: { flex: 1 },
  input: { flex: 1, backgroundColor: '#161d26', color: '#ffffff', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#2a3441', marginRight: 10 },
  inputLocked: { color: '#8b98a5' },
  button: { paddingVertical: 11, paddingHorizontal: 16, borderRadius: 8 },
  start: { backgroundColor: '#1b8a4b' },
  stop: { backgroundColor: '#b23b3b' },
  send: { backgroundColor: '#1e88ff' },
  disabled: { opacity: 0.4 },
  buttonText: { color: '#ffffff', fontWeight: '700', fontSize: 14 },
  detail: { color: '#8b98a5', fontSize: 12, marginTop: 6 },
  heading: { color: '#8b98a5', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 18, marginBottom: 6 },
  empty: { color: '#5f6b78', fontSize: 13 },
  peer: { color: '#e6edf3', fontSize: 14, paddingVertical: 2 },
  notes: { flexGrow: 0, maxHeight: 190 },
  note: { color: '#e6edf3', fontSize: 14, paddingVertical: 3 },
  own: { color: '#7fb8ff' },
  log: { flex: 1, backgroundColor: '#11161d', borderRadius: 8, padding: 8 },
  logLine: { color: '#9fb0c0', fontSize: 11, fontFamily: 'monospace', paddingVertical: 1 },
});

export default MeshLabScreen;
