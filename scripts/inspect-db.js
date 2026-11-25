/**
 * Read-only inspector for both kiosk databases.
 *
 *   npm run db:inspect                 summary of both databases
 *   npm run db:inspect -- pos          Demo POS tables only
 *   npm run db:inspect -- kiosk        kiosk tables only
 *   npm run db:inspect -- tables       list every table with a row count
 *   npm run db:inspect -- "SELECT ..." run one read-only query
 *
 * The databases are opened read-only, so nothing here can modify or corrupt
 * live demo data. Anything that is not a SELECT or PRAGMA is refused rather
 * than run.
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '../server/data');

const DBS = {
  pos: { file: resolve(DATA, 'demo-pos.sqlite'), label: 'Demo POS  (the shop\'s till - source of truth)' },
  kiosk: { file: resolve(DATA, 'kiosk.sqlite'), label: 'Kiosk     (our ordering channel - cache and config)' },
};

/** Money is stored in minor units; show it the way a person reads it. */
const money = (minor, currency = 'ILS') =>
  minor == null ? '' : `${(minor / 100).toFixed(2)} ${currency}`;

const VIEWS = {
  pos: {
    'Products and prices': `
      SELECT p.id, p.name_en AS name, c.name_en AS category,
             p.price_minor, p.available
      FROM pos_products p LEFT JOIN pos_categories c ON c.id = p.category_id
      ORDER BY c.display_order, p.display_order`,
    'Recent orders': `
      SELECT sequence AS num, created_at, channel, fulfillment,
             payment_status, kitchen_status, total_minor
      FROM pos_orders WHERE channel != 'legacy_v3'
      ORDER BY created_at DESC LIMIT 10`,
    'Recent payments': `
      SELECT order_id, method, status, amount_minor, reference, masked_detail, created_at
      FROM pos_payments ORDER BY rowid DESC LIMIT 10`,
    'Gift cards': `SELECT code, balance_minor, active FROM pos_gift_cards LIMIT 10`,
    'Loyalty accounts': `
      SELECT substr(code,1,3) || '...' || substr(code,-3) AS code,
             points_balance, total_earned FROM pos_loyalty_accounts LIMIT 10`,
    'Staff': `SELECT username, role, must_change FROM pos_users`,
    'Audit trail': `
      SELECT actor_type, actor_id, event_type, created_at
      FROM pos_audit_events ORDER BY rowid DESC LIMIT 10`,
  },
  kiosk: {
    'Registered kiosks': `SELECT id, store_id, label, orientation, app_version, last_heartbeat_at FROM kiosks`,
    'Menu sync state': `
      SELECT store_id, last_success_at, consecutive_failures, attempts_total,
             failures_total, last_latency_ms, last_error FROM kiosk_sync_state`,
    'Order submissions': `
      SELECT substr(client_request_id,1,14) || '...' AS request, status,
             pos_order_number, attempts, payment_accepted, last_error, updated_at
      FROM kiosk_order_submissions ORDER BY rowid DESC LIMIT 10`,
    'Payment sessions': `
      SELECT substr(id,1,10) || '...' AS id, state, method, amount_minor,
             gift_applied_minor, card_amount_minor, order_submitted, created_at
      FROM kiosk_payment_sessions ORDER BY rowid DESC LIMIT 10`,
    'Digital receipts': `
      SELECT substr(token,1,8) || '...' AS token, pos_order_number,
             view_count, expires_at FROM kiosk_receipts ORDER BY rowid DESC LIMIT 10`,
    'Integration issues': `
      SELECT kind, detail, resolved, occurrences, last_seen_at
      FROM kiosk_integration_issues ORDER BY rowid DESC LIMIT 10`,
    'Content overlays': `
      SELECT pos_product_id, image_url, calories FROM kiosk_content_overlays LIMIT 10`,
  },
};

function open(key) {
  const { file } = DBS[key];
  if (!existsSync(file)) {
    console.log(`\n  ${file} does not exist yet. Start the app once to create it.`);
    return null;
  }
  return new DatabaseSync(file, { readOnly: true });
}

function show(key) {
  const db = open(key);
  if (!db) return;
  console.log(`\n${'='.repeat(74)}\n ${DBS[key].label}\n${'='.repeat(74)}`);
  for (const [title, sql] of Object.entries(VIEWS[key])) {
    let rows;
    try {
      rows = db.prepare(sql).all();
    } catch (error) {
      console.log(`\n${title}: (${error.message})`);
      continue;
    }
    console.log(`\n${title}  [${rows.length}]`);
    if (!rows.length) { console.log('  (empty)'); continue; }
    console.table(rows.map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) {
        out[k.endsWith('_minor') ? k.replace('_minor', '') : k] =
          k.endsWith('_minor') ? money(v) : v;
      }
      return out;
    }));
  }
  db.close();
}

function listTables() {
  for (const key of Object.keys(DBS)) {
    const db = open(key);
    if (!db) continue;
    console.log(`\n${DBS[key].label}`);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    console.table(tables.map(({ name }) => ({
      table: name,
      rows: db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,
    })));
    db.close();
  }
}

function runQuery(sql) {
  if (!/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
    console.error('\n  Refused: this inspector runs SELECT, WITH and PRAGMA only.\n');
    process.exit(1);
  }
  for (const key of Object.keys(DBS)) {
    const db = open(key);
    if (!db) continue;
    try {
      const rows = db.prepare(sql).all();
      console.log(`\n${DBS[key].label}  [${rows.length} rows]`);
      rows.length ? console.table(rows) : console.log('  (no rows)');
    } catch {
      // Table lives in the other database; that is expected, not an error.
    }
    db.close();
  }
}

const arg = process.argv.slice(2).join(' ').trim();
if (!arg) { show('pos'); show('kiosk'); }
else if (arg === 'pos' || arg === 'kiosk') show(arg);
else if (arg === 'tables') listTables();
else runQuery(arg);
console.log('');
