import * as SecureStore from 'expo-secure-store';
import { MOTHERSHIP_URL } from '../config';

const STORAGE_KEY = 'mothership_url';
let cachedUrl = null;

// "192.168.1.20:3000/" -> "http://192.168.1.20:3000"
const normalize = (value) => {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
};

/**
 * Where the Mothership lives. The build-time default comes from .env; a
 * responder can override it on the login screen when the server moves (for
 * example when the laptop running it gets a new address on the network).
 */
export const ServerConfig = {
  defaultUrl: MOTHERSHIP_URL || '',

  async getUrl() {
    if (cachedUrl === null) {
      const stored = await SecureStore.getItemAsync(STORAGE_KEY);
      cachedUrl = stored || this.defaultUrl;
    }
    return cachedUrl;
  },

  /** Saves an override; an empty value goes back to the build-time default. */
  async setUrl(value) {
    const url = normalize(value);
    if (url && url !== this.defaultUrl) {
      await SecureStore.setItemAsync(STORAGE_KEY, url);
      cachedUrl = url;
    } else {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
      cachedUrl = this.defaultUrl;
    }
    return cachedUrl;
  },
};
