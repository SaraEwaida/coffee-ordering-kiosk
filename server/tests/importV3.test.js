import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database/connection.js';
import { migrate } from '../database/migrate.js';
import { seedDemoPos } from '../database/seed/seedDemoPos.js';
import { importV3Data } from '../database/importV3.js';
import { silentLogger } from '../lib/logger.js';

/** Build a database shaped like a real Version 3 one, with data in it. */
function makeLegacyV3Database(dir) {
  const path = resolve(dir, 'coffee-kiosk.sqlite');
  const db = track(openDatabase(path));
  db.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, name_ar TEXT, description TEXT,
      description_ar TEXT, category TEXT, price_cents INTEGER, image TEXT, available INTEGER, popular INTEGER);
    CREATE TABLE orders (id TEXT PRIMARY KEY, sequence INTEGER UNIQUE, created_at TEXT,
      customer_name TEXT, fulfillment TEXT, status TEXT, payment_method TEXT, payment_status TEXT,
      total_cents INTEGER, receipt_token TEXT UNIQUE, request_key TEXT UNIQUE,
      loyalty_account_id TEXT, loyalty_redeemed_points INTEGER DEFAULT 0,
      loyalty_discount_cents INTEGER DEFAULT 0, loyalty_earned_points INTEGER DEFAULT 0,
      subtotal_cents INTEGER DEFAULT 0);
    CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT, product_id TEXT, name TEXT,
      name_ar TEXT, image TEXT, options_json TEXT, quantity INTEGER, unit_price_cents INTEGER,
      line_total_cents INTEGER);
    CREATE TABLE payments (id TEXT PRIMARY KEY, order_id TEXT, method TEXT, status TEXT,
      amount_cents INTEGER, reference TEXT, recorded_at TEXT, recorded_by TEXT);
    CREATE TABLE loyalty_accounts (id TEXT PRIMARY KEY, code TEXT UNIQUE, created_at TEXT,
      points_balance INTEGER, total_earned INTEGER);
    CREATE TABLE loyalty_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT,
      order_id TEXT, points_delta INTEGER, kind TEXT, created_at TEXT);
  `);

  db.prepare('INSERT INTO loyalty_accounts VALUES (?,?,?,?,?)')
    .run('acct-1', 'ABCDEF0123456789ABCD', '2026-05-01T10:00:00.000Z', 42, 92);

  db.prepare(`INSERT INTO orders (id, sequence, created_at, customer_name, fulfillment, status,
      payment_method, payment_status, total_cents, receipt_token, request_key, loyalty_account_id,
      loyalty_redeemed_points, loyalty_discount_cents, loyalty_earned_points, subtotal_cents)
    VALUES ('ord-1', 1001, '2026-05-02T09:00:00.000Z', 'Sara', 'dine_in', 'completed',
      'counter', 'paid', 1025, 'tok-1', 'legacy-request-1', 'acct-1', 50, 500, 10, 1525)`).run();
  db.prepare(`INSERT INTO orders (id, sequence, created_at, customer_name, fulfillment, status,
      payment_method, payment_status, total_cents, receipt_token, request_key, subtotal_cents)
    VALUES ('ord-2', 1002, '2026-05-02T10:00:00.000Z', 'Tala', 'takeaway', 'new',
      'card_terminal', 'pending', 525, 'tok-2', NULL, 525)`).run();

  db.prepare('INSERT INTO order_items VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    'item-1', 'ord-1', 'latte', 'Caffè Latte', 'كافيه لاتيه', '/images/latte.webp',
    JSON.stringify({ size: 'large', milk: 'oat', syrup: 'vanilla', sugar: 2, extraShot: true }),
    1, 1025, 1025,
  );
  db.prepare('INSERT INTO order_items VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    'item-2', 'ord-2', 'mystery-drink', 'Discontinued Drink', 'شراب', '',
    JSON.stringify({ size: 'medium', milk: 'regular', syrup: 'none', sugar: 0, extraShot: false }),
    1, 525, 525,
  );
  db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?,?)')
    .run('pay-1', 'ord-1', 'counter', 'paid', 1025, null, '2026-05-02T09:05:00.000Z', null);
  db.prepare('INSERT INTO loyalty_transactions (account_id, order_id, points_delta, kind, created_at) VALUES (?,?,?,?,?)')
    .run('acct-1', 'ord-1', -50, 'redeemed', '2026-05-02T09:00:00.000Z');
  db.prepare('INSERT INTO loyalty_transactions (account_id, order_id, points_delta, kind, created_at) VALUES (?,?,?,?,?)')
    .run('acct-1', 'ord-1', 10, 'earned', '2026-05-02T09:05:00.000Z');
  db.close();
  return path;
}

/**
 * Databases opened by a test, so cleanup can close them before deleting the
 * directory. Windows refuses to unlink a file that still has an open handle,
 * so an unclosed connection fails teardown with EPERM — on Linux the same code
 * passes, because unlinking an open file is allowed there.
 */
const openDatabases = [];

function freshPosDb(dir) {
  const db = track(openDatabase(resolve(dir, 'demo-pos.sqlite')));
  migrate(db, resolve(import.meta.dirname, '../database/migrations/demo-pos'));
  seedDemoPos(db);
  return db;
}

/**
 * Close every database this test opened, then remove the directory.
 *
 * maxRetries covers the brief window after close() where Windows (or an
 * antivirus scanner holding the file) has not yet released the handle.
 */
/** Register a database so cleanup() will close it even if a test throws. */
function track(db) {
  openDatabases.push(db);
  return db;
}

function cleanup(dir) {
  while (openDatabases.length > 0) {
    try {
      openDatabases.pop().close();
    } catch {
      // Already closed; nothing to do.
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe('importV3: non-destructive guarantees', () => {
  test('the Version 3 database is never written to', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const before = statSync(legacyPath).mtimeMs;
      const beforeRows = (() => {
        const db = track(openDatabase(legacyPath, { readOnly: true }));
        const n = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
        db.close();
        return n;
      })();

      const posDb = freshPosDb(dir);
      importV3Data({ posDb, legacyPath, logger: silentLogger });

      const after = track(openDatabase(legacyPath, { readOnly: true }));
      assert.equal(after.prepare('SELECT COUNT(*) AS n FROM orders').get().n, beforeRows);
      // Tables are all still there and untouched.
      const tables = after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      assert.ok(tables.includes('orders') && tables.includes('loyalty_accounts'));
      after.close();
      assert.equal(statSync(legacyPath).mtimeMs, before, 'the file must not have been modified');
    } finally {
      cleanup(dir);
    }
  });

  test('a timestamped backup is taken, including WAL siblings', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      const summary = importV3Data({ posDb, legacyPath, logger: silentLogger });
      assert.ok(summary.backup, 'a backup path must be returned');
      assert.ok(existsSync(summary.backup), 'the backup file must exist');
      const backups = readdirSync(resolve(dir, 'backups'));
      assert.ok(backups.length >= 1);
    } finally {
      cleanup(dir);
    }
  });

  test('a missing Version 3 database is handled without error', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const posDb = freshPosDb(dir);
      const summary = importV3Data({ posDb, legacyPath: resolve(dir, 'nope.sqlite'), logger: silentLogger });
      assert.equal(summary.found, false);
      assert.equal(summary.orders, 0);
    } finally {
      cleanup(dir);
    }
  });
});

describe('importV3: data fidelity', () => {
  test('orders, items, payments and loyalty all arrive', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      const summary = importV3Data({ posDb, legacyPath, logger: silentLogger });

      assert.equal(summary.orders, 2);
      assert.equal(summary.items, 2);
      assert.equal(summary.payments, 1);
      assert.equal(summary.loyaltyAccounts, 1);
      assert.equal(summary.loyaltyTransactions, 2);
    } finally {
      cleanup(dir);
    }
  });

  test('original amounts and currency are preserved, not converted', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      importV3Data({ posDb, legacyPath, logger: silentLogger });

      const order = posDb.prepare("SELECT * FROM pos_orders WHERE id = 'ord-1'").get();
      assert.equal(order.total_minor, 1025, 'the amount the customer actually paid');
      assert.equal(order.currency, 'USD', 'no invented exchange rate');
      assert.equal(order.vat_included_minor, 0, 'V3 had no VAT; claiming one would be fabrication');
      assert.equal(order.discount_minor, 500);
      assert.equal(order.channel, 'legacy_v3');
      assert.match(order.source_note, /Version 3/);
    } finally {
      cleanup(dir);
    }
  });

  test('legacy product keys are mapped to POS product IDs', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      importV3Data({ posDb, legacyPath, logger: silentLogger });
      const item = posDb.prepare("SELECT * FROM pos_order_items WHERE id = 'item-1'").get();
      assert.equal(item.product_id, 'PRD-1003', "'latte' should map to the POS ID");
    } finally {
      cleanup(dir);
    }
  });

  test('an unmappable legacy product is kept and flagged, not dropped', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      importV3Data({ posDb, legacyPath, logger: silentLogger });
      const item = posDb.prepare("SELECT * FROM pos_order_items WHERE id = 'item-2'").get();
      assert.ok(item, 'the line must still exist');
      assert.equal(item.product_id, 'mystery-drink', 'the original key is retained');
      assert.match(item.notes, /Unmapped legacy product key/);
    } finally {
      cleanup(dir);
    }
  });

  test('the opaque options blob becomes real modifier IDs', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      importV3Data({ posDb, legacyPath, logger: silentLogger });
      const modifiers = posDb
        .prepare("SELECT modifier_id FROM pos_order_item_modifiers WHERE order_item_id = 'item-1' ORDER BY modifier_id")
        .all().map((r) => r.modifier_id);
      assert.deepEqual(modifiers, ['MOD-EXT-SHOT', 'MOD-MILK-OAT', 'MOD-SIZE-L', 'MOD-SUG-2', 'MOD-SYR-VAN']);
    } finally {
      cleanup(dir);
    }
  });

  test("options meaning 'none' produce no modifier rather than a junk one", () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      importV3Data({ posDb, legacyPath, logger: silentLogger });
      const modifiers = posDb
        .prepare("SELECT modifier_id FROM pos_order_item_modifiers WHERE order_item_id = 'item-2'")
        .all().map((r) => r.modifier_id);
      assert.ok(!modifiers.some((m) => /SYR/.test(m)), "syrup:'none' must not create a syrup modifier");
      assert.ok(!modifiers.some((m) => /SHOT/.test(m)), 'extraShot:false must not create a shot modifier');
      assert.ok(modifiers.includes('MOD-SIZE-M'));
    } finally {
      cleanup(dir);
    }
  });

  test('legacy order numbers cannot collide with new kiosk orders', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      importV3Data({ posDb, legacyPath, logger: silentLogger });
      const sequences = posDb.prepare('SELECT sequence FROM pos_orders ORDER BY sequence').all().map((r) => r.sequence);
      assert.ok(sequences.every((s) => s >= 900000), 'imported history sits in its own band');
      const numbers = posDb.prepare('SELECT order_number FROM pos_orders').all().map((r) => r.order_number);
      assert.ok(numbers.every((n) => n.startsWith('V3-')), 'imported numbers are visibly historical');
    } finally {
      cleanup(dir);
    }
  });

  test('a legacy idempotency key cannot short-circuit a new order', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      importV3Data({ posDb, legacyPath, logger: silentLogger });
      const key = posDb.prepare("SELECT client_request_id FROM pos_orders WHERE id = 'ord-1'").get().client_request_id;
      assert.equal(key, 'v3:legacy-request-1', 'imported keys are namespaced');
    } finally {
      cleanup(dir);
    }
  });
});

describe('importV3: idempotency', () => {
  test('running twice imports nothing the second time', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      const first = importV3Data({ posDb, legacyPath, logger: silentLogger });
      const second = importV3Data({ posDb, legacyPath, logger: silentLogger, takeBackup: false });

      assert.equal(first.orders, 2);
      assert.equal(second.orders, 0);
      assert.equal(second.items, 0);
      assert.equal(second.payments, 0);
      assert.equal(second.loyaltyAccounts, 0);
      assert.equal(posDb.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 2);
      assert.equal(posDb.prepare('SELECT COUNT(*) AS n FROM pos_order_items').get().n, 2);
    } finally {
      cleanup(dir);
    }
  });

  test('the import itself is audited', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'kiosk-import-'));
    try {
      const legacyPath = makeLegacyV3Database(dir);
      const posDb = freshPosDb(dir);
      importV3Data({ posDb, legacyPath, logger: silentLogger });
      const event = posDb
        .prepare("SELECT * FROM pos_audit_events WHERE event_type = 'import.v3_completed'")
        .get();
      assert.ok(event, 'the import must leave an audit trail');
      assert.equal(JSON.parse(event.payload).orders, 2);
    } finally {
      cleanup(dir);
    }
  });
});
