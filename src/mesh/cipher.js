import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { toBase64, fromBase64, toUtf8, fromUtf8 } from './bytes.js';

/**
 * Who may join the mesh, and keeping its traffic private.
 *
 * Every phone that knows the operational token derives the same secret key
 * from it. Every message is then sealed with that key:
 *
 * - a phone without the token cannot read anything it overhears,
 * - a phone without the token cannot produce a message the others accept, so
 *   it cannot add, change or remove records,
 * - a message altered in transit is rejected.
 *
 * This lives in the sync layer, not in the radio layer, so it does not change
 * when the transport does, and it does not depend on trusting the transport's
 * own link encryption.
 *
 * What it does not do:
 * - Everyone holding the token is trusted equally. It cannot tell responders
 *   apart, so the "only the author or an admin may remove a marker" rule is
 *   still enforced by the app and the Mothership, not here.
 * - The token is short and human-chosen. Someone who records traffic can try
 *   tokens offline; the key derivation below slows that down, it does not
 *   prevent it. A long random token is what makes this strong.
 * - A removed responder keeps access until the token is changed on every phone.
 *
 * Algorithms: PBKDF2-SHA256 to turn the token into a key, XChaCha20-Poly1305
 * to seal messages. Both from the audited, dependency-free "noble" libraries.
 */

const KEY_SALT = 'flarenode-mesh-v1';
const KEY_ITERATIONS = 20000;
const NONCE_BYTES = 24;
const ENVELOPE_PREFIX = 's1.';

/** Turns the operational token into the 32-byte key every member derives alike. */
export async function deriveMeshKey(token, { iterations = KEY_ITERATIONS } = {}) {
  if (!token) throw new Error('An operational token is needed to join the mesh');
  return pbkdf2Async(sha256, toUtf8(String(token)), toUtf8(KEY_SALT), { c: iterations, dkLen: 32 });
}

/**
 * A cipher for one mesh key.
 *
 * `randomBytes(n)` must be a cryptographically secure source. Each message
 * gets a fresh random 24-byte nonce, which is long enough that phones can
 * pick them independently without ever coordinating.
 *
 * The sender and receiver ids are bound into every sealed message. A message
 * sealed for one phone is therefore rejected if it is replayed to another, or
 * bounced back at its sender.
 */
export function createCipher(key, randomBytes) {
  const bind = (from, to) => toUtf8(`flarenode-mesh|1|${from}|${to}`);

  return {
    seal(text, { from, to }) {
      const nonce = randomBytes(NONCE_BYTES);
      const sealed = xchacha20poly1305(key, nonce, bind(from, to)).encrypt(toUtf8(text));
      const packed = new Uint8Array(nonce.length + sealed.length);
      packed.set(nonce, 0);
      packed.set(sealed, nonce.length);
      return ENVELOPE_PREFIX + toBase64(packed);
    },

    /** Returns the original text, or null if the message is not genuine. */
    open(envelope, { from, to }) {
      if (typeof envelope !== 'string' || !envelope.startsWith(ENVELOPE_PREFIX)) return null;
      const packed = fromBase64(envelope.slice(ENVELOPE_PREFIX.length));
      if (!packed || packed.length <= NONCE_BYTES) return null;
      try {
        const opened = xchacha20poly1305(key, packed.subarray(0, NONCE_BYTES), bind(from, to)).decrypt(packed.subarray(NONCE_BYTES));
        return fromUtf8(opened);
      } catch (error) {
        return null; // wrong key, wrong sender or receiver, or tampered with
      }
    },
  };
}
