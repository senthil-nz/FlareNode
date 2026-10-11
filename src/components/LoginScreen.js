import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, ImageBackground, KeyboardAvoidingView, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { ServerConfig } from '../services/ServerConfig';

const LoginScreen = ({ onLoginSuccess, onOpenBench }) => {
  // Optionally pre-filled from the local .env for faster testing
  const [id, setId] = useState(process.env.EXPO_PUBLIC_DEV_LOGIN_ID || '');
  const [password, setPassword] = useState(process.env.EXPO_PUBLIC_DEV_LOGIN_PASSWORD || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [serverUrl, setServerUrl] = useState('');
  const [showServer, setShowServer] = useState(false);

  useEffect(() => {
    ServerConfig.getUrl().then(setServerUrl);
  }, []);

  const handleLogin = async () => {
    if (!id || !password) {
      setError('Please enter both ID and password');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Saves any edit to the server address, then signs in against it
      const baseUrl = await ServerConfig.setUrl(serverUrl);
      setServerUrl(baseUrl);
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author_id: id, password }),
      });
      const data = await response.json();

      if (response.ok) {
        // Task 2: Save JWT securely
        await SecureStore.setItemAsync('mothership_jwt', data.token);
        await SecureStore.setItemAsync('user_id', data.user.id);
        await SecureStore.setItemAsync('user_name', data.user.name);
        await SecureStore.setItemAsync('user_role', data.user.role || 'responder');
        onLoginSuccess(data.user);
      } else {
        setError(data.error || 'Login failed');
      }
    } catch (e) {
      // No route to the Mothership (field/offline use): let a responder who has
      // already authenticated on this device continue on the P2P mesh.
      const storedId = await SecureStore.getItemAsync('user_id');
      if (storedId && storedId === id) {
        const storedName = await SecureStore.getItemAsync('user_name');
        const storedRole = await SecureStore.getItemAsync('user_role');
        onLoginSuccess({ id: storedId, name: storedName, role: storedRole || 'responder' });
      } else {
        setError('Cloud server unreachable');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ImageBackground source={require('../../assets/login-hero.jpg')} style={styles.hero} resizeMode="cover">
        <View style={styles.heroShade} />
        <View style={styles.heroText}>
          <Text style={styles.title}>FlareNode</Text>
          <Text style={styles.subtitle}>Offline mesh coordination for disaster response</Text>
        </View>
      </ImageBackground>

      <View style={styles.form}>
        <Text style={styles.formTitle}>Responder sign in</Text>

        <TextInput
          style={styles.input}
          value={id}
          onChangeText={setId}
          placeholder="Responder ID"
          placeholderTextColor="#7d8a99"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor="#7d8a99"
          secureTextEntry
        />

        {showServer && (
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="Mothership address, e.g. http://192.168.1.20:3000"
            placeholderTextColor="#7d8a99"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity style={styles.button} onPress={handleLogin} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Authenticate</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.serverToggle} onPress={() => setShowServer(!showServer)}>
          <Text style={styles.serverToggleText}>
            {showServer ? 'Hide server address' : `Server: ${serverUrl || 'not set'}`}
          </Text>
        </TouchableOpacity>

        {onOpenBench && (
          <TouchableOpacity style={styles.serverToggle} onPress={onOpenBench}>
            <Text style={styles.serverToggleText}>Mesh Lab build · open the mesh test bench</Text>
          </TouchableOpacity>
        )}
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f14' },
  hero: { flex: 1, justifyContent: 'flex-end' },
  heroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11, 15, 20, 0.35)' },
  heroText: { padding: 24, backgroundColor: 'rgba(11, 15, 20, 0.6)' },
  title: { fontSize: 34, fontWeight: 'bold', color: '#ffffff', letterSpacing: 0.5 },
  subtitle: { fontSize: 14, color: '#c7d3e0', marginTop: 4 },
  form: { padding: 24, paddingBottom: 36, backgroundColor: '#0b0f14' },
  formTitle: { fontSize: 13, fontWeight: '700', color: '#7d8a99', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 14 },
  input: { width: '100%', backgroundColor: '#161d26', color: '#ffffff', padding: 15, borderRadius: 10, marginBottom: 14, borderWidth: 1, borderColor: '#2a3441' },
  error: { color: '#ff6b6b', marginBottom: 14, textAlign: 'center' },
  button: { backgroundColor: '#1e88ff', paddingVertical: 15, borderRadius: 10, width: '100%', alignItems: 'center' },
  buttonText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  serverToggle: { marginTop: 14, alignItems: 'center' },
  serverToggleText: { color: '#7d8a99', fontSize: 12 },
});

export default LoginScreen;
