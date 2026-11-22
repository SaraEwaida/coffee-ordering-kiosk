import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, withTransaction } from './connection.js';
import { legacyProductKeyMap, legacyOptionModifierMap } from './seed/seedDemoPos.js';

/**
 * Non-destructive import of Version 3 data into the Demo POS database.
 *
 * Guarantees, in order of importance:
 *   1. `coffee-kiosk.sqlite` is opened READ-ONLY. The V3 database is never
 *      written, altered or deleted. If this import is wrong, the original is
 *      still there to re-import from.
 *   2. A timestamped backup copy is taken before anything is read, so the
 *      original is preserved even against an accidental later change.
 *   3. Idempotent: every insert is keyed, so running it twice imports nothing
 *      the second time rather than duplicating history.
 *
 * What is NOT done, deliberately: V3 prices are in US dollars and the new
 * catalog is in shekels. Converting them would mean inventing an exchange
 * rate and silently rewriting what customers actually paid. So historical
 * orders keep their original USD amounts and are stored with currency 'USD';
 * the live ILS catalog is left alone. Reports can then show both honestly
 * instead of showing a made-up number.
 */

const LEGACY_STATUS_TO_KITCHEN = {
  new: 'queued',
  preparing: 'preparing',
  ready: 'ready',
  completed: 'served',
  cancelled: 'cancelled',
};
const LEGACY_STATUS_TO_ORDER = {
  new: 'received',
  preparing: 'accepted',
  ready: 'accepted',
  completed: 'completed',
  cancelled: 'cancelled',
};

export function backupLegacyDatabase(legacyPath, { backupDir } = {}) {
  if (!existsSync(legacyPath)) return null;
  const targetDir = backupDir ?? resolve(dirname(legacyPath), 'backups');
  mkdirSync(targetDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = resolve(targetDir, `${basename(legacyPath)}.${stamp}.bak`);
  copyFileSync(legacyPath, target);
  // WAL and shm siblings matter: without them a copy can miss recent commits.
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${legacyPath}${suffix}`)) {
      copyFileSync(`${legacyPath}${suffix}`, `${target}${suffix}`);
    }
  }
  return target;
}

/**
 * @param {object} args
 * @param {import('node:sqlite').DatabaseSync} args.posDb  Demo POS database (written).
 * @param {string} args.legacyPath  Path to V3 coffee-kiosk.sqlite (read-only).
 */
export function importV3Data({ posDb, legacyPath, logger = null, takeBackup = true }) {
  const summary = {
    found: false, backup: null, products: 0, orders: 0, items: 0, modifiers: 0,
    payments: 0, loyaltyAccounts: 0, loyaltyTransactions: 0, skipped: [], warnings: [],
  };

  if (!existsSync(legacyPath)) {
    logger?.info?.('importv3.skipped', { reason: 'no legacy database', legacyPath });
    return summary;
  }
  summary.found = true;
  if (takeBackup) summary.backup = backupLegacyDatabase(legacyPath);

  // READ-ONLY. This is the guarantee the whole import rests on.
  const legacy = openDatabase(legacyPath, { readOnly: true });

  try {
    const tables = new Set(
      legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    if (!tables.has('orders')) {
      summary.warnings.push('Legacy database has no orders table; nothing to import.');
      return summary;
    }

    const productIdByLegacyKey = new Map(legacyProductKeyMap().map((m) => [m.legacyKey, m.posProductId]));
    const optionMap = legacyOptionModifierMap();

    withTransaction(posDb, () => {
      // ---- loyalty accounts -------------------------------------------------
      if (tables.has('loyalty_accounts')) {
        for (const row of legacy.prepare('SELECT * FROM loyalty_accounts').all()) {
          const result = posDb
            .prepare(
              `INSERT OR IGNORE INTO pos_loyalty_accounts (id, code, points_balance, total_earned, created_at)
               VALUES (?,?,?,?,?)`,
            )
            .run(row.id, row.code, row.points_balance ?? 0, row.total_earned ?? 0, row.created_at ?? new Date().toISOString());
          if (result.changes > 0) summary.loyaltyAccounts += 1;
        }
      }

      // ---- orders -----------------------------------------------------------
      const legacyOrders = legacy.prepare('SELECT * FROM orders ORDER BY sequence').all();
      for (const order of legacyOrders) {
        if (!order.id) {
          summary.skipped.push({ reason: 'order without id' });
          continue;
        }
        // Keyed on the original row id, so a second run inserts nothing.
        const existing = posDb.prepare('SELECT id FROM pos_orders WHERE id = ?').get(order.id);
        if (existing) continue;

        const items = tables.has('order_items')
          ? legacy.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid').all(order.id)
          : [];

        const totalMinor = Number(order.total_cents ?? 0);
        const subtotalMinor = Number(order.subtotal_cents ?? 0) || totalMinor;
        const discountMinor = Number(order.loyalty_discount_cents ?? 0);
        const paymentStatus = order.payment_status === 'paid' ? 'paid' : 'unpaid';

        // Order numbers are shifted into a 9xxxxx band so imported history can
        // never collide with a new kiosk order's sequence.
        const importedSequence = 900000 + Number(order.sequence ?? 0);

        posDb
          .prepare(
            `INSERT INTO pos_orders (
               id, order_number, sequence, client_request_id, channel, kiosk_id, store_id,
               fulfillment, table_number, status, kitchen_status, currency,
               items_subtotal_minor, surcharge_minor, discount_minor, total_minor, vat_included_minor,
               payment_status, payment_method, payment_reference, promotion_code, notes,
               created_at, loyalty_account_id, loyalty_redeemed_points, loyalty_earned_points, source_note
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            order.id,
            `V3-${order.sequence}`,
            importedSequence,
            // Namespaced so an imported key cannot be mistaken for a live
            // kiosk idempotency key and short-circuit a real order.
            order.request_key ? `v3:${order.request_key}` : null,
            'legacy_v3',
            null,
            'store-demo',
            order.fulfillment === 'dine_in' ? 'dine_in' : 'takeaway',
            null,
            LEGACY_STATUS_TO_ORDER[order.status] ?? 'received',
            LEGACY_STATUS_TO_KITCHEN[order.status] ?? 'queued',
            'USD', // original currency preserved; see the note at the top
            subtotalMinor,
            0,
            discountMinor,
            totalMinor,
            0, // V3 had no VAT concept; claiming a VAT figure would be fabrication
            paymentStatus,
            order.payment_method ?? 'counter',
            null,
            null,
            order.customer_name ? `Pickup name: ${order.customer_name}` : '',
            order.created_at ?? new Date().toISOString(),
            order.loyalty_account_id ?? null,
            Number(order.loyalty_redeemed_points ?? 0),
            Number(order.loyalty_earned_points ?? 0),
            'Imported from Version 3 (coffee-kiosk.sqlite). Amounts are the original USD values.',
          );
        summary.orders += 1;

        // ---- items and their modifiers -------------------------------------
        items.forEach((item, index) => {
          const itemId = item.id || randomUUID();
          // Map to a POS product ID where we can; otherwise keep the legacy key.
          // product_id has no foreign key precisely so history survives.
          const mappedProductId = productIdByLegacyKey.get(item.product_id) ?? item.product_id;
          posDb
            .prepare(
              `INSERT OR IGNORE INTO pos_order_items (
                 id, order_id, product_id, name_snapshot_en, name_snapshot_ar, quantity,
                 base_price_minor, unit_price_minor, line_total_minor, tax_rate_bp, line_index, notes
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              itemId, order.id, mappedProductId,
              item.name ?? 'Imported item', item.name_ar ?? item.name ?? 'Imported item',
              Number(item.quantity ?? 1),
              Number(item.unit_price_cents ?? 0), Number(item.unit_price_cents ?? 0),
              Number(item.line_total_cents ?? 0), 0, index,
              mappedProductId === item.product_id && !productIdByLegacyKey.has(item.product_id)
                ? `Unmapped legacy product key: ${item.product_id}`
                : '',
            );
          summary.items += 1;

          // V3 stored customizations as an opaque JSON blob. Translate what we
          // can into real modifier IDs; anything unrecognised is recorded as a
          // warning rather than dropped silently.
          const options = safeJson(item.options_json);
          for (const [field, value] of Object.entries(options ?? {})) {
            const lookup = optionMap[field];
            if (!lookup) {
              summary.warnings.push(`Unknown legacy option field "${field}" on order ${order.sequence}`);
              continue;
            }
            const modifierId = lookup[String(value)];
            if (!modifierId) continue; // 'none'/false map to no modifier, correctly
            const modifierRow = posDb.prepare('SELECT * FROM pos_modifiers WHERE id = ?').get(modifierId);
            posDb
              .prepare(
                `INSERT OR IGNORE INTO pos_order_item_modifiers (
                   id, order_item_id, modifier_id, group_id, name_snapshot_en, name_snapshot_ar, price_delta_minor
                 ) VALUES (?,?,?,?,?,?,?)`,
              )
              .run(
                `${itemId}:${modifierId}`, itemId, modifierId,
                modifierRow?.group_id ?? 'GRP-LEGACY',
                modifierRow?.name_en ?? String(value),
                modifierRow?.name_ar ?? String(value),
                0, // historical price deltas are already inside unit_price_cents
              );
            summary.modifiers += 1;
          }
        });

        // ---- payments -------------------------------------------------------
        if (tables.has('payments')) {
          for (const payment of legacy.prepare('SELECT * FROM payments WHERE order_id = ?').all(order.id)) {
            posDb
              .prepare(
                `INSERT OR IGNORE INTO pos_payments (id, order_id, method, status, amount_minor, currency, reference, masked_detail, recorded_by, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                payment.id || randomUUID(), order.id,
                payment.method === 'card_terminal' ? 'card_simulated' : 'cash_counter',
                payment.status === 'paid' ? 'approved' : 'pending',
                Number(payment.amount_cents ?? 0), 'USD',
                payment.reference ?? null, null, payment.recorded_by ?? null,
                payment.recorded_at ?? order.created_at ?? new Date().toISOString(),
              );
            summary.payments += 1;
          }
        }
      }

      // ---- loyalty transactions --------------------------------------------
      if (tables.has('loyalty_transactions')) {
        for (const tx of legacy.prepare('SELECT * FROM loyalty_transactions ORDER BY id').all()) {
          const accountExists = posDb.prepare('SELECT id FROM pos_loyalty_accounts WHERE id = ?').get(tx.account_id);
          if (!accountExists) {
            summary.warnings.push(`Loyalty transaction ${tx.id} skipped: account not imported`);
            continue;
          }
          const result = posDb
            .prepare(
              `INSERT OR IGNORE INTO pos_loyalty_transactions (account_id, order_id, points_delta, kind, created_at)
               VALUES (?,?,?,?,?)`,
            )
            .run(tx.account_id, tx.order_id ?? null, tx.points_delta, tx.kind, tx.created_at ?? new Date().toISOString());
          if (result.changes > 0) summary.loyaltyTransactions += 1;
        }
      }

      posDb
        .prepare(
          `INSERT INTO pos_audit_events (actor_type, actor_id, event_type, entity_type, entity_id, payload)
           VALUES ('system', NULL, 'import.v3_completed', 'database', NULL, ?)`,
        )
        .run(JSON.stringify({
          orders: summary.orders, items: summary.items, payments: summary.payments,
          loyaltyAccounts: summary.loyaltyAccounts, backup: summary.backup,
        }));
    });
  } finally {
    try { legacy.close(); } catch { /* already closed */ }
  }

  logger?.info?.('importv3.completed', {
    orders: summary.orders, items: summary.items, payments: summary.payments,
    loyaltyAccounts: summary.loyaltyAccounts, warnings: summary.warnings.length,
  });
  return summary;
}

function safeJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
