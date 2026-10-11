import * as FileSystem from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { createSqlPersistence } from '../mesh/sqlPersistence.js';

/**
 * Where the mesh store lives on a phone.
 *
 * The store is kept in a SQLite database, one row per record, so a change
 * writes only what changed. If the database cannot be opened, the store falls
 * back to a single JSON file so the app still works; that path rewrites the
 * whole file on each change and is only meant as a safety net.
 */

const DATABASE_NAME = 'flarenode-mesh.db';
const SAVE_DELAY_MS = 400;

// expo-sqlite, behind the three functions sqlPersistence asks for
const openDatabase = async () => {
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME);
  return {
    exec: (sql) => database.execAsync(sql),
    run: (sql, params) => database.runAsync(sql, params),
    all: (sql, params) => database.getAllAsync(sql, params),
  };
};

/**
 * The fallback: every record in one JSON file.
 *
 * Changes arrive in bursts, so writes are held back briefly and the file is
 * replaced in one step, which means a crash mid-write cannot leave half a
 * file behind.
 */
export const filePersistence = (fileUri) => {
  const directory = fileUri.slice(0, fileUri.lastIndexOf('/') + 1);
  const temporary = `${fileUri}.tmp`;
  const key = (record) => `${record.collection}|${record.id}`;
  let records = null;
  let timer = null;
  let waiting = [];

  const read = async () => {
    if (records) return records;
    records = new Map();
    try {
      const info = await FileSystem.getInfoAsync(fileUri);
      if (info.exists) {
        for (const record of JSON.parse(await FileSystem.readAsStringAsync(fileUri))) records.set(key(record), record);
      }
    } catch (error) {
      console.warn('Could not read the mesh store file, starting empty:', error?.message || error);
    }
    return records;
  };

  const write = async () => {
    timer = null;
    const done = waiting;
    waiting = [];
    try {
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => {});
      await FileSystem.writeAsStringAsync(temporary, JSON.stringify([...records.values()]));
      await FileSystem.deleteAsync(fileUri, { idempotent: true });
      await FileSystem.moveAsync({ from: temporary, to: fileUri });
    } catch (error) {
      console.warn('Could not save the mesh store file:', error?.message || error);
    }
    done.forEach((resolve) => resolve());
  };

  const scheduleWrite = () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      if (!timer) timer = setTimeout(write, SAVE_DELAY_MS);
    });

  return {
    async load() {
      return [...(await read()).values()];
    },
    async saveRecords(changed) {
      const all = await read();
      for (const record of changed) all.set(key(record), record);
      return scheduleWrite();
    },
    async removeRecords(keys) {
      const all = await read();
      for (const item of keys) all.delete(key(item));
      return scheduleWrite();
    },
    async exists() {
      return (await FileSystem.getInfoAsync(fileUri)).exists;
    },
  };
};

/**
 * The store's persistence on a phone: the database, or the file if the
 * database will not open. An earlier build kept everything in the file; the
 * first time the database is used, those records are copied into it.
 */
export const phonePersistence = (legacyFileUri) => {
  let chosen = null;

  const choose = () => {
    if (!chosen) {
      chosen = (async () => {
        const file = filePersistence(legacyFileUri);
        try {
          const database = createSqlPersistence(await openDatabase());
          if ((await database.count()) === 0 && (await file.exists())) {
            const earlier = await file.load();
            if (earlier.length > 0) {
              await database.saveRecords(earlier);
              console.log(`Mesh store: moved ${earlier.length} records from the file into the database`);
            }
          }
          console.log(`Mesh store: using the database (${await database.count()} records on disk)`);
          return database;
        } catch (error) {
          console.warn('Mesh store: database unavailable, using the file instead:', error?.message || error);
          return file;
        }
      })();
    }
    return chosen;
  };

  return {
    load: async () => (await choose()).load(),
    saveRecords: async (records) => (await choose()).saveRecords(records),
    removeRecords: async (keys) => (await choose()).removeRecords(keys),
  };
};
