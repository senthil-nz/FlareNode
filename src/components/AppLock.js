import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const AppLock = ({ onUnlock }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      // Earlier builds remembered the first unlock forever; drop that flag
      await SecureStore.deleteItemAsync('session_unlocked');
      await authenticate();
    } catch (e) {
      setError('Auth check failed');
    } finally {
      setIsLoading(false);
    }
  };

  const authenticate = async () => {
    try {
      // Fingerprint or face where enrolled, otherwise the device PIN/pattern
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        setError('Set up a screen lock or fingerprint on this device to use FlareNode');
        return;
      }

      setError(null);
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to access FlareNode',
        cancelLabel: 'Cancel',
        fallbackLabel: 'Use Passcode',
      });

      if (result.success) {
        onUnlock();
      } else {
        setError('Authentication failed');
      }
    } catch (e) {
      setError('Authentication error: ' + (e.message || 'unknown'));
    }
  };

  if (isLoading) return <View style={styles.center}><ActivityIndicator size="large" color="#007AFF" /></View>;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>FlareNode Secure Access</Text>
      <Text style={styles.subtitle}>Biometric authentication required to view tactical data</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <TouchableOpacity style={styles.button} onPress={authenticate}>
        <Text style={styles.buttonText}>Unlock Device</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a1a', justifyContent: 'center', alignItems: 'center', padding: 20 },
  center: { flex: 1, backgroundColor: '#1a1a1a', justifyContent: 'center', alignItems: 'center' },
  title: { color: 'white', fontSize: 24, fontWeight: 'bold', marginBottom: 10 },
  subtitle: { color: '#aaa', fontSize: 14, textAlign: 'center', marginBottom: 30 },
  error: { color: '#ff4444', marginBottom: 20, textAlign: 'center' },
  button: { backgroundColor: '#007AFF', paddingHorizontal: 30, paddingVertical: 15, borderRadius: 10 },
  buttonText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
});

export default AppLock;
