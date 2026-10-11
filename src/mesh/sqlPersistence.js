/**
 * Saves the mesh store in a SQLite database.
 *
 * One row per record, so a change writes only the rows it touched instead of
 * the whole store, and a batch (a sync delivering many records) is written in
 * one transaction: all of it lands, or none.
 *
 * It talks to the database through three functions, which keeps this file
 * free of any particular SQLite library:
 *
 *   exec(sql)          run statements with no parameters
 *   run(sql, params)   run one statement with parameters
 *   all(sql, params)   run a query and return its rows as objects
 *
 * On a phone these are backed by expo-sqlite; in tests by Node's own SQLite.
 */
export function createSqlPersistence(db) {
  // SQLite allows one writer at a time, so writes queue behind each other
  let queue = Promise.resolve();
  const inOrder = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };

  const transaction = (task) =>
    inOrder(async () => {
      await db.exec('BEGIN');
      try {
        await task();
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
      }
    });

  const ready = inOrder(() =>
    db.exec(
      `CREATE TABLE IF NOT EXISTS mesh_records (
         collection TEXT NOT NULL,
         id TEXT NOT NULL,
         version TEXT NOT NULL,
         fields TEXT NOT NULL,
         auth TEXT,
         PRIMARY KEY (collection, id)
       )`
    ).then(() =>
      // Databases made before records were signed lack the column
      db.exec('ALTER TABLE mesh_records ADD COLUMN auth TEXT').catch(() => {})
    )
  );

  return {
    async load() {
      await ready;
      const rows = await inOrder(() => db.all('SELECT collection, id, version, fields, auth FROM mesh_records', []));
      const records = [];
      for (const row of rows) {
        try {
          const record = { collection: row.collection, id: row.id, version: row.version, fields: JSON.parse(row.fields) };
          if (row.auth) record.auth = JSON.parse(row.auth);
          records.push(record);
        } catch (error) {
          // One unreadable row should not cost the rest of the store
        }
      }
      return records;
    },

    async saveRecords(records) {
      if (records.length === 0) return;
      await ready;
      await transaction(async () => {
        for (const record of records) {
          await db.run('INSERT OR REPLACE INTO mesh_records (collection, id, version, fields, auth) VALUES (?, ?, ?, ?, ?)', [
            record.collection,
            record.id,
            record.version,
            JSON.stringify(record.fields),
            record.auth ? JSON.stringify(record.auth) : null,
          ]);
        }
      });
    },

    async removeRecords(keys) {
      if (keys.length === 0) return;
      await ready;
      await transaction(async () => {
        for (const key of keys) {
          await db.run('DELETE FROM mesh_records WHERE collection = ? AND id = ?', [key.collection, key.id]);
        }
      });
    },

    async count() {
      await ready;
      const rows = await inOrder(() => db.all('SELECT COUNT(*) AS n FROM mesh_records', []));
      return rows[0].n;
    },
  };
}
