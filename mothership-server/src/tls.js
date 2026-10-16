const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const dgram = require('dgram');

/**
 * HTTPS for a Mothership on a local network.
 *
 * The Mothership usually runs on a laptop with no domain name, so no public
 * certificate authority will vouch for it. Instead it is its own: on first
 * start it creates a small certificate authority (CA), and with it a
 * certificate for this computer's network addresses. A phone that has
 * installed the CA certificate once (from /ca.crt) then trusts the
 * Mothership's HTTPS, and nothing else on the network can pretend to be it.
 *
 * The CA's private key never leaves this computer. The files live in
 * mothership-server/tls (git-ignored). The server certificate is issued again
 * whenever this computer's addresses change, which on a laptop moving between
 * networks is often; phones keep trusting it because the CA stays the same.
 */

const CA_YEARS = 10;
// Phones and browsers refuse server certificates valid for much longer than a year
const SERVER_DAYS = 397;

/** This computer's IPv4 addresses, plus localhost. */
function localAddresses() {
  const addresses = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' || entry.family === 4) addresses.add(entry.address);
    }
  }
  return [...addresses].sort();
}

const serial = () => crypto.randomBytes(16).toString('hex').replace(/^[89a-f]/, '1');

function createCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CA_YEARS * 365 * 24 * 60 * 60 * 1000);
  const name = [
    { name: 'commonName', value: `FlareNode Mothership CA (${os.hostname()})` },
    { name: 'organizationName', value: 'FlareNode' },
  ];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

function createServerCertificate(ca, addresses) {
  const caKey = forge.pki.privateKeyFromPem(ca.key);
  const caCert = forge.pki.certificateFromPem(ca.cert);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + SERVER_DAYS * 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: 'commonName', value: `FlareNode Mothership (${os.hostname()})` }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [{ type: 2, value: 'localhost' }, { type: 2, value: os.hostname() }, ...addresses.map((ip) => ({ type: 7, ip }))],
    },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

/** The SHA-256 fingerprint of a PEM certificate, as shown by Android and browsers. */
function fingerprint(pem) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(pem))).getBytes();
  return crypto.createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex').toUpperCase().match(/../g).join(':');
}

// The addresses a certificate covers, and when it runs out
function coverage(pem) {
  const cert = forge.pki.certificateFromPem(pem);
  const altNames = cert.getExtension('subjectAltName')?.altNames || [];
  return { addresses: altNames.filter((name) => name.type === 7).map((name) => name.ip).sort(), notAfter: cert.validity.notAfter };
}

/**
 * The certificate and key to serve HTTPS with, creating or renewing them as
 * needed. Returns { key, cert, ca, caFingerprint, addresses }.
 */
function loadTls(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = (name) => path.join(directory, name);
  const read = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : null);
  const write = (name, text, secret) => fs.writeFileSync(file(name), text, secret ? { mode: 0o600 } : undefined);

  let ca = { key: read('ca.key'), cert: read('ca.crt') };
  if (!ca.key || !ca.cert) {
    ca = createCa();
    write('ca.key', ca.key, true);
    write('ca.crt', ca.cert);
    console.log('✅ Created the Mothership certificate authority for HTTPS');
  }

  const addresses = localAddresses();
  let server = { key: read('server.key'), cert: read('server.crt') };
  let renew = !server.key || !server.cert;
  if (!renew) {
    const current = coverage(server.cert);
    const soon = Date.now() + 30 * 24 * 60 * 60 * 1000;
    renew = current.addresses.join(',') !== addresses.join(',') || current.notAfter.getTime() < soon;
  }
  if (renew) {
    server = createServerCertificate(ca, addresses);
    write('server.key', server.key, true);
    write('server.crt', server.cert);
    console.log(`✅ Issued the HTTPS certificate for ${addresses.join(', ')}`);
  }
  return { key: server.key, cert: server.cert, ca: ca.cert, caFingerprint: fingerprint(ca.cert), addresses };
}

/**
 * The address phones on the local network most likely reach this computer at:
 * the one its traffic leaves from. Asking the system which address it would
 * use to reach an outside address sends nothing. Without a route out (no
 * network at all), falls back to a private address that is not one of the
 * usual virtual adapters (172.16-31 is used by Docker and WSL, 192.168.56 by
 * VirtualBox).
 */
function primaryAddress() {
  return new Promise((resolve) => {
    const fallback = () => {
      const candidates = localAddresses().filter((address) => address !== '127.0.0.1');
      const rank = (address) => (/^192\.168\.56\./.test(address) ? 3 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : /^(192\.168|10)\./.test(address) ? 0 : 1);
      resolve(candidates.sort((a, b) => rank(a) - rank(b))[0] || '127.0.0.1');
    };
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => { socket.close(); fallback(); });
    socket.connect(53, '8.8.8.8', () => {
      const { address } = socket.address();
      socket.close();
      if (address && address !== '0.0.0.0') resolve(address);
      else fallback();
    });
  });
}

module.exports = { loadTls, localAddresses, primaryAddress, fingerprint };
