import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';

/**
 * SaliencyToast - A high-contrast, urgent notification overlay.
 * Designed for high-stress environments where visibility is critical.
 */
const SaliencyToast = ({ alert, onClear }) => {
  if (!alert) return null;

  return (
    <View style={styles.overlay}>
      <Animated.View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{alert.title}</Text>
        </View>
        <View style={styles.body}>
          <Text style={styles.message}>{alert.message}</Text>
        </View>
        <TouchableOpacity style={styles.button} onPress={onClear}>
          <Text style={styles.buttonText}>ACKNOWLEDGE</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    zIndex: 9999,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  container: {
    backgroundColor: '#ff0000', // Pure Red for Saliency
    width: '100%',
    maxWidth: 400,
    borderRadius: 12,
    borderWidth: 4,
    borderColor: '#ffffff',
    overflow: 'hidden',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  header: {
    backgroundColor: '#000',
    padding: 15,
    alignItems: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    letterSpacing: 1,
  },
  body: {
    padding: 25,
    alignItems: 'center',
  },
  message: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 10,
  },
  button: {
    backgroundColor: '#fff',
    paddingVertical: 12,
    paddingHorizontal: 30,
    margin: 20,
    borderRadius: 6,
    alignItems: 'center',
  },
  buttonText: {
    color: '#ff0000',
    fontWeight: 'bold',
    fontSize: 16,
  },
});

export default SaliencyToast;
