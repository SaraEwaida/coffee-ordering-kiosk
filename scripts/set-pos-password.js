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
const runningAsCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const dbPath = process.env.POS_DB_PATH ?? resolve(here, '../server/data/demo-pos.sqlite');
const username = process.argv[2];

if (runningAsCli && !username) {
  process.stderr.write(
    '\nUsage: npm run pos:password -- <username>\n'
    + '  e.g. npm run pos:password -- manager\n\n',
  );
  process.exit(1);
}

if (runningAsCli && !existsSync(dbPath)) {
  process.stderr.write(
    `\nNo Demo POS database at:\n  ${dbPath}\n\n`
    + 'Start the platform once (npm run dev) to create it, then try again.\n\n',
  );
  process.exit(1);
}

if (runningAsCli) {
  await runCli();
}

async function runCli() {
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
}

async function readAllPipedLines(input = process.stdin) {
  if (pipedLines) return pipedLines;
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return pipedLines;
}

/**
 * Read a line without echoing it.
 *
 * Uses raw mode and reads keystrokes directly rather than readline. A readline
 * interface with `terminal: true` redraws the current line from its own
 * prompt, which wiped the question written before it and left the user staring
 * at a blank terminal with no indication anything was waiting for input.
 */
export async function promptHidden(question, { input = process.stdin, output = process.stdout } = {}) {

  if (!input.isTTY) {
    // Piped input, for scripting. The caller is responsible for not leaking it.
    const lines = await readAllPipedLines(input);
    return (lines.shift() ?? '').trim();
  }

  return new Promise((done) => {
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';
    // Escape-sequence state. An arrow key sends ESC [ A: the ESC is a control
    // character and gets filtered, but '[' and 'A' are printable and would be
    // inserted into the password. The user cannot see it happen, so they would
    // set a password containing characters they never typed and lock
    // themselves out.
    //   0 = normal
    //   1 = just saw ESC
    //   2 = inside a CSI sequence (ESC [ ... final), e.g. arrows, Delete
    //   3 = inside an SS3 sequence (ESC O x), e.g. F1-F4 on many terminals
    let escapeState = 0;

    const finish = (result, exitCode) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      output.write('\n');
      if (exitCode !== undefined) process.exit(exitCode);
      done(result);
    };

    function onData(chunk) {
      // A paste arrives as one chunk, so walk it character by character.
      for (const char of chunk) {
        // Swallow a whole escape sequence, not just its ESC byte.
        if (escapeState === 1) {
          if (char === '[') escapeState = 2;
          else if (char === 'O') escapeState = 3;
          else escapeState = 0;   // a lone ESC followed by one character
          continue;
        }
        if (escapeState === 2) {
          // A CSI sequence ends at the first byte in the range @ to ~.
          if (char >= '@' && char <= '~') escapeState = 0;
          continue;
        }
        if (escapeState === 3) {
          // SS3 carries exactly one final byte.
          escapeState = 0;
          continue;
        }
        if (char === '\u001b') { escapeState = 1; continue; }

        if (char === '\r' || char === '\n') return finish(value.trim());
        if (char === '\u0003') {                      // Ctrl+C
          output.write('\nCancelled. Nothing was changed.');
          return finish('', 130);
        }
        if (char === '\u0004') return finish(value.trim());   // Ctrl+D
        if (char === '\u007f' || char === '\b') {    // Backspace
          value = value.slice(0, -1);
          continue;
        }
        // Everything else printable is part of the password.
        if (char >= ' ') value += char;
      }
      return undefined;
    }

    input.on('data', onData);
  });
}
