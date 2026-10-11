const { execute, initDb } = require('./db');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function runSeed() {
  try {
    await initDb();
    const password = process.env.SEED_PASSWORD;
    if (!password) throw new Error('SEED_PASSWORD must be set (see mothership-server/.env.example)');
    const hash = await bcrypt.hash(password, 10);
    
    await execute(
      'INSERT OR REPLACE INTO responders (id, password_hash, name, role) VALUES (?, ?, ?, ?)',
      ['admin', hash, 'Super User', 'admin']
    );
    
    console.log('✅ SUCCESS: User "admin" created in SQLite!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  }
}

runSeed();
