const { execute, initDb } = require('./src/db');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function seed() {
  try {
    await initDb();
    const password = process.env.SEED_PASSWORD;
    if (!password) throw new Error('SEED_PASSWORD must be set (see mothership-server/.env.example)');
    const hash = await bcrypt.hash(password, 10);
    
    const responders = [
      ['admin', 'Super User', 'admin'],
      ['alpha', 'Responder Alpha', 'responder'],
      ['bravo', 'Responder Bravo', 'responder'],
    ];

    for (const [id, name, role] of responders) {
      await execute(
        'INSERT OR REPLACE INTO responders (id, password_hash, name, role) VALUES (?, ?, ?, ?)',
        [id, hash, name, role]
      );
    }

    console.log(`✅ Seed successful: users ${responders.map(([id]) => `"${id}"`).join(', ')} created with the password from SEED_PASSWORD`);
  } catch (err) {
    console.error('Seed failed:', err);
  }
}

seed();
