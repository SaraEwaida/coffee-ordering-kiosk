#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase } from '../server/database/connection.js';
import { migrate } from '../server/database/migrate.js';
import { createLogger } from '../server/lib/logger.js';

/**
 * Apply pending migrations to both databases without starting the server.
 *
 * Forward-only and idempotent: already-applied migrations are skipped, and an
 * applied migration that has been edited stops the run rather than corrupting
 * the schema.
 */
const here = dirname(fileURLToPath(import.meta.url));
const logger = createLogger({ service: 'migrate' });

const targets = [
  { name: 'demo-pos', db: resolve(here, '../server/data/demo-pos.sqlite'), dir: resolve(here, '../server/database/migrations/demo-pos') },
  { name: 'kiosk', db: resolve(here, '../server/data/kiosk.sqlite'), dir: resolve(here, '../server/database/migrations/kiosk') },
];

let failed = false;
for (const target of targets) {
  const db = openDatabase(target.db);
  try {
    const result = migrate(db, target.dir, { logger });
    process.stdout.write(
      result.applied.length > 0
        ? `  ${target.name}: applied ${result.applied.join(', ')}\n`
        : `  ${target.name}: up to date (${result.alreadyApplied.length} migration(s))\n`,
    );
  } catch (error) {
    failed = true;
    process.stderr.write(`  ${target.name}: FAILED — ${error.message}\n`);
  } finally {
    closeDatabase(db);
  }
}
process.exit(failed ? 1 : 0);
