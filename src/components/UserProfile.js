import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const UserProfile = ({ onSave }) => {
  const [profile, setProfile] = useState({ id: '', name: '' });

  useEffect(() => {
    const loadProfile = async () => {
      const id = await SecureStore.getItemAsync('user_id');
      const name = await SecureStore.getItemAsync('user_name');
      if (id && name) setProfile({ id, name });
    };
    loadProfile();
  }, []);

  const handleSave = async () => {
    await SecureStore.setItemAsync('user_name', profile.name);
    onSave(profile);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Responder Profile</Text>
      <Text style={styles.label}>Badge ID / Unique ID</Text>
      {/* The ID is the signed-in account; it decides which markers this responder may remove */}
      <TextInput
        style={[styles.input, { color: '#888' }]}
        value={profile.id}
        editable={false}
        placeholder="e.g. RESP-101"
      />
      <Text style={styles.label}>Full Name</Text>
      <TextInput 
        style={styles.input} 
        value={profile.name} 
        onChangeText={(t) => setProfile({...profile, name: t})} 
        placeholder="e.g. Jane Doe"
      />
      <TouchableOpacity style={styles.button} onPress={handleSave}>
        <Text style={styles.buttonText}>Save Profile</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: 'white', borderRadius: 20, margin: 20, elevation: 5 },
  title: { fontSize: 20, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  label: { fontSize: 14, color: '#666', marginBottom: 5 },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, borderRadius: 8, marginBottom: 20 },
  button: { backgroundColor: '#007AFF', padding: 15, borderRadius: 10, alignItems: 'center' },
  buttonText: { color: 'white', fontWeight: 'bold' },
});

export default UserProfile;
