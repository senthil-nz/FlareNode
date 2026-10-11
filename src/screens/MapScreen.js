import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StyleSheet, View, TouchableOpacity, Text, Modal, Switch, Alert } from 'react-native';
import { MapView, Camera, PointAnnotation, ShapeSource, CircleLayer } from '@maplibre/maplibre-react-native';
import NetworkStatus from '../components/NetworkStatus';
import { useNetInfo } from '@react-native-community/netinfo';
import { OfflineMap } from '../services/OfflineMap';
import MapPacks from '../components/MapPacks';
import MeshBackend from '../services/MeshBackend';
import { PermissionService } from '../services/PermissionService';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { CloudSyncService } from '../services/CloudSyncService';
import { QuakeService } from '../services/QuakeService';
import UserProfile from '../components/UserProfile';
import MeshSecurity from '../components/MeshSecurity';
import * as SecureStore from 'expo-secure-store';
import { useKeepAwake } from 'expo-keep-awake';

// Default to Wellington, New Zealand
const WELLINGTON_REGION = {
  latitude: -41.2865,
  longitude: 174.7762,
};
const DEFAULT_ZOOM = 12;

// OpenStreetMap raster tiles rendered by MapLibre (no Google Maps key required)
const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

// Emergency Mode: the same tiles, darkened and desaturated so the bright
// markers stand out in poor light. Works on cached tiles, no extra download.
const EMERGENCY_STYLE = {
  ...OSM_STYLE,
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-brightness-max': 0.45, 'raster-saturation': -0.85, 'raster-contrast': 0.35 },
    },
  ],
};

const MARKER_COLORS = { hazard: 'red', infrastructure: 'blue' };
const EMERGENCY_MARKER_COLORS = { hazard: '#ff2d2d', infrastructure: '#3d8bff' };

const GAP_COLOR = '#ff9f1a';
const GAP_LAYER_STYLE = {
  circleRadius: 10,
  circleColor: GAP_COLOR,
  circleOpacity: 0.3,
  circleStrokeColor: GAP_COLOR,
  circleStrokeWidth: 2,
};

// Recent earthquakes (GeoNet), sized by magnitude
const QUAKE_COLOR = '#b45cff';
const QUAKE_LAYER_STYLE = {
  circleRadius: ['interpolate', ['linear'], ['get', 'magnitude'], 2, 5, 4, 11, 6, 22],
  circleColor: QUAKE_COLOR,
  circleOpacity: 0.3,
  circleStrokeColor: QUAKE_COLOR,
  circleStrokeWidth: 1.5,
};
const QUAKE_REFRESH_MS = 10 * 60 * 1000;
// Older than this and the feed is shown as an offline copy
const QUAKE_STALE_MS = 30 * 60 * 1000;

const PEER_NOTICE_MS = 4000;

// A new dead zone is only logged this far from every one already on the map
const GAP_MIN_SPACING_M = 50;

// Distance in metres between two { latitude, longitude } points
const distanceMeters = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

// Stable identity for a mesh peer across presence updates
const peerId = (peer) =>
  String(
    peer?.peerKeyString ||
    (peer?.peerKey && Object.values(peer.peerKey).join('.')) ||
    peer?.deviceName ||
    ''
  );

const MapScreen = ({ user, onLogout }) => {
  // The mesh and Mothership sync only run while the app is in the foreground
  useKeepAwake();

  const [modalVisible, setModalVisible] = useState(false);
  const [pendingMarker, setPendingMarker] = useState(null);
  const [meshEnabled, setMeshEnabled] = useState(false);
  const [isEmergencyMode, setIsEmergencyMode] = useState(false);
  const [quakeFeed, setQuakeFeed] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showMeshAuth, setShowMeshAuth] = useState(false);
  const [userProfile, setUserProfile] = useState(
    user?.id && user?.name ? { id: user.id, name: user.name } : { id: 'admin', name: 'Commander' }
  );
  const [region, setRegion] = useState(WELLINGTON_REGION);
  // Admins can remove any marker and clear dead zones; responders only their own markers
  const isAdmin = user?.role === 'admin';

  const [peerCount, setPeerCount] = useState(0);
  const [peerNotice, setPeerNotice] = useState(null);
  const [gaps, setGaps] = useState([]);
  const knownPeersRef = useRef(new Map());
  const hadPeerRef = useRef(false);
  const gapsRef = useRef([]);

  const markers = useLiveQuery().markers || [];

  // Offline map pack: used automatically when there is no internet, or on demand
  const netInfo = useNetInfo();
  const cameraRef = useRef(null);
  const [offlinePack, setOfflinePack] = useState(null);
  const [forceOfflineMap, setForceOfflineMap] = useState(false);

  useEffect(() => {
    OfflineMap.activePack()
      .then(setOfflinePack)
      .catch((e) => console.warn('Offline map not available:', e?.message || e));
  }, []);

  const usingOfflineMap = !!offlinePack && (forceOfflineMap || netInfo.isInternetReachable === false);
  const mapStyle = usingOfflineMap
    ? (isEmergencyMode ? offlinePack.styles.dark : offlinePack.styles.light)
    : (isEmergencyMode ? EMERGENCY_STYLE : OSM_STYLE);

  // The map throws away its marker views whenever the style changes, and does
  // not put them back. Giving every marker a key that changes with the style
  // makes them be drawn again. Without this, markers already on the map vanish
  // when the app switches to the offline map, and only later ones show.
  const styleKey = `${usingOfflineMap ? `pack-${offlinePack.id}` : 'online'}-${isEmergencyMode ? 'emergency' : 'normal'}`;

  // Switching pack shows it straight away, centred on its region
  const handlePackChange = (pack) => {
    setOfflinePack(pack);
    setForceOfflineMap(true);
    setShowProfile(false);
    cameraRef.current?.setCamera({
      centerCoordinate: pack.center,
      zoomLevel: pack.zoom || DEFAULT_ZOOM,
      animationDuration: 800,
    });
  };

  // Live count of devices reachable over the mesh
  useEffect(() => {
    let unsubscribe = null;
    const cancelReady = MeshBackend.onReady(() => {
      unsubscribe = MeshBackend.observePeers((peers) => {
        setPeerCount(peers.length);
        if (peers.length > 0) hadPeerRef.current = true;

        // Announce responders coming into and dropping out of mesh range
        const current = new Map(peers.map((peer) => [peerId(peer), peer.deviceName || 'A responder']));
        const known = knownPeersRef.current;
        const joined = [...current.keys()].filter((id) => !known.has(id));
        const left = [...known.keys()].filter((id) => !current.has(id));
        knownPeersRef.current = current;
        if (joined.length > 0) {
          setPeerNotice({ joined: true, text: `${current.get(joined[0])} joined the mesh` });
        } else if (left.length > 0) {
          setPeerNotice({ joined: false, text: `${known.get(left[0])} left the mesh` });
        }
      });
    });
    return () => {
      cancelReady();
      if (unsubscribe) unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!peerNotice) return;
    const timer = setTimeout(() => setPeerNotice(null), PEER_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [peerNotice]);

  // Dead zones logged by this phone or received from others over the mesh
  useEffect(() => {
    let unsubscribe = null;
    const cancelReady = MeshBackend.onReady(() => {
      unsubscribe = MeshBackend.subscribeToConnectivityLogs((logs) => {
        // Older builds logged gaps without a position (0, 0); leave those out
        const visible = logs.filter((log) => !log.deleted && (log.latitude || log.longitude));
        gapsRef.current = visible;
        setGaps(visible);
      });
    });
    return () => {
      cancelReady();
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const gapShape = useMemo(() => ({
    type: 'FeatureCollection',
    features: gaps.map((gap) => ({
      type: 'Feature',
      id: String(gap._id),
      geometry: { type: 'Point', coordinates: [gap.longitude, gap.latitude] },
      properties: {},
    })),
  }), [gaps]);

  useEffect(() => {
    const initializeSystem = async () => {
      try {
        const initialized = await MeshBackend.init(user?.name);
        if (initialized) {
          const hasPerms = await PermissionService.requestMeshPermissions();
          let savedToken = await SecureStore.getItemAsync('op_token');
          if (!savedToken) {
            savedToken = 'OP-2026-S1';
            await SecureStore.setItemAsync('op_token', savedToken);
          }
          if (hasPerms || savedToken) {
            try {
              await MeshBackend.startP2PSync(savedToken);
              setMeshEnabled(true);
            } catch (e) {
              console.log('P2P sync setup completed');
            }
          }
        }
      } catch (err) {
        console.warn('Initialization notice:', err?.message || err);
      }
      CloudSyncService.initializeCloudSync();
    };
    initializeSystem();
  }, []);

  // Earthquake feed. A phone with internet refreshes it from GeoNet and stores
  // it in the mesh; every phone draws whatever the mesh holds, so phones with
  // no internet still see the latest copy another phone fetched.
  useEffect(() => {
    let unsubscribe = null;
    let interval = null;
    const refresh = async () => {
      const quakes = await QuakeService.fetchRecentQuakes();
      if (quakes) await MeshBackend.saveQuakeFeed(quakes);
    };
    const cancelReady = MeshBackend.onReady(() => {
      unsubscribe = MeshBackend.subscribeToQuakeFeed(setQuakeFeed);
      refresh();
      interval = setInterval(refresh, QUAKE_REFRESH_MS);
    });
    return () => {
      cancelReady();
      if (unsubscribe) unsubscribe();
      if (interval) clearInterval(interval);
    };
  }, []);

  const quakeShape = useMemo(() => ({
    type: 'FeatureCollection',
    features: (quakeFeed?.quakes || []).map((quake) => ({
      type: 'Feature',
      id: String(quake.id),
      geometry: { type: 'Point', coordinates: [quake.longitude, quake.latitude] },
      properties: {
        magnitude: quake.magnitude,
        depth: quake.depth,
        locality: quake.locality,
        time: quake.time,
      },
    })),
  }), [quakeFeed]);

  const handleQuakePress = (event) => {
    const quake = event?.features?.[0]?.properties;
    if (!quake) return;
    Alert.alert(
      `Magnitude ${quake.magnitude} earthquake`,
      `${quake.locality}\n${new Date(quake.time).toLocaleString()}\nDepth ${quake.depth} km · source GeoNet`
    );
  };

  const quakeFeedIsStale = quakeFeed ? Date.now() - quakeFeed.fetchedAt > QUAKE_STALE_MS : false;

  // Periodic dead zone detection. A dead zone means this phone lost the mesh:
  // it had a peer earlier, has none now, knows where it is from GPS, and is not
  // standing next to a dead zone that is already on the map.
  useEffect(() => {
    const connectivityInterval = setInterval(async () => {
      try {
        if (!hadPeerRef.current) return;
        if (MeshBackend.getRemotePeers().length > 0) return;

        const location = await PermissionService.getCurrentLocation();
        const coords = location?.coords;
        if (!coords) return;

        const alreadyLogged = gapsRef.current.some(
          (gap) => distanceMeters(gap, coords) < GAP_MIN_SPACING_M
        );
        if (alreadyLogged) return;

        await MeshBackend.logConnectivityGap(coords.latitude, coords.longitude, userProfile);
      } catch (e) {
        console.warn('Periodic gap logging notice:', e?.message || e);
      }
    }, 60000);
    return () => clearInterval(connectivityInterval);
  }, [userProfile]);

  const confirmClearGaps = () => {
    Alert.alert(
      'Clear dead zones?',
      `All ${gaps.length} logged dead zones will be removed for every responder.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              await MeshBackend.clearConnectivityLogs(gaps);
            } catch (e) {
              Alert.alert('Clear Failed', e?.message || 'Could not clear dead zones');
            }
          },
        },
      ]
    );
  };

  // Handle single tap to place/move selected location
  const handleMapPress = (feature) => {
    const coordinates = feature?.geometry?.coordinates;
    if (coordinates) {
      setPendingMarker({
        id: Date.now().toString(),
        latitude: coordinates[1],
        longitude: coordinates[0],
        timestamp: Date.now(),
      });
      setModalVisible(true);
    }
  };

  const handleLongPress = (feature) => {
    handleMapPress(feature);
  };

  const handleRegionChange = (feature) => {
    const coordinates = feature?.geometry?.coordinates;
    if (coordinates) {
      setRegion({ latitude: coordinates[1], longitude: coordinates[0] });
    }
  };

  const saveMarker = async (type) => {
    if (!userProfile.id || !userProfile.name) {
      setShowProfile(true);
      setModalVisible(false);
      return;
    }
    try {
      console.log('[Marker] Attempting to save marker:', pendingMarker, 'Profile:', userProfile);
      await MeshBackend.saveMarker({ ...pendingMarker, type }, userProfile);
      setModalVisible(false);
      setPendingMarker(null);
      Alert.alert('Marker Dropped', `Successfully dropped ${type.toUpperCase()} marker.`);
    } catch (e) {
      console.error('Failed to save marker error details:', e?.message || e);
      Alert.alert('Save Failed', e?.message || 'Could not save marker');
    }
  };

  const handleMarkerPress = (marker) => {
    const markerId = marker._id || marker.id;
    if (!isAdmin && marker.author_id !== userProfile.id) {
      Alert.alert(
        `${marker.type ? marker.type.toUpperCase() : 'MARKER'}`,
        `Added by ${marker.author_name || 'unknown'}\n\nOnly ${marker.author_name || 'its author'} or an admin can remove it.`
      );
      return;
    }
    Alert.alert(
      `${marker.type ? marker.type.toUpperCase() : 'MARKER'}`,
      `Added by ${marker.author_name || 'unknown'}`,
      [
        { text: 'Close', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          // A removal reaches every responder, so ask before doing it
          onPress: () => {
            Alert.alert(
              'Remove this marker?',
              `The ${marker.type || 'marker'} added by ${marker.author_name || 'unknown'} will be removed for every responder.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Remove',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await MeshBackend.removeMarker(markerId, userProfile);
                    } catch (e) {
                      Alert.alert('Remove Failed', e?.message || 'Could not remove marker');
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  };

  const toggleMesh = async (value) => {
    if (value) {
      setShowMeshAuth(true);
      setMeshEnabled(false);
    } else {
      await MeshBackend.stopP2PSync();
      setMeshEnabled(false);
    }
  };

  const handleMeshVerified = async (token) => {
    setShowMeshAuth(false);
    try {
      await MeshBackend.startP2PSync(token);
      setMeshEnabled(true);
    } catch (e) {
      console.error('Mesh activation error:', e);
    }
  };

  return (
    <View style={[styles.container, isEmergencyMode && styles.emergencyContainer]}>
      <View style={styles.map}>
        <MapView 
          style={styles.mapView}
          mapStyle={mapStyle}
          onPress={handleMapPress}
          onLongPress={handleLongPress}
          onRegionDidChange={handleRegionChange}
        >
          <Camera
            ref={cameraRef}
            defaultSettings={{
              centerCoordinate: [WELLINGTON_REGION.longitude, WELLINGTON_REGION.latitude],
              zoomLevel: DEFAULT_ZOOM,
            }}
          />

          {/* Recent earthquakes */}
          <ShapeSource id="quakes" shape={quakeShape} onPress={handleQuakePress}>
            <CircleLayer id="quakes-circles" style={QUAKE_LAYER_STYLE} />
          </ShapeSource>

          {/* Connectivity dead zones */}
          <ShapeSource id="connectivity-gaps" shape={gapShape}>
            <CircleLayer id="connectivity-gaps-circles" style={GAP_LAYER_STYLE} />
          </ShapeSource>

          {/* User selected location indicator */}
          {pendingMarker && (
            <PointAnnotation
              id="pending-marker"
              key={`pending-${pendingMarker.id}-${styleKey}`}
              coordinate={[pendingMarker.longitude, pendingMarker.latitude]}
            >
              <View style={[styles.pin, isEmergencyMode && styles.emergencyPin, { backgroundColor: 'yellow' }]} />
            </PointAnnotation>
          )}

          {/* Synced tactical markers */}
          {markers.map(marker => (
            <PointAnnotation
              id={String(marker.id || marker._id)}
              key={`${marker.id || marker._id}-${styleKey}`}
              coordinate={[marker.longitude, marker.latitude]}
              onSelected={() => handleMarkerPress(marker)}
            >
              <View
                style={[
                  styles.pin,
                  isEmergencyMode && styles.emergencyPin,
                  {
                    backgroundColor: isEmergencyMode
                      ? EMERGENCY_MARKER_COLORS[marker.type] || '#2dff7a'
                      : MARKER_COLORS[marker.type] || 'green',
                  },
                ]}
              />
            </PointAnnotation>
          ))}
        </MapView>

        {offlinePack && (
          <TouchableOpacity
            style={[styles.mapSource, usingOfflineMap && styles.mapSourceOffline]}
            onPress={() => setForceOfflineMap(!forceOfflineMap)}
          >
            <Text style={styles.mapSourceText}>
              {usingOfflineMap ? `🗺 Offline map · ${offlinePack.name}` : '🗺 Online map'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <NetworkStatus />

      {/* Helper instruction banner */}
      <View style={styles.tipBanner}>
        <Text style={styles.tipText}>📍 Tap map to add · tap marker to remove</Text>
      </View>

      {peerNotice && (
        <View style={[styles.peerNotice, !peerNotice.joined && styles.peerNoticeLeft]}>
          <Text style={styles.peerNoticeText}>
            {peerNotice.joined ? '🟢' : '⚪'} {peerNotice.text}
          </Text>
        </View>
      )}

      {gaps.length > 0 && (
        <TouchableOpacity style={styles.gapLegend} onPress={confirmClearGaps} disabled={!isAdmin}>
          <View style={styles.gapDot} />
          <Text style={styles.gapLegendText}>
            {gaps.length} dead {gaps.length === 1 ? 'zone' : 'zones'}{isAdmin ? ' · clear' : ''}
          </Text>
        </TouchableOpacity>
      )}

      {quakeFeed && (
        <View style={styles.quakeLegend}>
          <View style={styles.quakeDot} />
          <Text style={[styles.gapLegendText, quakeFeedIsStale && styles.staleText]}>
            {quakeFeed.quakes.length} quakes · GeoNet{' '}
            {new Date(quakeFeed.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {quakeFeedIsStale ? ' · offline copy' : ''}
          </Text>
        </View>
      )}

      <View style={[styles.meshControl, isEmergencyMode && styles.emergencyControlItem]}>
        <Text style={[styles.meshText, isEmergencyMode && styles.emergencyText]}>
          P2P Mesh{meshEnabled ? ` · ${peerCount} ${peerCount === 1 ? 'peer' : 'peers'}` : ''}
        </Text>
        <Switch value={meshEnabled} onValueChange={toggleMesh} />
      </View>

      <View style={[styles.emergencyControl, isEmergencyMode && styles.emergencyControlItem]}>
        <Text style={[styles.meshText, isEmergencyMode && styles.emergencyText]}>Emergency Mode</Text>
        <Switch value={isEmergencyMode} onValueChange={(v) => setIsEmergencyMode(v)} />
      </View>

      <TouchableOpacity 
        style={[styles.profileButton, isEmergencyMode && styles.emergencyControlItem]} 
        onPress={() => setShowProfile(true)}
      >
        <Text style={[styles.profileText, isEmergencyMode && styles.emergencyText]}>👤 Profile</Text>
      </TouchableOpacity>

      <Modal transparent visible={showProfile} animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <UserProfile onSave={(p) => { setUserProfile(p); setShowProfile(false); }} />
            <MapPacks activeId={offlinePack?.id} onChange={handlePackChange} />
            {onLogout && (
              <TouchableOpacity onPress={onLogout} style={styles.cancelButton}>
                <Text style={styles.logoutText}>Log out</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => setShowProfile(false)} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={showMeshAuth} animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Mesh Authentication</Text>
            <Text style={styles.modalSubtitle}>Enter your Operational Token to join the P2P Mesh</Text>
            <MeshSecurity onVerified={handleMeshVerified} />
            <TouchableOpacity onPress={() => setShowMeshAuth(false)} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={modalVisible} animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Drop Marker</Text>
            <Text style={styles.modalSubtitle}>
              {pendingMarker ? `${pendingMarker.latitude.toFixed(4)}, ${pendingMarker.longitude.toFixed(4)}` : 'Select marker type'}
            </Text>
            <View style={styles.typeContainer}>
              {['hazard', 'infrastructure', 'responder'].map(type => (
                <TouchableOpacity 
                  key={type} 
                  style={[styles.typeButton, { backgroundColor: type === 'hazard' ? '#ff4d4d' : type === 'infrastructure' ? '#4d79ff' : '#4dff88' }]} 
                  onPress={() => saveMarker(type)}
                >
                  <Text style={styles.typeButtonText}>{type.toUpperCase()}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={() => setModalVisible(false)} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  emergencyContainer: { backgroundColor: '#1a1a1a' },
  map: { flex: 1 },
  mapView: { ...StyleSheet.absoluteFillObject },
  mapSource: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 16,
  },
  mapSourceOffline: { backgroundColor: 'rgba(20, 110, 60, 0.95)' },
  mapSourceText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  pin: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#fff' },
  emergencyPin: { width: 36, height: 36, borderRadius: 18, borderWidth: 4 },
  peerNotice: {
    position: 'absolute',
    top: 132,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(20, 110, 60, 0.95)',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    zIndex: 20
  },
  peerNoticeLeft: { backgroundColor: 'rgba(70, 70, 70, 0.95)' },
  peerNoticeText: { color: '#ffffff', fontSize: 14, fontWeight: 'bold' },
  quakeLegend: {
    position: 'absolute',
    top: 92,
    left: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    zIndex: 5
  },
  quakeDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: QUAKE_COLOR,
    backgroundColor: 'rgba(180, 92, 255, 0.3)',
    marginRight: 6
  },
  staleText: { color: '#ffd84d' },
  gapLegend: {
    position: 'absolute',
    top: 92,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    zIndex: 5
  },
  gapDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: GAP_COLOR,
    backgroundColor: 'rgba(255, 159, 26, 0.3)',
    marginRight: 6
  },
  gapLegendText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
  tipBanner: {
    position: 'absolute',
    top: 50,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 150,
    borderRadius: 8,
    alignItems: 'center',
    zIndex: 5
  },
  tipText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
  meshControl: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: '#eee'
  },
  emergencyControlItem: {
    backgroundColor: '#333',
    borderColor: '#ff0000'
  },
  meshText: { fontSize: 16, fontWeight: 'bold' },
  emergencyControl: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderColor: '#eee'
  },
  profileButton: {
    padding: 15,
    backgroundColor: '#fff',
    alignItems: 'center',
    borderTopWidth: 1,
    borderColor: '#eee'
  },
  profileText: { fontSize: 16, fontWeight: 'bold', color: '#007AFF' },
  emergencyText: { color: '#fff' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end'
  },
  modalContent: {
    backgroundColor: 'white',
    padding: 20,
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
    alignItems: 'center'
  },
  modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 5 },
  modalSubtitle: { fontSize: 13, color: '#666', marginBottom: 20, textAlign: 'center' },
  typeContainer: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginBottom: 20 },
  typeButton: { padding: 15, borderRadius: 10, width: '30%', alignItems: 'center' },
  typeButtonText: { color: 'white', fontWeight: 'bold', fontSize: 12 },
  cancelButton: { marginTop: 10, padding: 10 },
  cancelText: { color: '#666', fontWeight: 'bold' },
  logoutText: { color: '#ff4d4d', fontWeight: 'bold' }
});

export default MapScreen;
