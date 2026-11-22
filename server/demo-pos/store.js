import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { withTransaction } from '../database/connection.js';
import { priceCart } from './pricing.js';
import { PosRejectedError } from '../adapters/pos/PosAdapter.js';
import { hashPassword, verifyPassword, hashToken, newSessionToken } from '../lib/passwords.js';

/**
 * Demo POS data store — the POS system's OWN backend.
 *
 * This module is the only code permitted to touch `demo-pos.sqlite`. It is
 * reached two ways:
 *   1. the Demo POS's own manager/kitchen routes (a shop employee at the till), and
 *   2. DemoPosAdapter, which is the kiosk's client to the POS.
 *
 * The kiosk never imports this file. When a real client POS replaces the demo,
 * this module and its database disappear and only the adapter is rewritten.
 */

const SESSION_HOURS = 8;

export class DemoPosStore {
  constructor(db, { logger } = {}) {
    this.db = db;
    this.logger = logger;
  }

  // ---------------------------------------------------------------- config

  getConfig() {
    const rows = this.db.prepare('SELECT key, value FROM pos_store_config').all();
    const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      storeId: raw.store_id ?? 'store-demo',
      storeNameEn: raw.store_name_en ?? 'Bean & Bloom',
      storeNameAr: raw.store_name_ar ?? 'بين آند بلوم',
      currency: raw.currency ?? 'ILS',
      defaultTaxRateBp: Number(raw.default_tax_rate_bp ?? 1600),
      surchargeKind: raw.dine_in_surcharge_kind ?? 'none',
      surchargeValue: Number(raw.dine_in_surcharge_value ?? 0),
      surchargeLabelEn: raw.dine_in_surcharge_label_en ?? 'Dine-in service',
      surchargeLabelAr: raw.dine_in_surcharge_label_ar ?? 'خدمة الجلوس',
    };
  }

  setConfig(key, value, actor) {
    this.db
      .prepare(
        `INSERT INTO pos_store_config (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(value));
    this.audit(actor, 'config.changed', 'config', key, { value: String(value) });
  }

  // ------------------------------------------------------------------ audit

  audit(actor, eventType, entityType, entityId, payload = {}) {
    this.db
      .prepare(
        `INSERT INTO pos_audit_events (actor_type, actor_id, event_type, entity_type, entity_id, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(actor?.type ?? 'system', actor?.id ?? null, eventType, entityType, entityId ?? null, JSON.stringify(payload));
  }

  listAuditEvents(limit = 100) {
    return this.db
      .prepare(
        `SELECT id, actor_type AS actorType, actor_id AS actorId, event_type AS eventType,
                entity_type AS entityType, entity_id AS entityId, payload, created_at AS createdAt
         FROM pos_audit_events ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.min(Number(limit) || 100, 500))
      .map((row) => ({ ...row, payload: safeJson(row.payload) }));
  }

  // ------------------------------------------------------------------- menu

  /**
   * Fingerprint of everything the kiosk caches. Changes whenever a price,
   * availability flag, name or modifier changes, which is what lets the kiosk
   * detect "the menu moved" without diffing the whole catalog.
   */
  menuVersion() {
    const products = this.db
      .prepare('SELECT id, price_minor, available, tax_rate_bp, name_en, name_ar, display_order, updated_at FROM pos_products ORDER BY id')
      .all();
    const modifiers = this.db
      .prepare('SELECT id, price_delta_minor, available, name_en, updated_at FROM pos_modifiers ORDER BY id')
      .all();
    const groups = this.db
      .prepare('SELECT id, min_select, max_select, updated_at FROM pos_modifier_groups ORDER BY id')
      .all();
    const links = this.db
      .prepare('SELECT product_id, group_id, required, display_order FROM pos_product_modifier_groups ORDER BY product_id, group_id')
      .all();
    const config = this.db.prepare('SELECT key, value FROM pos_store_config ORDER BY key').all();
    const material = JSON.stringify({ products, modifiers, groups, links, config });
    return createHash('sha256').update(material).digest('hex').slice(0, 16);
  }

  /** Full canonical menu, modifier groups included. */
  getMenu() {
    const config = this.getConfig();
    const categories = this.db
      .prepare('SELECT id, name_en, name_ar, display_order FROM pos_categories WHERE active = 1 ORDER BY display_order, id')
      .all()
      .map((c) => ({ id: c.id, nameEn: c.name_en, nameAr: c.name_ar, displayOrder: c.display_order }));

    const productRows = this.db
      .prepare('SELECT * FROM pos_products ORDER BY display_order, id')
      .all();

    const groupRows = this.db
      .prepare(
        `SELECT l.product_id, g.id AS group_id, g.name_en, g.name_ar, g.min_select, g.max_select,
                l.required, l.display_order
         FROM pos_product_modifier_groups l
         JOIN pos_modifier_groups g ON g.id = l.group_id
         ORDER BY l.product_id, l.display_order, g.id`,
      )
      .all();

    const modifierRows = this.db
      .prepare('SELECT * FROM pos_modifiers ORDER BY group_id, display_order, id')
      .all();

    const modifiersByGroup = new Map();
    for (const row of modifierRows) {
      if (!modifiersByGroup.has(row.group_id)) modifiersByGroup.set(row.group_id, []);
      modifiersByGroup.get(row.group_id).push({
        modifierId: row.id,
        groupId: row.group_id,
        nameEn: row.name_en,
        nameAr: row.name_ar,
        priceDeltaMinor: row.price_delta_minor,
        available: Boolean(row.available),
        displayOrder: row.display_order,
      });
    }

    const groupsByProduct = new Map();
    for (const row of groupRows) {
      if (!groupsByProduct.has(row.product_id)) groupsByProduct.set(row.product_id, []);
      groupsByProduct.get(row.product_id).push({
        groupId: row.group_id,
        nameEn: row.name_en,
        nameAr: row.name_ar,
        minSelect: row.min_select,
        maxSelect: row.max_select,
        required: Boolean(row.required),
        displayOrder: row.display_order,
        modifiers: modifiersByGroup.get(row.group_id) ?? [],
      });
    }

    return {
      menuVersion: this.menuVersion(),
      currency: config.currency,
      defaultTaxRateBp: config.defaultTaxRateBp,
      storeId: config.storeId,
      categories,
      products: productRows.map((row) => ({
        posProductId: row.id,
        sku: row.sku,
        categoryId: row.category_id,
        nameEn: row.name_en,
        nameAr: row.name_ar,
        descriptionEn: row.description_en,
        descriptionAr: row.description_ar,
        priceMinor: row.price_minor,
        taxRateBp: row.tax_rate_bp,
        available: Boolean(row.available),
        displayOrder: row.display_order,
        imageHint: row.image_hint,
        modifierGroups: groupsByProduct.get(row.id) ?? [],
      })),
      retrievedAt: new Date().toISOString(),
    };
  }

  /** Cheap price/stock snapshot for frequent polling. */
  getAvailability() {
    return {
      menuVersion: this.menuVersion(),
      items: this.db
        .prepare('SELECT id, price_minor, available FROM pos_products ORDER BY id')
        .all()
        .map((r) => ({ posProductId: r.id, priceMinor: r.price_minor, available: Boolean(r.available) })),
    };
  }

  /** Catalog shaped for the pricing engine. */
  getCatalogMap() {
    const menu = this.getMenu();
    const catalog = new Map();
    for (const product of menu.products) {
      catalog.set(product.posProductId, { product, groups: product.modifierGroups });
    }
    return { catalog, menuVersion: menu.menuVersion };
  }

  // -------------------------------------------------------------- promotions

  findPromotion(code) {
    if (!code) return null;
    const row = this.db
      .prepare('SELECT * FROM pos_promotions WHERE code = ? AND active = 1')
      .get(String(code).trim().toUpperCase());
    if (!row) return null;
    const now = new Date().toISOString();
    if (row.starts_at && row.starts_at > now) return null;
    if (row.ends_at && row.ends_at < now) return null;
    return {
      id: row.id,
      code: row.code,
      kind: row.kind,
      value: row.value,
      minSubtotalMinor: row.min_subtotal_minor,
    };
  }

  // ------------------------------------------------------------------ quote

  /** Price a cart without creating anything. */
  calculateQuote(request) {
    const config = this.getConfig();
    const { catalog, menuVersion } = this.getCatalogMap();
    const promotionCode = request.promotionCode ? String(request.promotionCode).trim().toUpperCase() : null;
    let promotion = null;
    if (promotionCode) {
      promotion = this.findPromotion(promotionCode);
      if (!promotion) {
        throw new PosRejectedError('That promotion code is not valid.', {
          code: 'promotion_invalid',
          details: { promotionCode },
        });
      }
    }
    const quote = priceCart({ catalog, config, request, promotion });
    return { ...quote, menuVersion };
  }

  // ------------------------------------------------------------------ orders

  /**
   * Create an order. Idempotent on clientRequestId.
   *
   * Pricing happens INSIDE the transaction, deliberately. If a manager changes
   * a price between the kiosk's quote and this call, re-pricing here catches it
   * and the mismatch check rejects rather than charging a stale amount. Reading
   * the catalog and writing the order in one transaction closes that window.
   */
  createOrder(request, { actor } = {}) {
    const clientRequestId = String(request.clientRequestId ?? '').trim();
    if (!/^[\w-]{8,100}$/.test(clientRequestId)) {
      throw new PosRejectedError('A valid clientRequestId is required for safe retries.', {
        code: 'invalid_client_request_id',
      });
    }

    return withTransaction(this.db, () => {
      // --- idempotency: a retry returns the original order, never a second one
      const existing = this.db
        .prepare('SELECT id FROM pos_orders WHERE client_request_id = ?')
        .get(clientRequestId);
      if (existing) {
        const order = this.#readOrder(existing.id);
        return { ...order, duplicate: true };
      }

      const config = this.getConfig();
      const { catalog, menuVersion } = this.getCatalogMap();
      let promotion = null;
      if (request.promotionCode) {
        promotion = this.findPromotion(request.promotionCode);
        if (!promotion) {
          throw new PosRejectedError('That promotion code is not valid.', { code: 'promotion_invalid' });
        }
      }

      const quote = priceCart({ catalog, config, request, promotion });

      // --- the kiosk's expected total must match what the POS just computed
      if (Number.isInteger(request.expectedTotalMinor) && request.expectedTotalMinor !== quote.totalMinor) {
        throw new PosRejectedError('The price changed while you were ordering. Please review your order.', {
          code: 'total_mismatch',
          details: {
            expectedTotalMinor: request.expectedTotalMinor,
            authoritativeTotalMinor: quote.totalMinor,
            currency: quote.currency,
            menuVersion,
          },
        });
      }
      if (request.currency && request.currency !== quote.currency) {
        throw new PosRejectedError('Currency mismatch between kiosk and till.', {
          code: 'currency_mismatch',
          details: { kiosk: request.currency, pos: quote.currency },
        });
      }

      // An approved payment arriving with the order must cover the order
      // exactly. Without this check a payment of 19.00 could be attached to a
      // 22.00 order and the order still marked paid — a till discrepancy that
      // would only surface at cash-up. attachPayment() enforces the same rule
      // on the later-payment path; both doors need the same lock.
      if (request.payment) {
        const payment = request.payment;
        if (!['card_simulated', 'cash_counter', 'gift_card'].includes(payment.method)) {
          throw new PosRejectedError('Unknown payment method.', {
            code: 'invalid_payment_method',
            details: { method: payment.method },
          });
        }
        if (payment.status === 'approved') {
          if (!Number.isInteger(payment.amountMinor)) {
            throw new PosRejectedError('An approved payment must state a whole-number amount.', {
              code: 'invalid_payment_amount',
            });
          }
          if (payment.amountMinor !== quote.totalMinor) {
            throw new PosRejectedError('The payment amount does not match the order total.', {
              code: 'payment_amount_mismatch',
              details: {
                paymentAmountMinor: payment.amountMinor,
                orderTotalMinor: quote.totalMinor,
                currency: quote.currency,
              },
            });
          }
        }
      }

      const orderId = randomUUID();
      // Imported Version 3 history occupies a 9xxxxx band (see importV3.js).
      // The live counter must ignore it, or the first new kiosk order would be
      // numbered 901002 and a customer would be told to collect order 901002.
      const sequence = this.db
        .prepare('SELECT COALESCE(MAX(sequence), 1000) + 1 AS next FROM pos_orders WHERE sequence < 900000')
        .get().next;
      const orderNumber = String(sequence);

      this.db
        .prepare(
          `INSERT INTO pos_orders (
             id, order_number, sequence, client_request_id, channel, kiosk_id, store_id,
             fulfillment, table_number, status, kitchen_status, currency,
             items_subtotal_minor, surcharge_minor, discount_minor, total_minor, vat_included_minor,
             payment_status, payment_method, payment_reference, promotion_code, notes
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          orderId,
          orderNumber,
          sequence,
          clientRequestId,
          request.channel ?? 'kiosk',
          request.kioskId ?? null,
          config.storeId,
          quote.fulfillment,
          quote.tableNumber,
          'received',
          'queued',
          quote.currency,
          quote.itemsSubtotalMinor,
          quote.surchargeMinor,
          quote.discountMinor,
          quote.totalMinor,
          quote.vatIncludedMinor,
          request.payment?.status === 'approved' ? 'paid' : 'unpaid',
          request.payment?.method ?? null,
          request.payment?.reference ?? null,
          quote.promotionCode,
          typeof request.notes === 'string' ? request.notes.slice(0, 500) : '',
        );

      quote.lines.forEach((line, index) => {
        const itemId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO pos_order_items (
               id, order_id, product_id, name_snapshot_en, name_snapshot_ar, quantity,
               base_price_minor, unit_price_minor, line_total_minor, tax_rate_bp, line_index, notes
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            itemId, orderId, line.posProductId, line.nameEn, line.nameAr, line.quantity,
            line.basePriceMinor, line.unitPriceMinor, line.lineTotalMinor, line.taxRateBp, index, line.notes,
          );
        for (const modifier of line.modifiers) {
          this.db
            .prepare(
              `INSERT INTO pos_order_item_modifiers (
                 id, order_item_id, modifier_id, group_id, name_snapshot_en, name_snapshot_ar, price_delta_minor
               ) VALUES (?,?,?,?,?,?,?)`,
            )
            .run(randomUUID(), itemId, modifier.modifierId, modifier.groupId, modifier.nameEn, modifier.nameAr, modifier.priceDeltaMinor);
        }
      });

      if (request.payment) {
        this.#insertPayment(orderId, request.payment, quote.currency);
      }

      this.audit(actor ?? { type: 'kiosk', id: request.kioskId }, 'order.created', 'order', orderId, {
        orderNumber,
        kioskId: request.kioskId ?? null,
        totalMinor: quote.totalMinor,
        currency: quote.currency,
        lineCount: quote.lines.length,
        fulfillment: quote.fulfillment,
      });

      return { ...this.#readOrder(orderId), duplicate: false };
    });
  }

  #insertPayment(orderId, payment, currency) {
    // Only an adapter reference and masked metadata are ever stored. No PAN,
    // CVV, PIN or track data reaches this database.
    this.db
      .prepare(
        `INSERT INTO pos_payments (id, order_id, method, status, amount_minor, currency, reference, masked_detail, recorded_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        orderId,
        payment.method,
        payment.status,
        Number.isInteger(payment.amountMinor) ? payment.amountMinor : 0,
        currency,
        payment.reference ?? null,
        payment.maskedDetail ?? null,
        payment.recordedBy ?? null,
      );
  }

  #readOrder(orderId) {
    const row = this.db.prepare('SELECT * FROM pos_orders WHERE id = ?').get(orderId);
    if (!row) return null;
    const items = this.db
      .prepare('SELECT * FROM pos_order_items WHERE order_id = ? ORDER BY line_index')
      .all(orderId)
      .map((item) => ({
        posProductId: item.product_id,
        nameEn: item.name_snapshot_en,
        nameAr: item.name_snapshot_ar,
        quantity: item.quantity,
        basePriceMinor: item.base_price_minor,
        unitPriceMinor: item.unit_price_minor,
        lineTotalMinor: item.line_total_minor,
        taxRateBp: item.tax_rate_bp,
        notes: item.notes,
        modifiers: this.db
          .prepare('SELECT * FROM pos_order_item_modifiers WHERE order_item_id = ? ORDER BY group_id, modifier_id')
          .all(item.id)
          .map((m) => ({
            modifierId: m.modifier_id,
            groupId: m.group_id,
            nameEn: m.name_snapshot_en,
            nameAr: m.name_snapshot_ar,
            priceDeltaMinor: m.price_delta_minor,
          })),
      }));

    return {
      posOrderId: row.id,
      posOrderNumber: row.order_number,
      sequence: row.sequence,
      clientRequestId: row.client_request_id,
      channel: row.channel,
      kioskId: row.kiosk_id,
      storeId: row.store_id,
      fulfillment: row.fulfillment,
      tableNumber: row.table_number,
      status: row.status,
      kitchenStatus: row.kitchen_status,
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
      paymentReference: row.payment_reference,
      currency: row.currency,
      itemsSubtotalMinor: row.items_subtotal_minor,
      surchargeMinor: row.surcharge_minor,
      discountMinor: row.discount_minor,
      totalMinor: row.total_minor,
      vatIncludedMinor: row.vat_included_minor,
      promotionCode: row.promotion_code,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items,
    };
  }

  getOrder(posOrderId) {
    return this.#readOrder(posOrderId);
  }

  getOrderByClientRequestId(clientRequestId) {
    const row = this.db.prepare('SELECT id FROM pos_orders WHERE client_request_id = ?').get(clientRequestId);
    return row ? this.#readOrder(row.id) : null;
  }

  listOrders({ limit = 50, kitchenStatus = null } = {}) {
    const capped = Math.min(Number(limit) || 50, 200);
    const rows = kitchenStatus
      ? this.db
          .prepare('SELECT id FROM pos_orders WHERE kitchen_status = ? ORDER BY created_at DESC LIMIT ?')
          .all(kitchenStatus, capped)
      : this.db.prepare('SELECT id FROM pos_orders ORDER BY created_at DESC LIMIT ?').all(capped);
    return rows.map((r) => this.#readOrder(r.id));
  }

  /** Kitchen queue: what the barista actually needs to make. */
  listKitchenQueue() {
    return this.db
      .prepare(
        // Imported Version 3 orders are history, not work in progress: an
        // order closed months ago must never reappear on the barista's screen.
        `SELECT id FROM pos_orders
         WHERE kitchen_status IN ('queued','preparing','ready')
           AND channel != 'legacy_v3'
         ORDER BY created_at ASC LIMIT 100`,
      )
      .all()
      .map((r) => this.#readOrder(r.id));
  }

  updateKitchenStatus(posOrderId, kitchenStatus, actor) {
    const allowed = ['queued', 'preparing', 'ready', 'served', 'cancelled'];
    if (!allowed.includes(kitchenStatus)) {
      throw new PosRejectedError(`Kitchen status must be one of ${allowed.join(', ')}.`, { code: 'invalid_kitchen_status' });
    }
    return withTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM pos_orders WHERE id = ?').get(posOrderId);
      if (!row) throw new PosRejectedError('Order not found.', { code: 'order_not_found' });
      if (row.status === 'cancelled') {
        throw new PosRejectedError('A cancelled order cannot be changed.', { code: 'order_cancelled' });
      }
      // Carried over from V3: cancelling a PAID order must go through a refund
      // process, not a status flip, so money never silently disappears.
      if (kitchenStatus === 'cancelled' && row.payment_status === 'paid') {
        throw new PosRejectedError('This order is paid. A refund has to be processed before cancelling.', {
          code: 'refund_required',
        });
      }
      this.db
        .prepare(`UPDATE pos_orders SET kitchen_status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(kitchenStatus, posOrderId);
      if (kitchenStatus === 'served') {
        this.db.prepare(`UPDATE pos_orders SET status = 'completed' WHERE id = ?`).run(posOrderId);
      }
      if (kitchenStatus === 'cancelled') {
        this.db.prepare(`UPDATE pos_orders SET status = 'cancelled' WHERE id = ?`).run(posOrderId);
      }
      this.audit(actor, 'order.kitchen_status_changed', 'order', posOrderId, {
        from: row.kitchen_status,
        to: kitchenStatus,
      });
      return this.#readOrder(posOrderId);
    });
  }

  /**
   * Attach a payment outcome. Idempotent per reference: replaying the same
   * approval does not create a second payment row or double-count revenue.
   */
  attachPayment(posOrderId, payment, actor) {
    return withTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM pos_orders WHERE id = ?').get(posOrderId);
      if (!row) throw new PosRejectedError('Order not found.', { code: 'order_not_found' });

      if (payment.reference) {
        const already = this.db
          .prepare('SELECT id FROM pos_payments WHERE order_id = ? AND reference = ?')
          .get(posOrderId, payment.reference);
        if (already) return { ...this.#readOrder(posOrderId), duplicate: true };
      }

      if (payment.status === 'approved' && payment.amountMinor !== row.total_minor) {
        throw new PosRejectedError('Payment amount does not match the order total.', {
          code: 'payment_amount_mismatch',
          details: { paymentAmountMinor: payment.amountMinor, orderTotalMinor: row.total_minor },
        });
      }

      this.#insertPayment(posOrderId, payment, row.currency);

      if (payment.status === 'approved') {
        this.db
          .prepare(
            `UPDATE pos_orders SET payment_status = 'paid', payment_method = ?, payment_reference = ?,
                    status = CASE WHEN status = 'received' THEN 'accepted' ELSE status END,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?`,
          )
          .run(payment.method, payment.reference ?? null, posOrderId);
      }

      this.audit(actor, 'payment.recorded', 'order', posOrderId, {
        method: payment.method,
        status: payment.status,
        amountMinor: payment.amountMinor,
      });

      return { ...this.#readOrder(posOrderId), duplicate: false };
    });
  }

  // ------------------------------------------------------- manager mutations

  updateProduct(productId, changes, actor) {
    return withTransaction(this.db, () => {
      const before = this.db.prepare('SELECT * FROM pos_products WHERE id = ?').get(productId);
      if (!before) throw new PosRejectedError('Product not found.', { code: 'product_not_found' });

      const next = {
        price_minor: before.price_minor,
        available: before.available,
        name_en: before.name_en,
        name_ar: before.name_ar,
        description_en: before.description_en,
        description_ar: before.description_ar,
        tax_rate_bp: before.tax_rate_bp,
      };

      if (changes.priceMinor !== undefined) {
        if (!Number.isInteger(changes.priceMinor) || changes.priceMinor < 0 || changes.priceMinor > 1_000_000) {
          throw new PosRejectedError('Price must be a whole number of minor units between 0 and 1,000,000.', {
            code: 'invalid_price',
          });
        }
        next.price_minor = changes.priceMinor;
      }
      if (changes.available !== undefined) {
        if (typeof changes.available !== 'boolean') {
          throw new PosRejectedError('Availability must be true or false.', { code: 'invalid_availability' });
        }
        next.available = changes.available ? 1 : 0;
      }
      if (changes.taxRateBp !== undefined) {
        if (!Number.isInteger(changes.taxRateBp) || changes.taxRateBp < 0 || changes.taxRateBp > 100000) {
          throw new PosRejectedError('Tax rate must be between 0 and 100000 basis points.', { code: 'invalid_tax_rate' });
        }
        next.tax_rate_bp = changes.taxRateBp;
      }
      for (const [key, column] of [['nameEn', 'name_en'], ['nameAr', 'name_ar'], ['descriptionEn', 'description_en'], ['descriptionAr', 'description_ar']]) {
        if (changes[key] !== undefined) {
          const value = String(changes[key]).trim();
          if (column.startsWith('name') && value.length === 0) {
            throw new PosRejectedError('Name cannot be empty.', { code: 'invalid_name' });
          }
          next[column] = value.slice(0, 120);
        }
      }

      this.db
        .prepare(
          `UPDATE pos_products SET price_minor = ?, available = ?, name_en = ?, name_ar = ?,
                  description_en = ?, description_ar = ?, tax_rate_bp = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?`,
        )
        .run(next.price_minor, next.available, next.name_en, next.name_ar, next.description_en, next.description_ar, next.tax_rate_bp, productId);

      if (next.price_minor !== before.price_minor) {
        this.audit(actor, 'product.price_changed', 'product', productId, {
          fromMinor: before.price_minor,
          toMinor: next.price_minor,
        });
      }
      if (next.available !== before.available) {
        this.audit(actor, 'product.availability_changed', 'product', productId, {
          from: Boolean(before.available),
          to: Boolean(next.available),
        });
      }
      if (next.name_en !== before.name_en || next.name_ar !== before.name_ar
        || next.description_en !== before.description_en || next.description_ar !== before.description_ar) {
        this.audit(actor, 'product.details_changed', 'product', productId, {});
      }
      if (next.tax_rate_bp !== before.tax_rate_bp) {
        this.audit(actor, 'product.tax_rate_changed', 'product', productId, {
          from: before.tax_rate_bp, to: next.tax_rate_bp,
        });
      }

      return this.db.prepare('SELECT * FROM pos_products WHERE id = ?').get(productId);
    });
  }

  updateModifier(modifierId, changes, actor) {
    return withTransaction(this.db, () => {
      const before = this.db.prepare('SELECT * FROM pos_modifiers WHERE id = ?').get(modifierId);
      if (!before) throw new PosRejectedError('Option not found.', { code: 'modifier_not_found' });
      const priceDelta = changes.priceDeltaMinor === undefined ? before.price_delta_minor : changes.priceDeltaMinor;
      if (!Number.isInteger(priceDelta) || Math.abs(priceDelta) > 1_000_000) {
        throw new PosRejectedError('Option price must be a whole number of minor units.', { code: 'invalid_price' });
      }
      const available = changes.available === undefined ? before.available : (changes.available ? 1 : 0);
      this.db
        .prepare(`UPDATE pos_modifiers SET price_delta_minor = ?, available = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(priceDelta, available, modifierId);
      this.audit(actor, 'modifier.changed', 'modifier', modifierId, {
        fromMinor: before.price_delta_minor, toMinor: priceDelta,
        fromAvailable: Boolean(before.available), toAvailable: Boolean(available),
      });
      return this.db.prepare('SELECT * FROM pos_modifiers WHERE id = ?').get(modifierId);
    });
  }

  // -------------------------------------------------------------- gift cards

  findGiftCard(code) {
    if (!code) return null;
    const row = this.db
      .prepare('SELECT * FROM pos_gift_cards WHERE code = ? AND active = 1')
      .get(String(code).trim().toUpperCase());
    return row
      ? { id: row.id, code: row.code, balanceMinor: row.balance_minor, currency: row.currency }
      : null;
  }

  /** Atomic redeem: balance and ledger move together or not at all. */
  redeemGiftCard({ code, amountMinor, orderId = null }, actor) {
    return withTransaction(this.db, () => {
      const row = this.db
        .prepare('SELECT * FROM pos_gift_cards WHERE code = ? AND active = 1')
        .get(String(code).trim().toUpperCase());
      if (!row) throw new PosRejectedError('Gift card not found.', { code: 'gift_card_not_found' });
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new PosRejectedError('Redemption amount must be a positive whole number.', { code: 'invalid_amount' });
      }
      if (amountMinor > row.balance_minor) {
        throw new PosRejectedError('Gift card balance is not enough.', {
          code: 'insufficient_balance',
          details: { balanceMinor: row.balance_minor, requestedMinor: amountMinor },
        });
      }
      const balanceAfter = row.balance_minor - amountMinor;
      this.db
        .prepare(`UPDATE pos_gift_cards SET balance_minor = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(balanceAfter, row.id);
      this.db
        .prepare(
          `INSERT INTO pos_gift_card_ledger (id, gift_card_id, order_id, delta_minor, balance_after_minor, kind)
           VALUES (?,?,?,?,?,'redeem')`,
        )
        .run(randomUUID(), row.id, orderId, -amountMinor, balanceAfter);
      this.audit(actor, 'gift_card.redeemed', 'gift_card', row.id, { amountMinor, balanceAfterMinor: balanceAfter });
      return { code: row.code, redeemedMinor: amountMinor, balanceMinor: balanceAfter, currency: row.currency };
    });
  }

  // ------------------------------------------------------- users & sessions

  createUser({ username, role, password }, actor) {
    const { hash, salt } = hashPassword(password);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO pos_users (id, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
      .run(id, username, role, hash, salt);
    this.audit(actor, 'user.created', 'user', id, { username, role });
    return { id, username, role };
  }

  /**
   * Change a user's password.
   *
   * Every session for that user is destroyed in the same transaction. If a
   * password is being changed because it may have leaked, leaving old sessions
   * alive would defeat the point — whoever had the old password keeps their
   * access until the token expires.
   */
  setPassword(userId, newPassword, actor) {
    if (typeof newPassword !== 'string' || newPassword.length < 10) {
      throw new PosRejectedError('A password must be at least 10 characters.', {
        code: 'password_too_short',
      });
    }
    if (/^\d+$/.test(newPassword)) {
      throw new PosRejectedError('A password cannot be only digits.', {
        code: 'password_too_weak',
      });
    }
    return withTransaction(this.db, () => {
      const user = this.db.prepare('SELECT * FROM pos_users WHERE id = ?').get(userId);
      if (!user) throw new PosRejectedError('User not found.', { code: 'user_not_found' });

      const { hash, salt } = hashPassword(newPassword);
      this.db
        .prepare('UPDATE pos_users SET password_hash = ?, password_salt = ?, must_change = 0 WHERE id = ?')
        .run(hash, salt, userId);

      const removed = this.db.prepare('DELETE FROM pos_sessions WHERE user_id = ?').run(userId);
      this.audit(actor, 'user.password_changed', 'user', userId, {
        username: user.username,
        sessionsEnded: removed.changes ?? 0,
      });
      return { id: user.id, username: user.username, role: user.role, sessionsEnded: removed.changes ?? 0 };
    });
  }

  findUserByUsername(username) {
    const row = this.db
      .prepare('SELECT id, username, role FROM pos_users WHERE username = ?')
      .get(String(username ?? '').trim());
    return row ?? null;
  }

  listUsers() {
    return this.db.prepare('SELECT id, username, role, created_at AS createdAt FROM pos_users ORDER BY username').all();
  }

  authenticate(username, password) {
    const user = this.db.prepare('SELECT * FROM pos_users WHERE username = ?').get(String(username ?? '').trim());
    // Always run a verification so a missing username and a wrong password cost
    // the same time; otherwise valid usernames are discoverable by timing.
    const decoyHash = '0'.repeat(128);
    const ok = user
      ? verifyPassword(password, user.password_hash, user.password_salt)
      : verifyPassword(String(password ?? ''), decoyHash, 'decoy-salt') || false;
    if (!user || !ok) return null;
    return { id: user.id, username: user.username, role: user.role };
  }

  createSession(userId) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
    // Sessions live in SQLite, not an in-memory Map: V3 logged every employee
    // out whenever the API restarted, which is unacceptable mid-service.
    this.db.prepare('INSERT INTO pos_sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
      .run(hashToken(token), userId, expiresAt);
    return { token, expiresAt };
  }

  resolveSession(token) {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT s.expires_at, u.id, u.username, u.role
         FROM pos_sessions s JOIN pos_users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token));
    if (!row) return null;
    if (row.expires_at < new Date().toISOString()) {
      this.db.prepare('DELETE FROM pos_sessions WHERE token_hash = ?').run(hashToken(token));
      return null;
    }
    return { id: row.id, username: row.username, role: row.role };
  }

  destroySession(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM pos_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  purgeExpiredSessions() {
    const result = this.db.prepare('DELETE FROM pos_sessions WHERE expires_at < ?').run(new Date().toISOString());
    return result.changes ?? 0;
  }

  // ------------------------------------------------------------------ health

  health() {
    const started = process.hrtime.bigint();
    const row = this.db.prepare('SELECT COUNT(*) AS products FROM pos_products').get();
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { healthy: row.products > 0, latencyMs, detail: `${row.products} products` };
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export { randomBytes };
