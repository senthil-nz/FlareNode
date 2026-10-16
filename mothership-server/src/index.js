const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query, execute, initDb } = require('./db');
const { loadAuthority, certificateId, parsePublicKey } = require('./meshAuthority');

const app = express();
app.use(express.json());
app.use(cors());

// Live dashboard (public/index.html) and its locally served map library
app.use(express.static(path.join(__dirname, '../public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, '../node_modules/leaflet/dist')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const VALIDATOR_API_KEY = process.env.VALIDATOR_API_KEY;
if (!JWT_SECRET || !VALIDATOR_API_KEY) {
  console.error('JWT_SECRET and VALIDATOR_API_KEY must be set (see mothership-server/.env.example).');
  process.exit(1);
}

// In-memory cache for the validator feed
let validatorCache = {
  data: null,
  timestamp: 0
};
const CACHE_TTL = 60 * 1000; // 60 seconds

// Last sync per responder, shown on the dashboard as connected uplinks
const uplinks = new Map();

// Who removed which marker, so the dashboard can say so when a pin disappears
const removals = new Map();
const MAX_REMOVALS = 200;

// Issues the certificates phones use to check who wrote a mesh record.
// Loaded in start(), before the server accepts requests.
let authority = null;

// Middleware: JWT Validation
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication token missing' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// Middleware: only admins may manage responders
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};

const ROLES = ['admin', 'responder'];
const MIN_PASSWORD_LENGTH = 8;
const publicResponder = (row) => ({ id: row.id, name: row.name, role: row.role || 'responder', created_at: row.created_at });

// Middleware: Validator API Key Auth (Sprint 8)
const authenticateValidator = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== VALIDATOR_API_KEY) {
    return res.status(403).json({ error: 'Invalid Validator API Key' });
  }
  next();
};

// Auth endpoints
app.post('/api/auth/login', async (req, res) => {
  const { author_id, password } = req.body;
  try {
    const result = await query('SELECT * FROM responders WHERE id = $1', [author_id]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const role = user.role || 'responder';
    const token = jwt.sign({ id: user.id, name: user.name, role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, name: user.name, role } });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Any signed-in responder can change their own password
app.post('/api/auth/password', authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof new_password !== 'string' || new_password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  try {
    const user = (await query('SELECT * FROM responders WHERE id = $1', [req.user.id])).rows[0];
    if (!user || !(await bcrypt.compare(String(current_password || ''), user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await execute('UPDATE responders SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(new_password, 10), user.id]);
    res.json({ message: 'Password changed' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mesh enrolment: a phone sends the public half of its signing key and gets
// back a certificate tying it to the signed-in responder and their role.
// The role is read from the database now, not from the token, so a role
// change takes effect the next time the phone enrols.
app.post('/api/mesh/enroll', authenticateToken, async (req, res) => {
  const key = req.body?.key;
  if (!parsePublicKey(key)) return res.status(400).json({ error: 'key must be a base64 Ed25519 public key' });
  try {
    const user = (await query('SELECT id, name, role, created_at FROM responders WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(401).json({ error: 'Responder no longer exists' });
    const certificate = authority.issue({ id: user.id, name: user.name, role: user.role || 'responder', key, since: accountCreated(user.created_at) });
    await execute('INSERT INTO mesh_certs (id, cert) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET cert = EXCLUDED.cert', [certificateId(certificate), JSON.stringify(certificate)]);
    res.json({ certificate, authorityKey: authority.publicKey });
  } catch (err) {
    console.error('Mesh enrolment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// When a responder's account was created, in milliseconds. SQLite stores it as
// UTC text with no zone; PostgreSQL returns a Date.
function accountCreated(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value || '');
  const parsed = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

// Responder management (admins only)
app.get('/api/responders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await query('SELECT id, name, role, created_at FROM responders ORDER BY id');
    res.json(result.rows.map(publicResponder));
  } catch (err) {
    console.error('Responder list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/responders', authenticateToken, requireAdmin, async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const name = String(req.body?.name || '').trim();
  const role = req.body?.role || 'responder';
  const password = req.body?.password;
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(id)) return res.status(400).json({ error: 'ID must be 2-40 letters, digits, dot, dash or underscore' });
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  try {
    const existing = (await query('SELECT id FROM responders WHERE id = $1', [id])).rows[0];
    if (existing) return res.status(409).json({ error: 'A responder with that ID already exists' });
    await execute('INSERT INTO responders (id, password_hash, name, role) VALUES ($1, $2, $3, $4)', [id, await bcrypt.hash(password, 10), name, role]);
    res.status(201).json({ id, name, role });
  } catch (err) {
    console.error('Responder create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/responders/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, role, password } = req.body || {};
  try {
    const user = (await query('SELECT * FROM responders WHERE id = $1', [req.params.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Responder not found' });
    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
      if (user.id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role' });
      await execute('UPDATE responders SET role = $1 WHERE id = $2', [role, user.id]);
    }
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Name is required' });
      await execute('UPDATE responders SET name = $1 WHERE id = $2', [String(name).trim(), user.id]);
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      await execute('UPDATE responders SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(password, 10), user.id]);
    }
    res.json(publicResponder((await query('SELECT id, name, role, created_at FROM responders WHERE id = $1', [user.id])).rows[0]));
  } catch (err) {
    console.error('Responder update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/responders/:id', authenticateToken, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });
  try {
    const result = await execute('DELETE FROM responders WHERE id = $1', [req.params.id]);
    const removed = result.changes ?? result.rowCount;
    if (!removed) return res.status(404).json({ error: 'Responder not found' });
    res.json({ message: 'Responder removed' });
  } catch (err) {
    console.error('Responder delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// A phone on the signed mesh sends each marker with `_mesh`: the record's
// version and signature. The record is rebuilt and kept whole, so another
// phone can be given it and check the signature for itself. The Mothership
// only carries these; it cannot alter one without breaking its signature.
const signedRecord = (id, doc) => {
  const mesh = doc._mesh;
  if (!mesh || typeof mesh.version !== 'string' || !mesh.auth || typeof mesh.auth.sig !== 'string' || typeof mesh.auth.k !== 'string') return null;
  const { _mesh, ...fields } = doc;
  return JSON.stringify({ collection: 'tactical_markers', id, version: mesh.version, auth: { k: mesh.auth.k, sig: mesh.auth.sig }, fields });
};

const parseAll = (rows, column) => rows.map((row) => {
  try { return JSON.parse(row[column]); } catch (err) { return null; }
}).filter(Boolean);

// Sync endpoint
app.post('/api/sync/markers', authenticateToken, async (req, res) => {
  const markers = req.body;
  if (!Array.isArray(markers)) return res.status(400).json({ error: 'Payload must be an array' });
  try {
    const sql = `
      INSERT INTO tactical_markers (id, latitude, longitude, type, timestamp, author_id, author_name, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, type = EXCLUDED.type,
        timestamp = EXCLUDED.timestamp, author_id = EXCLUDED.author_id, author_name = EXCLUDED.author_name,
        updated_at = CURRENT_TIMESTAMP
      WHERE EXCLUDED.timestamp > tactical_markers.timestamp;
    `;
    // Removed markers are remembered so a phone that has not yet heard about
    // a removal over the mesh cannot bring the marker back.
    const tombstones = new Set((await query('SELECT id FROM deleted_markers')).rows.map(row => row.id));
    const admins = new Set((await query("SELECT id FROM responders WHERE role = 'admin'")).rows.map(row => row.id));
    for (const m of markers) {
      // Mesh documents are keyed by _id; removed markers arrive flagged deleted
      const id = m.id || m._id;
      if (!id) continue;
      if (m.deleted) {
        // A marker may be removed by whoever added it, or by an admin. The
        // phone that uploads a removal is often relaying one made elsewhere on
        // the mesh, so the check uses who the record says removed it.
        const existing = (await query('SELECT author_id FROM tactical_markers WHERE id = $1', [id])).rows[0];
        if (existing && m.deleted_by !== existing.author_id && !admins.has(m.deleted_by)) continue;
        if (!tombstones.has(id)) {
          await execute('INSERT INTO deleted_markers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [id]);
          tombstones.add(id);
        }
        await execute('DELETE FROM tactical_markers WHERE id = $1', [id]);
        const removal = signedRecord(id, m);
        if (removal) await execute('UPDATE deleted_markers SET record = $1 WHERE id = $2', [removal, id]);
        if (!removals.has(id)) {
          removals.set(id, { id, removedBy: m.deleted_by || null, removedAt: m.deleted_at || Date.now() });
          if (removals.size > MAX_REMOVALS) removals.delete(removals.keys().next().value);
        }
      } else if (!tombstones.has(id)) {
        await execute(sql, [id, m.latitude, m.longitude, m.type, m.timestamp, m.author_id, m.author_name]);
        // Keep the newest signed copy: a phone with stale data must not
        // replace it with an older one
        const record = signedRecord(id, m);
        if (record) {
          const held = (await query('SELECT mesh FROM tactical_markers WHERE id = $1', [id])).rows[0];
          let heldVersion = '';
          try { heldVersion = held && held.mesh ? JSON.parse(held.mesh).version : ''; } catch (err) { /* unreadable: replace it */ }
          if (m._mesh.version > heldVersion) await execute('UPDATE tactical_markers SET mesh = $1 WHERE id = $2', [record, id]);
        }
      }
    }
    uplinks.set(req.user.id, { id: req.user.id, name: req.user.name, lastSync: Date.now(), markers: markers.length });
    res.status(200).json({ message: 'Sync successful', processed: markers.length });
  } catch (err) {
    console.error('Marker sync error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The other direction: what the Mothership holds, for a phone to fill gaps
// from. `removed` lists markers known to be removed, so a phone still showing
// one can drop it.
app.get('/api/sync/markers', authenticateToken, async (req, res) => {
  try {
    const markers = await query('SELECT id, latitude, longitude, type, timestamp, author_id, author_name, mesh FROM tactical_markers');
    const removed = await query('SELECT id, record FROM deleted_markers');
    const certificates = await query('SELECT cert FROM mesh_certs');
    res.json({
      markers: markers.rows.map(({ mesh, ...marker }) => marker),
      removed: removed.rows.map((row) => row.id),
      // For phones on the signed mesh: the records as their authors signed
      // them, and the certificates needed to check them
      records: parseAll(markers.rows.filter((row) => row.mesh), 'mesh'),
      removedRecords: parseAll(removed.rows.filter((row) => row.record), 'record'),
      certificates: parseAll(certificates.rows, 'cert'),
    });
  } catch (err) {
    console.error('Marker fetch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Connectivity gap sync: phones upload the dead zones they logged while cut off
app.post('/api/sync/gaps', authenticateToken, async (req, res) => {
  const gaps = req.body;
  if (!Array.isArray(gaps)) return res.status(400).json({ error: 'Payload must be an array' });
  try {
    // Cleared dead zones are remembered, like removed markers, so a phone that
    // has not yet heard about the clear cannot bring them back.
    const tombstones = new Set((await query('SELECT id FROM deleted_markers')).rows.map(row => row.id));
    for (const g of gaps) {
      const id = g.id || g._id;
      if (!id) continue;
      if (g.deleted) {
        if (!tombstones.has(id)) {
          await execute('INSERT INTO deleted_markers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [id]);
          tombstones.add(id);
        }
        await execute('DELETE FROM connectivity_gaps WHERE id = $1', [id]);
        continue;
      }
      if (tombstones.has(id) || !Number.isFinite(g.latitude) || !Number.isFinite(g.longitude)) continue;
      // Older builds logged gaps without a position (0, 0)
      if (g.latitude === 0 && g.longitude === 0) continue;
      await execute(
        `INSERT INTO connectivity_gaps (id, latitude, longitude, timestamp, reporter_id, reporter_name)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
        [id, g.latitude, g.longitude, g.timestamp, req.user.id, req.user.name]
      );
    }
    res.status(200).json({ message: 'Sync successful', processed: gaps.length });
  } catch (err) {
    console.error('Gap sync error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard feed: current markers plus which responders have synced recently
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, latitude, longitude, type, timestamp, author_id, author_name FROM tactical_markers ORDER BY timestamp DESC'
    );
    const gaps = await query('SELECT id, latitude, longitude, timestamp, reporter_name FROM connectivity_gaps ORDER BY timestamp DESC');
    res.json({ serverTime: Date.now(), markers: result.rows, gaps: gaps.rows, removals: [...removals.values()], uplinks: [...uplinks.values()] });
  } catch (err) {
    console.error('Dashboard feed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Offline map packs: regions built with tools/map-pack that phones can
// download to replace the map bundled in the app.
const MAPS_DIR = path.join(__dirname, '../maps');
const MAP_PACK_ID = /^[a-z0-9-]{2,40}$/;

app.get('/api/maps', authenticateToken, (req, res) => {
  try {
    if (!fs.existsSync(MAPS_DIR)) return res.json([]);
    const packs = fs.readdirSync(MAPS_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try { return JSON.parse(fs.readFileSync(path.join(MAPS_DIR, file), 'utf8')); } catch { return null; }
      })
      .filter((pack) => pack && MAP_PACK_ID.test(pack.id) && fs.existsSync(path.join(MAPS_DIR, `${pack.id}.mbtiles`)));
    res.json(packs);
  } catch (err) {
    console.error('Map pack list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/maps/:id/download', authenticateToken, (req, res) => {
  if (!MAP_PACK_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid map pack id' });
  const file = path.join(MAPS_DIR, `${req.params.id}.mbtiles`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Map pack not found' });
  res.download(file, `${req.params.id}.mbtiles`);
});

// Sprint 7: ODK & GeoJSON Exports
const fetchMarkersForExport = async ({ startDate, endDate }) => {
  let sql = 'SELECT id, latitude, longitude, type, timestamp, author_id, author_name FROM tactical_markers';
  const params = [];
  if (startDate && endDate) {
    sql += ' WHERE timestamp >= $1 AND timestamp <= $2';
    params.push(parseInt(startDate), parseInt(endDate));
  }
  return (await query(sql, params)).rows;
};

// Quote CSV fields so a comma or quote in a responder name cannot shift columns
const csvField = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

app.get('/api/export/odk', authenticateToken, async (req, res) => {
  try {
    const rows = await fetchMarkersForExport(req.query);
    const header = 'id,latitude,longitude,type,timestamp,author_id,author_name\n';
    const csvData = rows
      .map(row => [row.id, row.latitude, row.longitude, row.type, row.timestamp, row.author_id, row.author_name].map(csvField).join(','))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=flarenode_export_odk.csv');
    res.send(header + csvData);
  } catch (err) {
    console.error('ODK export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

app.get('/api/export/geojson', authenticateToken, async (req, res) => {
  try {
    const rows = await fetchMarkersForExport(req.query);
    const geojson = {
      type: 'FeatureCollection',
      features: rows.map(row => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
        properties: { id: row.id, type: row.type, timestamp: row.timestamp, author: row.author_id, name: row.author_name }
      }))
    };
    res.setHeader('Content-Type', 'application/json');
    res.json(geojson);
  } catch (err) {
    console.error('GeoJSON export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// Connectivity gaps ("dead zones") logged by phones that lost every mesh peer
app.get('/api/export/gaps', authenticateToken, async (req, res) => {
  try {
    const result = await query('SELECT id, latitude, longitude, timestamp, reporter_id, reporter_name FROM connectivity_gaps ORDER BY timestamp DESC');
    res.json({
      type: 'FeatureCollection',
      features: result.rows.map(row => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
        properties: { id: row.id, event: 'DEAD_ZONE_DETECTED', timestamp: row.timestamp, reporter: row.reporter_id, name: row.reporter_name }
      }))
    });
  } catch (err) {
    console.error('Gap export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// Task 1, 2 & 3: Sprint 8 - JOSM Validator Feed
app.get('/api/feed/validator', authenticateValidator, async (req, res) => {
  const now = Date.now();
  
  // Task 2: Caching Layer
  if (validatorCache.data && (now - validatorCache.timestamp < CACHE_TTL)) {
    console.log('Serving validator feed from cache');
    return res.json(validatorCache.data);
  }

  try {
    const result = await query('SELECT id, latitude, longitude, type, timestamp, author_id, author_name FROM tactical_markers');
    const rows = result.rows;

    // Task 3: JOSM Styling (injecting marker-color/symbol)
    const geojson = {
      type: 'FeatureCollection',
      features: rows.map(row => {
        let color = '#FFFFFF';
        let symbol = 'circle';
        
        if (row.type === 'hazard') { color = '#FF0000'; symbol = 'warning'; }
        else if (row.type === 'infrastructure') { color = '#0000FF'; symbol = 'building'; }
        else if (row.type === 'responder') { color = '#00FF00'; symbol = 'user'; }

        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
          properties: { 
            ...row,
            'marker-color': color,
            'marker-symbol': symbol,
            'description': `Reported by ${row.author_name} (${row.author_id})`
          }
        };
      })
    };

    // Update Cache
    validatorCache = { data: geojson, timestamp: now };
    res.json(geojson);
  } catch (err) {
    console.error('Validator feed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  await initDb();
  authority = await loadAuthority({ query, execute });
  app.listen(PORT, () => console.log(`Mothership API secured & running on port ${PORT}`));
}

start();
