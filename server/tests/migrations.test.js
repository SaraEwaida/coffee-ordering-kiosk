import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, withTransaction } from '../database/connection.js';
import { migrate } from '../database/migrate.js';

function makeMigrationsDir(files) {
  const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(resolve(dir, name), sql);
  return dir;
}

describe('migrations: runner', () => {
  test('applies in filename order and records each version', () => {
    const dir = makeMigrationsDir({
      '001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      '002_b.sql': 'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));',
    });
    try {
      const db = openDatabase(':memory:');
      const result = migrate(db, dir);
      assert.deepEqual(result.applied, ['001_a', '002_b']);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
      assert.ok(tables.includes('a') && tables.includes('b'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is idempotent: a second run applies nothing', () => {
    const dir = makeMigrationsDir({ '001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);' });
    try {
      const db = openDatabase(':memory:');
      migrate(db, dir);
      const second = migrate(db, dir);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.alreadyApplied, ['001_a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to run when an already-applied migration was edited', () => {
    const dir = makeMigrationsDir({ '001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);' });
    try {
      const db = openDatabase(':memory:');
      migrate(db, dir);
      // Someone edits a committed migration — a classic way to corrupt a schema.
      writeFileSync(resolve(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);');
      assert.throws(() => migrate(db, dir), /modified after it was applied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failing migration leaves the schema untouched', () => {
    const dir = makeMigrationsDir({
      '001_ok.sql': 'CREATE TABLE ok (id INTEGER PRIMARY KEY);',
      '002_bad.sql': 'CREATE TABLE good (id INTEGER); THIS IS NOT SQL;',
    });
    try {
      const db = openDatabase(':memory:');
      assert.throws(() => migrate(db, dir));
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      assert.ok(tables.includes('ok'), 'the first migration stays applied');
      assert.ok(!tables.includes('good'), 'the failed migration rolled back entirely');
      const recorded = db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version);
      assert.deepEqual(recorded, ['001_ok']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migrations: connection pragmas', () => {
  test('foreign keys are enforced', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id))');
    assert.throws(
      () => db.prepare('INSERT INTO child VALUES (?, ?)').run('c1', 'missing-parent'),
      /FOREIGN KEY/i,
      'a dangling reference must be rejected',
    );
  });

  test('withTransaction rolls back on a throw', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    assert.throws(() => withTransaction(db, () => {
      db.prepare('INSERT INTO t VALUES (1, ?)').run('first');
      db.prepare('INSERT INTO t VALUES (2, ?)').run('second');
      throw new Error('boom');
    }), /boom/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0, 'nothing may be left behind');
  });

  test('withTransaction commits on success and returns the value', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const result = withTransaction(db, () => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
  });
});

describe('migrations: real project schemas', () => {
  test('both schemas apply cleanly from scratch', () => {
    const posDb = openDatabase(':memory:');
    const posResult = migrate(posDb, resolve(import.meta.dirname, '../database/migrations/demo-pos'));
    assert.ok(posResult.applied.includes('001_init'));
    assert.ok(posResult.applied.includes('002_loyalty'));

    const kioskDb = openDatabase(':memory:');
    const kioskResult = migrate(kioskDb, resolve(import.meta.dirname, '../database/migrations/kiosk'));
    assert.ok(kioskResult.applied.includes('001_init'));
  });

  test('POS and kiosk schemas share no table names', () => {
    const posDb = openDatabase(':memory:');
    migrate(posDb, resolve(import.meta.dirname, '../database/migrations/demo-pos'));
    const kioskDb = openDatabase(':memory:');
    migrate(kioskDb, resolve(import.meta.dirname, '../database/migrations/kiosk'));

    const names = (db) => new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all().map((r) => r.name).filter((n) => n !== 'schema_migrations'),
    );
    const posTables = names(posDb);
    const kioskTables = names(kioskDb);
    for (const table of kioskTables) {
      assert.ok(!posTables.has(table), `${table} must not exist in both databases`);
    }
    // The separation is also visible in the prefixes.
    assert.ok([...posTables].every((t) => t.startsWith('pos_')), 'POS tables are pos_-prefixed');
    assert.ok([...kioskTables].every((t) => t.startsWith('kiosk')), 'kiosk tables are kiosk-prefixed');
  });

  test('money columns are integers, never REAL', () => {
    const posDb = openDatabase(':memory:');
    migrate(posDb, resolve(import.meta.dirname, '../database/migrations/demo-pos'));
    const tables = posDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pos_%'")
      .all().map((r) => r.name);
    for (const table of tables) {
      for (const column of posDb.prepare(`SELECT name, type FROM pragma_table_info('${table}')`).all()) {
        if (/_minor$|_cents$|price|amount|balance/i.test(column.name)) {
          assert.equal(column.type, 'INTEGER',
            `${table}.${column.name} holds money and must be INTEGER, not ${column.type}`);
        }
      }
    }
  });
});
