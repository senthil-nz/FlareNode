const crypto = require('crypto');
const { ed25519 } = require('@noble/curves/ed25519');

/**
 * The Mothership as the mesh's certificate authority.
 *
 * Each responder's phone has its own signing key. When a responder signs in,
 * the Mothership vouches for that key with a certificate: "this key belongs to
 * responder alpha, whose role is responder". Phones check the certificate
 * against the Mothership's public key, offline, and use it to decide whose
 * records to accept (see src/mesh/identity.js and policy.js in the app, which
 * this file must stay compatible with).
 *
 * The authority's private key signs every certificate, so it must stay on the
 * server. It is created on first start and kept in the database; set
 * MESH_AUTHORITY_KEY (base64, 32 bytes) to supply your own instead.
 * Anyone who obtains it can mint an admin certificate.
 */

const CERT_PREFIX = 'flarenode-cert|1|';
const CERT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

// Must match canonicalJson in src/mesh/bytes.js: sorted keys, no whitespace
const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};

const certificateId = (cert) => `${cert.id}:${String(cert.key).slice(0, 16)}`;

// A base64 Ed25519 public key, or null
const parsePublicKey = (text) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length === 32 ? bytes : null;
};

function createAuthority(privateKey) {
  const publicKey = Buffer.from(ed25519.getPublicKey(privateKey)).toString('base64');
  return {
    publicKey,
    // `since` is when the responder's account was created. Every certificate
    // for them starts then, however often it is renewed: if a renewal moved the
    // start, what they wrote before it would be refused by phones that had
    // not met those records yet.
    issue({ id, name, role, key, now = Date.now(), since = now }) {
      const body = { v: 1, id: String(id), name: String(name), role: String(role), key: String(key), issued: Math.min(since, now), expires: now + CERT_LIFETIME_MS };
      const signature = ed25519.sign(Buffer.from(CERT_PREFIX + canonicalJson(body), 'utf8'), privateKey);
      return { ...body, sig: Buffer.from(signature).toString('base64') };
    },
  };
}

/** Loads the authority's key, creating and saving one on first use. */
async function loadAuthority({ query, execute }) {
  if (process.env.MESH_AUTHORITY_KEY) {
    const supplied = Buffer.from(process.env.MESH_AUTHORITY_KEY, 'base64');
    if (supplied.length !== 32) throw new Error('MESH_AUTHORITY_KEY must be 32 bytes, base64 encoded');
    return createAuthority(supplied);
  }
  const existing = (await query('SELECT private_key FROM mesh_authority WHERE id = 1')).rows[0];
  if (existing) return createAuthority(Buffer.from(existing.private_key, 'base64'));
  const privateKey = crypto.randomBytes(32);
  await execute('INSERT INTO mesh_authority (id, private_key) VALUES (1, $1)', [privateKey.toString('base64')]);
  console.log('✅ Created the mesh certificate authority key');
  return createAuthority(privateKey);
}

module.exports = { loadAuthority, createAuthority, certificateId, parsePublicKey, CERT_LIFETIME_MS };
