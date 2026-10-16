import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { generateKeyPair, verifyCertificate } from '../mesh/identity.js';
import { ServerConfig } from './ServerConfig';

/**
 * This phone's signing identity on the mesh.
 *
 * The phone makes its own key pair once and keeps the private half in the
 * device's secure storage; it never leaves the phone. The Mothership vouches
 * for the public half with a certificate naming the signed-in responder and
 * their role. Records this phone writes are signed with the private key, and
 * other phones check them against the certificate (see src/mesh/identity.js).
 *
 * Getting a certificate needs the Mothership, so the first sign-in must be
 * online. After that the stored certificate is used, and it is refreshed
 * whenever the Mothership can be reached, which is also how a change of role
 * reaches the phone.
 */

const PRIVATE_KEY = 'mesh_private_key';
const PUBLIC_KEY = 'mesh_public_key';
const CERTIFICATE = 'mesh_certificate';
const AUTHORITY_KEY = 'mesh_authority_key';
const ENROL_TIMEOUT_MS = 5000;

const readCertificate = async () => {
  try {
    return JSON.parse(await SecureStore.getItemAsync(CERTIFICATE));
  } catch (error) {
    return null;
  }
};

const keyPair = async () => {
  let privateKey = await SecureStore.getItemAsync(PRIVATE_KEY);
  let publicKey = await SecureStore.getItemAsync(PUBLIC_KEY);
  if (!privateKey || !publicKey) {
    ({ privateKey, publicKey } = generateKeyPair(ed25519, (count) => Crypto.getRandomBytes(count)));
    await SecureStore.setItemAsync(PRIVATE_KEY, privateKey);
    await SecureStore.setItemAsync(PUBLIC_KEY, publicKey);
  }
  return { privateKey, publicKey };
};

export const MeshIdentity = {
  ed: ed25519,

  /** Asks the Mothership for a certificate for the signed-in responder. */
  async enrol(retried = false) {
    const token = await SecureStore.getItemAsync('mothership_jwt');
    if (!token) throw new Error('Not signed in');
    const { publicKey } = await keyPair();
    const serverUrl = await ServerConfig.getUrl();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENROL_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${serverUrl}/api/mesh/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ key: publicKey }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 403) {
      // This phone's key was cancelled (the phone was reported lost, or the
      // responder's role changed). Make a new key; signing in again certifies it.
      const reason = await response.json().catch(() => ({}));
      if (reason.errorCode === 'KEY_CANCELLED' && !retried) {
        await SecureStore.deleteItemAsync(PRIVATE_KEY);
        await SecureStore.deleteItemAsync(PUBLIC_KEY);
        await SecureStore.deleteItemAsync(CERTIFICATE);
        return this.enrol(true);
      }
    }
    if (!response.ok) throw new Error(`Mothership refused enrolment: HTTP ${response.status}`);
    const { certificate, authorityKey } = await response.json();

    // Only keep a certificate that is for this phone's key and checks out
    if (certificate?.key !== publicKey || !verifyCertificate(ed25519, authorityKey, certificate)) {
      throw new Error('Mothership sent a certificate that does not check out');
    }
    await SecureStore.setItemAsync(CERTIFICATE, JSON.stringify(certificate));
    await SecureStore.setItemAsync(AUTHORITY_KEY, authorityKey);
    return certificate;
  },

  /**
   * The identity to sign with, or null if this responder has none yet.
   * Tries to refresh from the Mothership first, and falls back to what is
   * stored when it cannot be reached.
   */
  async current() {
    const userId = await SecureStore.getItemAsync('user_id');
    if (!userId) return null;

    try {
      await this.enrol();
    } catch (error) {
      // Offline, or the session has expired: carry on with the stored certificate
    }

    const certificate = await readCertificate();
    const authorityKey = await SecureStore.getItemAsync(AUTHORITY_KEY);
    const { privateKey, publicKey } = await keyPair();
    const usable =
      certificate &&
      authorityKey &&
      certificate.id === userId &&
      certificate.key === publicKey &&
      certificate.expires > Date.now() &&
      verifyCertificate(ed25519, authorityKey, certificate);
    return usable ? { certificate, privateKey, authorityKey } : null;
  },
};
