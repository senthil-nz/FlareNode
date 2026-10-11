import React, { useState, useEffect, useRef } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import AppLock from './src/components/AppLock';
import LoginScreen from './src/components/LoginScreen';
import MapScreen from './src/screens/MapScreen';
import SaliencyToast from './src/components/SaliencyToast';
import { useSaliencyAlerts } from './src/hooks/useSaliencyAlerts';
import MeshLabScreen from './src/screens/MeshLabScreen';
import { IS_MESH_LAB_BUILD } from './src/services/MeshBackend';

// Away from the app for longer than this (phone locked, another app in front)
// and the fingerprint is asked for again
const RELOCK_AFTER_MS = 5000;

function FlareNodeApp({ onOpenBench }) {
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [hasUnlockedOnce, setHasUnlockedOnce] = useState(false);
  const isUnlockedRef = useRef(false);
  const backgroundedAtRef = useRef(null);
  const [user, setUser] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const { alert, clearAlert } = useSaliencyAlerts(user?.id);

  // Restore the saved login so responders are not asked again on every start
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const token = await SecureStore.getItemAsync('mothership_jwt');
        const id = await SecureStore.getItemAsync('user_id');
        const name = await SecureStore.getItemAsync('user_name');
        const role = await SecureStore.getItemAsync('user_role');
        if (token && id && name) setUser({ id, name, role: role || 'responder' });
      } finally {
        setSessionChecked(true);
      }
    };
    restoreSession();
  }, []);

  useEffect(() => {
    isUnlockedRef.current = isUnlocked;
  }, [isUnlocked]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        const leftAt = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        if (leftAt !== null && Date.now() - leftAt > RELOCK_AFTER_MS) setIsUnlocked(false);
      } else if (backgroundedAtRef.current === null && isUnlockedRef.current) {
        // Not timed while locked: the fingerprint prompt itself takes focus
        backgroundedAtRef.current = Date.now();
      }
    });
    return () => subscription.remove();
  }, []);

  const handleUnlock = () => {
    setIsUnlocked(true);
    setHasUnlockedOnce(true);
  };

  const handleLogout = async () => {
    await SecureStore.deleteItemAsync('mothership_jwt');
    await SecureStore.deleteItemAsync('user_id');
    await SecureStore.deleteItemAsync('user_name');
    await SecureStore.deleteItemAsync('user_role');
    setUser(null);
  };

  return (
    <SafeAreaProvider>
      {/* Nothing is shown before the first unlock. After that the screens stay
          mounted under the lock so the mesh keeps running while it is locked. */}
      {!hasUnlockedOnce || !sessionChecked ? null : !user ? (
        <LoginScreen onLoginSuccess={(loggedInUser) => setUser(loggedInUser)} onOpenBench={onOpenBench} />
      ) : (
        <>
          <MapScreen user={user} onLogout={handleLogout} />
          <SaliencyToast alert={alert} onClear={clearAlert} />
        </>
      )}
      {!isUnlocked && (
        <View style={styles.lockOverlay}>
          <AppLock onUnlock={handleUnlock} />
        </View>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  lockOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 10000, elevation: 10000 },
});

// The Mesh Lab build adds a raw test bench for the mesh, reachable from the
// login screen, before the app starts its own mesh.
export default function App() {
  const [showBench, setShowBench] = useState(false);
  if (IS_MESH_LAB_BUILD && showBench) return <MeshLabScreen onClose={() => setShowBench(false)} />;
  return <FlareNodeApp onOpenBench={IS_MESH_LAB_BUILD ? () => setShowBench(true) : undefined} />;
}
