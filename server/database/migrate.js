import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { withTransaction } from './connection.js';

/**
 * Forward-only, versioned migration runner.
 *
 * Each migration is a numbered .sql file in a directory. A migration that has
 * already run is never re-run and never rewritten: changing a committed
 * migration is a mistake, so the runner records a checksum and refuses to
 * proceed if a previously applied file has been edited. New changes go in a new
 * file. Nothing here drops a table or deletes a row.
 */

function checksum(text) {
  // Deterministic, dependency-free FNV-1a. Not cryptographic — it only needs to
  // detect accidental edits to an applied migration.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
}

export function listMigrations(directory) {
  return readdirSync(directory)
    .filter((name) => extname(name) === '.sql')
    .sort()
    .map((name) => ({
      version: name.replace(/\.sql$/, ''),
      path: join(directory, name),
      sql: readFileSync(join(directory, name), 'utf8'),
    }));
}

export function migrate(db, directory, { logger = null } = {}) {
  ensureMigrationsTable(db);
  const applied = new Map(
    db.prepare('SELECT version, checksum FROM schema_migrations').all().map((row) => [row.version, row.checksum]),
  );
  const pending = [];

  for (const migration of listMigrations(directory)) {
    const sum = checksum(migration.sql);
    const previous = applied.get(migration.version);
    if (previous === undefined) {
      pending.push({ ...migration, checksum: sum });
      continue;
    }
    if (previous !== sum) {
      throw new Error(
        `Migration ${migration.version} was modified after it was applied ` +
          `(recorded ${previous}, file ${sum}). Applied migrations are immutable: ` +
          'revert the edit and add a new migration file instead.',
      );
    }
  }

  for (const migration of pending) {
    // Each migration is one transaction: a failure leaves the schema untouched.
    withTransaction(db, () => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)').run(
        migration.version,
        migration.checksum,
      );
    });
    logger?.info?.('migration.applied', { version: migration.version });
  }

  return { applied: pending.map((m) => m.version), alreadyApplied: [...applied.keys()] };
}
