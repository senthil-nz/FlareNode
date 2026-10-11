const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

let db = null;
let pool = null;
let dbType = 'sqlite'; // Default to sqlite

const initDb = async () => {
  const pgUrl = process.env.DATABASE_URL;
  
  if (pgUrl) {
    try {
      console.log('Attempting to connect to PostgreSQL...');
      pool = new Pool({ connectionString: pgUrl });
      await pool.query('SELECT 1');
      dbType = 'postgres';
      console.log('✅ Connected to PostgreSQL');
    } catch (err) {
      console.log('⚠️ PostgreSQL not available, falling back to SQLite...');
    }
  }

  if (dbType === 'sqlite') {
    // SQLITE_PATH lets tests run against a throwaway database
    const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '../flarenode.sqlite');
    db = new sqlite3.Database(dbPath);
    console.log('✅ Connected to SQLite local file');
  }

  // Common schemas for both
  const queries = [
    `CREATE TABLE IF NOT EXISTS tactical_markers (
      id TEXT PRIMARY KEY,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      type TEXT,
      timestamp BIGINT,
      author_id TEXT,
      author_name TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS responders (
      id TEXT PRIMARY KEY,
      password_hash TEXT,
      name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS deleted_markers (
      id TEXT PRIMARY KEY,
      deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS mesh_authority (
      id INTEGER PRIMARY KEY,
      private_key TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS mesh_certs (
      id TEXT PRIMARY KEY,
      cert TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS connectivity_gaps (
      id TEXT PRIMARY KEY,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      timestamp BIGINT,
      reporter_id TEXT,
      reporter_name TEXT
    )`
  ];

  try {
    if (dbType === 'postgres') {
      for (const q of queries) await pool.query(q);
    } else {
      // SQLite needs to run queries sequentially
      for (const q of queries) {
        await new Promise((res, rej) => {
          db.run(q, (err) => err ? rej(err) : res());
        });
      }
    }
    // Roles were added after the first release. On a database that predates
    // them, add the column and make the original "admin" account an admin.
    try {
      const addRole = "ALTER TABLE responders ADD COLUMN role TEXT DEFAULT 'responder'";
      const promoteAdmin = "UPDATE responders SET role = 'admin' WHERE id = 'admin'";
      if (dbType === 'postgres') {
        await pool.query(addRole);
        await pool.query(promoteAdmin);
      } else {
        await new Promise((res, rej) => db.run(addRole, (err) => err ? rej(err) : res()));
        await new Promise((res, rej) => db.run(promoteAdmin, (err) => err ? rej(err) : res()));
      }
      console.log('✅ Added responder roles');
    } catch (err) {
      // Column already exists
    }
    // Signed mesh records are kept exactly as received, so they can be handed
    // to other phones with their signatures intact. Added after the first release.
    for (const statement of [
      'ALTER TABLE tactical_markers ADD COLUMN mesh TEXT',
      'ALTER TABLE deleted_markers ADD COLUMN record TEXT',
    ]) {
      try {
        if (dbType === 'postgres') await pool.query(statement);
        else await new Promise((res, rej) => db.run(statement, (err) => err ? rej(err) : res()));
      } catch (err) {
        // Column already exists
      }
    }
    console.log('✅ Database schemas initialized');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
};

// Wrapper to handle both DB types in the rest of the app
const query = async (text, params) => {
  if (dbType === 'postgres') {
    return pool.query(text, params);
  } else {
    return new Promise((res, rej) => {
      db.all(text.replace(/\$/g, '?'), params || [], (err, rows) => {
        if (err) rej(err);
        else res({ rows });
      });
    });
  }
};

const execute = async (text, params) => {
  if (dbType === 'postgres') {
    return pool.query(text, params);
  } else {
    return new Promise((res, rej) => {
      db.run(text.replace(/\$/g, '?'), params || [], function(err) {
        if (err) rej(err);
        else res({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
};

module.exports = { query, execute, initDb, dbType };
