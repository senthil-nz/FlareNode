import { toBase64, fromBase64, toUtf8, canonicalJson } from './bytes.js';

/**
 * Who wrote a record, provably.
 *
 * The shared mesh key (cipher.js) says "this came from someone holding the
 * operational token". It cannot say which responder. This file adds that:
 *
 *   - Each responder's phone has its own signing key pair. The private half
 *     never leaves the phone.
 *   - The Mothership vouches for the public half with a **certificate**:
 *     "this key belongs to responder alpha, whose role is responder", signed
 *     with the Mothership's own key (the "authority").
 *   - Every record a responder writes is **signed** with their private key.
 *   - Any phone can check, offline, that a record's signature matches a
 *     certificate, and that the certificate was issued by the authority.
 *
 * So a phone can tell who wrote each record and whether they are an admin,
 * without trusting the phone that passed the record along.
 *
 * Signatures are Ed25519. The `ed` argument throughout is an Ed25519
 * implementation with sign(message, privateKey), verify(signature, message,
 * publicKey) and getPublicKey(privateKey); the app passes @noble/curves.
 *
 * Keys and signatures travel as base64 text.
 */

const CERT_PREFIX = 'flarenode-cert|1|';
const RECORD_PREFIX = 'flarenode-record|1|';
const CANCEL_PREFIX = 'flarenode-cancel|1|';

// The certificate's content, without its signature
const certBody = ({ v, id, name, role, key, issued, expires }) => ({ v, id, name, role, key, issued, expires });

// A cancellation's content, without its signature
const cancelBody = ({ v, cert, id, at }) => ({ v, cert, id, at });

/** The id a certificate is stored and referred to under: responder plus key. */
export const certificateId = (cert) => `${cert.id}:${String(cert.key).slice(0, 16)}`;

/**
 * The Mothership's side: issues certificates.
 * `privateKey` is 32 secret bytes that must stay on the server.
 */
export function createAuthority(ed, privateKey) {
  return {
    publicKey: toBase64(ed.getPublicKey(privateKey)),

    // `since` is when the responder was first certified. A renewal passes the
    // same `since` again, so the certificate starts when the first one did.
    issue({ id, name, role, key, now, lifetimeMs, since = now }) {
      const body = certBody({ v: 1, id: String(id), name: String(name), role: String(role), key: String(key), issued: Math.min(since, now), expires: now + lifetimeMs });
      const signature = ed.sign(toUtf8(CERT_PREFIX + canonicalJson(body)), privateKey);
      return { ...body, sig: toBase64(signature) };
    },

    /**
     * Cancels a certificate from `at` onwards: nothing its key signs after
     * that is accepted. What it signed before stays valid. `cert` is the
     * certificate's id (see certificateId).
     */
    cancel({ cert, id, at }) {
      const body = cancelBody({ v: 1, cert: String(cert), id: String(id), at });
      const signature = ed.sign(toUtf8(CANCEL_PREFIX + canonicalJson(body)), privateKey);
      return { ...body, sig: toBase64(signature) };
    },
  };
}

/** True if the cancellation is well formed and was issued by this authority. */
export function verifyCancellation(ed, authorityKey, cancellation) {
  if (!cancellation || cancellation.v !== 1) return false;
  for (const field of ['cert', 'id', 'sig']) if (typeof cancellation[field] !== 'string' || !cancellation[field]) return false;
  if (!Number.isFinite(cancellation.at)) return false;
  if (!cancellation.cert.startsWith(`${cancellation.id}:`)) return false;
  const authority = fromBase64(authorityKey);
  const signature = fromBase64(cancellation.sig);
  if (!authority || !signature) return false;
  try {
    return ed.verify(signature, toUtf8(CANCEL_PREFIX + canonicalJson(cancelBody(cancellation))), authority);
  } catch (error) {
    return false;
  }
}

/** True if the certificate is well formed and was issued by this authority. */
export function verifyCertificate(ed, authorityKey, cert) {
  if (!cert || cert.v !== 1) return false;
  for (const field of ['id', 'name', 'role', 'key', 'sig']) if (typeof cert[field] !== 'string' || !cert[field]) return false;
  if (!Number.isFinite(cert.issued) || !Number.isFinite(cert.expires) || cert.expires <= cert.issued) return false;
  const authority = fromBase64(authorityKey);
  const signature = fromBase64(cert.sig);
  const key = fromBase64(cert.key);
  if (!authority || !signature || !key || key.length !== 32) return false;
  try {
    return ed.verify(signature, toUtf8(CERT_PREFIX + canonicalJson(certBody(cert))), authority);
  } catch (error) {
    return false;
  }
}

// What a record's signature covers: where it lives, which write it is, and its content
const recordMessage = (record) =>
  toUtf8(`${RECORD_PREFIX}${record.collection}|${record.id}|${record.version}|${canonicalJson(record.fields)}`);

/**
 * Signs a record. Returns the `auth` to attach to it:
 *   k    the id of the signer's certificate
 *   sig  the signature
 */
export function signRecord(ed, privateKey, certId, record) {
  return { k: certId, sig: toBase64(ed.sign(recordMessage(record), privateKey)) };
}

/** True if the record was signed by the key in this certificate. */
export function verifyRecord(ed, cert, record) {
  const signature = fromBase64(record?.auth?.sig);
  const key = fromBase64(cert?.key);
  if (!signature || !key) return false;
  try {
    return ed.verify(signature, recordMessage(record), key);
  } catch (error) {
    return false;
  }
}

/** A fresh key pair. `randomBytes(n)` must be a secure random source. */
export function generateKeyPair(ed, randomBytes) {
  const privateKey = randomBytes(32);
  return { privateKey: toBase64(privateKey), publicKey: toBase64(ed.getPublicKey(privateKey)) };
}
