import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { OfflineMap } from '../services/OfflineMap';

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;

/**
 * Lists the offline map packs on this phone and those the Mothership offers,
 * and lets the responder switch, download or delete them.
 */
const MapPacks = ({ activeId, onChange }) => {
  const [installed, setInstalled] = useState([]);
  const [available, setAvailable] = useState([]);
  const [serverNote, setServerNote] = useState('Checking the Mothership…');
  const [progress, setProgress] = useState({});

  const refresh = useCallback(async () => {
    const onPhone = await OfflineMap.installedPacks();
    setInstalled(onPhone);
    try {
      const offered = await OfflineMap.availablePacks();
      const missing = offered.filter((pack) => !onPhone.some((have) => have.id === pack.id));
      setAvailable(missing);
      setServerNote(offered.length === 0 ? 'The Mothership has no map packs.' : missing.length === 0 ? 'All Mothership packs are on this phone.' : '');
    } catch (error) {
      setAvailable([]);
      setServerNote('Mothership not reachable. Connect to download more regions.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const use = async (id) => onChange(await OfflineMap.setActive(id));

  const download = async (pack) => {
    setProgress((current) => ({ ...current, [pack.id]: 0 }));
    try {
      await OfflineMap.download(pack, (fraction) => setProgress((current) => ({ ...current, [pack.id]: fraction })));
      await use(pack.id);
    } catch (error) {
      Alert.alert('Download failed', error?.message || 'Could not download the map pack');
    } finally {
      setProgress((current) => {
        const { [pack.id]: finished, ...rest } = current;
        return rest;
      });
      refresh();
    }
  };

  const remove = (pack) => {
    Alert.alert('Delete map pack?', `${pack.name} will be removed from this phone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await OfflineMap.remove(pack.id);
          if (pack.id === activeId) onChange(await OfflineMap.activePack());
          refresh();
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Offline map</Text>

      {installed.map((pack) => (
        <View key={pack.id} style={styles.row}>
          <View style={styles.info}>
            <Text style={styles.name}>{pack.name}</Text>
            <Text style={styles.detail}>
              {megabytes(pack.bytes)}{pack.bundled ? ' · built in' : ''}
            </Text>
          </View>
          {pack.id === activeId ? (
            <Text style={styles.active}>In use</Text>
          ) : (
            <TouchableOpacity style={styles.button} onPress={() => use(pack.id)}>
              <Text style={styles.buttonText}>Use</Text>
            </TouchableOpacity>
          )}
          {!pack.bundled && (
            <TouchableOpacity style={styles.button} onPress={() => remove(pack)}>
              <Text style={styles.deleteText}>Delete</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}

      {available.map((pack) => (
        <View key={pack.id} style={styles.row}>
          <View style={styles.info}>
            <Text style={styles.name}>{pack.name}</Text>
            <Text style={styles.detail}>{megabytes(pack.bytes)} · on the Mothership</Text>
          </View>
          {progress[pack.id] !== undefined ? (
            <View style={styles.progress}>
              <ActivityIndicator size="small" color="#007AFF" />
              <Text style={styles.detail}> {Math.round(progress[pack.id] * 100)}%</Text>
            </View>
          ) : (
            <TouchableOpacity style={styles.button} onPress={() => download(pack)}>
              <Text style={styles.buttonText}>Download</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}

      {!!serverNote && <Text style={styles.note}>{serverNote}</Text>}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { width: '100%', paddingHorizontal: 20, paddingBottom: 6 },
  title: { fontSize: 14, color: '#666', marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderColor: '#eee' },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 12, color: '#888' },
  active: { fontSize: 13, fontWeight: '700', color: '#1b8a4b', paddingHorizontal: 10 },
  button: { paddingVertical: 6, paddingHorizontal: 10 },
  buttonText: { fontSize: 13, fontWeight: '700', color: '#007AFF' },
  deleteText: { fontSize: 13, fontWeight: '700', color: '#ff4d4d' },
  progress: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10 },
  note: { fontSize: 12, color: '#888', marginTop: 6 },
});

export default MapPacks;
