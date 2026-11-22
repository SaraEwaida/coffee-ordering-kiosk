#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { openDatabase, closeDatabase } from '../server/database/connection.js';
import { DemoPosStore } from '../server/demo-pos/store.js';
import { silentLogger } from '../server/lib/logger.js';

/**
 * Set a Demo POS password from the command line.
 *
 * The recovery path for when nobody can sign in: a forgotten manager password
 * would otherwise mean deleting the till database and losing its orders.
 *
 * The password is read from stdin with the terminal echo turned off, so it
 * does not end up in PowerShell history or in a process list the way a
 * command-line argument would.
 *
 *   npm run pos:password -- manager
 */

/**
 * Lines piped into stdin, read once.
 *
 * Creating a readline interface per prompt loses input when stdin is a pipe:
 * the first interface consumes the whole buffer and the second sees nothing.
 * So for non-TTY input everything is read up front and served in order.
 *
 * Declared here, above the top-level await below, because `let` is not
 * initialised until its own line is reached.
 */
let pipedLines = null;

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.POS_DB_PATH ?? resolve(here, '../server/data/demo-pos.sqlite');
const username = process.argv[2];

if (!username) {
  process.stderr.write(
    '\nUsage: npm run pos:password -- <username>\n'
    + '  e.g. npm run pos:password -- manager\n\n',
  );
  process.exit(1);
}

if (!existsSync(dbPath)) {
  process.stderr.write(
    `\nNo Demo POS database at:\n  ${dbPath}\n\n`
    + 'Start the platform once (npm run dev) to create it, then try again.\n\n',
  );
  process.exit(1);
}

const db = openDatabase(dbPath);
const store = new DemoPosStore(db, { logger: silentLogger });

try {
  const user = store.findUserByUsername(username);
  if (!user) {
    const known = store.listUsers().map((u) => `${u.username} (${u.role})`).join(', ') || 'none';
    process.stderr.write(`\nNo user "${username}". Accounts in this database: ${known}\n\n`);
    process.exit(1);
  }

  const password = await promptHidden(`New password for ${user.username} (${user.role}): `);
  const again = await promptHidden('Type it again: ');

  if (password !== again) {
    process.stderr.write('\nThe two passwords do not match. Nothing was changed.\n\n');
    process.exit(1);
  }

  const result = store.setPassword(user.id, password, { type: 'system', id: 'cli' });
  process.stdout.write(
    `\nPassword changed for ${result.username}.\n`
    + `${result.sessionsEnded} open session(s) were signed out.\n\n`,
  );
} catch (error) {
  process.stderr.write(`\n${error.message}\n\n`);
  process.exit(1);
} finally {
  closeDatabase(db);
}

async function readAllPipedLines() {
  if (pipedLines) return pipedLines;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return pipedLines;
}

/** Read a line without echoing it to the terminal. */
async function promptHidden(question) {
  const input = process.stdin;
  const output = process.stdout;

  if (!input.isTTY) {
    // Piped input, for scripting. The caller is responsible for not leaking it.
    const lines = await readAllPipedLines();
    return (lines.shift() ?? '').trim();
  }

  return new Promise((done, fail) => {
    output.write(question);
    const rl = createInterface({ input, output, terminal: true });
    // Swallow the echo so the password is not displayed or scrolled back to.
    const onData = () => { output.write(`\r${question}`); };
    input.on('data', onData);
    rl.question('', (answer) => {
      input.off('data', onData);
      rl.close();
      output.write('\n');
      done(answer.trim());
    });
    rl.on('error', fail);
  });
}
