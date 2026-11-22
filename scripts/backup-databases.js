#!/usr/bin/env node
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copy every runtime database to a timestamped backup.
 *
 * Run this before any risky operation. WAL and shm siblings are copied too:
 * without them a copy can be missing the most recent commits.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../server/data');
const backupDir = resolve(dataDir, 'backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (!existsSync(dataDir)) {
  process.stdout.write('No server/data directory yet; nothing to back up.\n');
  process.exit(0);
}

mkdirSync(backupDir, { recursive: true });
const databases = readdirSync(dataDir).filter((name) => name.endsWith('.sqlite'));

if (databases.length === 0) {
  process.stdout.write('No .sqlite files found; nothing to back up.\n');
  process.exit(0);
}

for (const name of databases) {
  const source = resolve(dataDir, name);
  const target = resolve(backupDir, `${name}.${stamp}.bak`);
  copyFileSync(source, target);
  let copied = 1;
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) {
      copyFileSync(`${source}${suffix}`, `${target}${suffix}`);
      copied += 1;
    }
  }
  const size = (statSync(target).size / 1024).toFixed(1);
  process.stdout.write(`  ${basename(target)}  (${size} KB, ${copied} file(s))\n`);
}
process.stdout.write(`\nBacked up ${databases.length} database(s) to server/data/backups/\n`);
