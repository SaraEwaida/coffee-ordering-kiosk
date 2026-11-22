import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Opens a SQLite database with the pragmas this project depends on.
 *
 * - foreign_keys: the schema declares real foreign keys; SQLite ignores them
 *   unless this is ON, per connection.
 * - journal_mode WAL: a reader (kiosk polling the menu) does not block a writer
 *   (manager changing a price). Required for the 30-second sync to stay
 *   responsive while orders are being written.
 * - busy_timeout: wait rather than throw SQLITE_BUSY under brief contention.
 * - synchronous NORMAL: safe with WAL and much faster than FULL for a PoC.
 */
export function openDatabase(filePath, { readOnly = false } = {}) {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath, { readOnly });
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on any
 * throw. Used wherever more than one row must change atomically (an order and
 * its items, a gift-card redemption and its ledger entry).
 *
 * IMMEDIATE takes the write lock up front so two concurrent writers fail fast
 * at BEGIN instead of halfway through.
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A rollback failure must not mask the original error.
    }
    throw error;
  }
}

export function closeDatabase(db) {
  try {
    db.close();
  } catch {
    // Already closed.
  }
}
