import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const DEFAULT_TOKEN = 'OP-2026-S1';

const MeshSecurity = ({ onVerified, onTokenVerified }) => {
  const [token, setToken] = useState(DEFAULT_TOKEN);
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadSavedToken = async () => {
      const savedToken = await SecureStore.getItemAsync('op_token');
      if (savedToken) {
        setToken(savedToken);
      } else {
        await SecureStore.setItemAsync('op_token', DEFAULT_TOKEN);
      }
    };
    loadSavedToken();
  }, []);

  const handleVerify = async () => {
    if (token.length < 6) {
      setError('Invalid Operation Token length');
      return;
    }
    setIsVerifying(true);
    setError(null);
    
    // Persist the token securely
    await SecureStore.setItemAsync('op_token', token);
    
    // Simulate a short handshake delay for UX
    setTimeout(() => {
      setIsVerifying(false);
      const callback = onVerified || onTokenVerified;
      if (typeof callback === 'function') {
        callback(token);
      }
    }, 800);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mesh Network Trust</Text>
      <Text style={styles.subtitle}>Enter the Operation Token to connect to the peer swarm</Text>
      
      <TextInput 
        style={styles.input} 
        value={token} 
        onChangeText={setToken} 
        placeholder="Enter Token (e.g. OP-2026-S1)" 
        placeholderTextColor="#666"
      />
      
      {error && <Text style={styles.error}>{error}</Text>}
      
      <TouchableOpacity style={styles.button} onPress={handleVerify}>
        {isVerifying ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify & Connect</Text>}
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: 'white', borderRadius: 20, margin: 20, elevation: 5, alignItems: 'center' },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  subtitle: { fontSize: 13, color: '#666', textAlign: 'center', marginBottom: 20 },
  input: { 
    width: '100%', 
    borderWidth: 1, 
    borderColor: '#ccc', 
    padding: 12, 
    borderRadius: 8, 
    marginBottom: 15, 
    fontSize: 16,
    textAlign: 'center'
  },
  error: { color: 'red', marginBottom: 15, fontSize: 12 },
  button: { backgroundColor: '#007AFF', paddingHorizontal: 30, paddingVertical: 15, borderRadius: 10, width: '100%', alignItems: 'center' },
  buttonText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
});

export default MeshSecurity;
