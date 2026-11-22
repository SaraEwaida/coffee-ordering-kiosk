import { randomUUID } from 'node:crypto';
import { withTransaction } from '../database/connection.js';

/**
 * Kiosk-side data access for `kiosk.sqlite`.
 *
 * Holds only cache, kiosk-only presentation, and in-flight state. It knows
 * nothing about POS tables — authoritative data arrives through the POS
 * adapter. Nothing in here may be treated as a source of truth for price,
 * availability or order records.
 */
export class KioskStore {
  constructor(db, { logger } = {}) {
    this.db = db;
    this.logger = logger;
  }

  // ------------------------------------------------------------------ stores

  ensureStore(store) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO kiosk_stores
           (id, name_en, name_ar, currency, default_locale, dine_in_enabled, table_number_enabled,
            surcharge_kind, surcharge_value, surcharge_label_en, surcharge_label_ar)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        store.id, store.nameEn, store.nameAr, store.currency, store.defaultLocale ?? 'en',
        store.dineInEnabled === false ? 0 : 1, store.tableNumberEnabled ? 1 : 0,
        store.surchargeKind ?? 'none', store.surchargeValue ?? 0,
        store.surchargeLabelEn ?? 'Dine-in service', store.surchargeLabelAr ?? 'خدمة الجلوس',
      );
    this.db.prepare('INSERT OR IGNORE INTO kiosk_sync_state (store_id) VALUES (?)').run(store.id);
    return this.getStore(store.id);
  }

  getStore(storeId) {
    const row = this.db.prepare('SELECT * FROM kiosk_stores WHERE id = ?').get(storeId);
    if (!row) return null;
    return {
      id: row.id,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      currency: row.currency,
      defaultLocale: row.default_locale,
      dineInEnabled: Boolean(row.dine_in_enabled),
      tableNumberEnabled: Boolean(row.table_number_enabled),
      surchargeKind: row.surcharge_kind,
      surchargeValue: row.surcharge_value,
      surchargeLabelEn: row.surcharge_label_en,
      surchargeLabelAr: row.surcharge_label_ar,
      inactivityTimeoutSeconds: row.inactivity_timeout_seconds,
      menuSyncIntervalSeconds: row.menu_sync_interval_seconds,
    };
  }

  registerKiosk({ id, storeId, label, orientation = 'landscape_10', appVersion = 'dev' }) {
    this.db
      .prepare('INSERT OR IGNORE INTO kiosks (id, store_id, label, orientation, app_version) VALUES (?,?,?,?,?)')
      .run(id, storeId, label, orientation, appVersion);
    return this.db.prepare('SELECT * FROM kiosks WHERE id = ?').get(id);
  }

  heartbeat(kioskId, { appVersion } = {}) {
    this.db
      .prepare(
        `UPDATE kiosks SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                app_version = COALESCE(?, app_version) WHERE id = ?`,
      )
      .run(appVersion ?? null, kioskId);
  }

  // -------------------------------------------------------------- menu cache

  saveMenuCache(storeId, menu) {
    this.db
      .prepare(
        `INSERT INTO kiosk_menu_cache (store_id, payload, menu_version, synced_at)
         VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(store_id) DO UPDATE SET
           payload = excluded.payload, menu_version = excluded.menu_version, synced_at = excluded.synced_at`,
      )
      .run(storeId, JSON.stringify(menu), menu.menuVersion);
  }

  readMenuCache(storeId) {
    const row = this.db.prepare('SELECT * FROM kiosk_menu_cache WHERE store_id = ?').get(storeId);
    if (!row) return null;
    try {
      return { menu: JSON.parse(row.payload), menuVersion: row.menu_version, syncedAt: row.synced_at };
    } catch {
      // A corrupt cache must not take the kiosk down; treat it as absent.
      this.logger?.error?.('kiosk.menu_cache_corrupt', { storeId });
      return null;
    }
  }

  // -------------------------------------------------------------- sync state

  recordSyncAttempt(storeId, { success, latencyMs, error = null }) {
    this.db
      .prepare(
        `UPDATE kiosk_sync_state SET
           last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           attempts_total = attempts_total + 1,
           failures_total = failures_total + CASE WHEN ? THEN 0 ELSE 1 END,
           consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures + 1 END,
           last_success_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE last_success_at END,
           last_error = CASE WHEN ? THEN last_error ELSE ? END,
           last_error_at = CASE WHEN ? THEN last_error_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
           last_latency_ms = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE store_id = ?`,
      )
      .run(
        success ? 1 : 0, success ? 1 : 0, success ? 1 : 0,
        success ? 1 : 0, error, success ? 1 : 0,
        Math.round(latencyMs ?? 0), storeId,
      );
  }

  getSyncState(storeId) {
    const row = this.db.prepare('SELECT * FROM kiosk_sync_state WHERE store_id = ?').get(storeId);
    if (!row) return null;
    return {
      lastSuccessAt: row.last_success_at,
      lastAttemptAt: row.last_attempt_at,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
      consecutiveFailures: row.consecutive_failures,
      attemptsTotal: row.attempts_total,
      failuresTotal: row.failures_total,
      lastLatencyMs: row.last_latency_ms,
      errorRate: row.attempts_total === 0 ? 0 : Number((row.failures_total / row.attempts_total).toFixed(4)),
    };
  }

  // ---------------------------------------------------------------- overlays

  /**
   * Kiosk-only presentation data. Note what this cannot carry: there is no
   * price or availability field anywhere in the overlay table, so an overlay
   * is structurally incapable of overriding POS pricing or stock.
   */
  upsertOverlay(storeId, posProductId, overlay) {
    this.db
      .prepare(
        `INSERT INTO kiosk_content_overlays
           (store_id, pos_product_id, image_url, description_en, description_ar,
            allergens_en, allergens_ar, calories, display_order, hidden, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(store_id, pos_product_id) DO UPDATE SET
           image_url = excluded.image_url,
           description_en = excluded.description_en,
           description_ar = excluded.description_ar,
           allergens_en = excluded.allergens_en,
           allergens_ar = excluded.allergens_ar,
           calories = excluded.calories,
           display_order = excluded.display_order,
           hidden = excluded.hidden,
           updated_at = excluded.updated_at`,
      )
      .run(
        storeId, posProductId, overlay.imageUrl ?? null,
        overlay.descriptionEn ?? null, overlay.descriptionAr ?? null,
        overlay.allergensEn ?? null, overlay.allergensAr ?? null,
        Number.isInteger(overlay.calories) ? overlay.calories : null,
        Number.isInteger(overlay.displayOrder) ? overlay.displayOrder : null,
        overlay.hidden ? 1 : 0,
      );
  }

  getOverlays(storeId) {
    const rows = this.db.prepare('SELECT * FROM kiosk_content_overlays WHERE store_id = ?').all(storeId);
    return new Map(rows.map((row) => [row.pos_product_id, {
      imageUrl: row.image_url,
      descriptionEn: row.description_en,
      descriptionAr: row.description_ar,
      allergensEn: row.allergens_en,
      allergensAr: row.allergens_ar,
      calories: row.calories,
      displayOrder: row.display_order,
      hidden: Boolean(row.hidden),
    }]));
  }

  // ---------------------------------------------------------------- mappings

  upsertMapping(storeId, localKey, posProductId, kind = 'product') {
    this.db
      .prepare('INSERT OR REPLACE INTO kiosk_item_mappings (store_id, local_key, pos_product_id, kind) VALUES (?,?,?,?)')
      .run(storeId, localKey, posProductId, kind);
  }

  getMappings(storeId, kind = 'product') {
    const rows = this.db
      .prepare('SELECT local_key, pos_product_id FROM kiosk_item_mappings WHERE store_id = ? AND kind = ?')
      .all(storeId, kind);
    return new Map(rows.map((r) => [r.local_key, r.pos_product_id]));
  }

  resolveLocalKey(storeId, localKey, kind = 'product') {
    const row = this.db
      .prepare('SELECT pos_product_id FROM kiosk_item_mappings WHERE store_id = ? AND local_key = ? AND kind = ?')
      .get(storeId, localKey, kind);
    return row?.pos_product_id ?? null;
  }

  // ------------------------------------------------------- integration issues

  /** Records an integration fault once, counting repeats instead of flooding. */
  recordIntegrationIssue(storeId, kind, detail) {
    this.db
      .prepare(
        `INSERT INTO kiosk_integration_issues (store_id, kind, detail)
         VALUES (?,?,?)
         ON CONFLICT(store_id, kind, detail) DO UPDATE SET
           occurrences = occurrences + 1,
           last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           resolved = 0`,
      )
      .run(storeId, kind, String(detail).slice(0, 500));
    this.logger?.warn?.('kiosk.integration_issue', { storeId, kind, detail });
  }

  listIntegrationIssues({ includeResolved = false, limit = 100 } = {}) {
    const sql = includeResolved
      ? 'SELECT * FROM kiosk_integration_issues ORDER BY last_seen_at DESC LIMIT ?'
      : 'SELECT * FROM kiosk_integration_issues WHERE resolved = 0 ORDER BY last_seen_at DESC LIMIT ?';
    return this.db.prepare(sql).all(Math.min(Number(limit) || 100, 500));
  }

  // ------------------------------------------------------------------ events

  logEvent({ storeId = null, kioskId = null, level = 'info', eventType, message = '', payload = {} }) {
    this.db
      .prepare(
        'INSERT INTO kiosk_events (store_id, kiosk_id, level, event_type, message, payload) VALUES (?,?,?,?,?,?)',
      )
      .run(storeId, kioskId, level, eventType, String(message).slice(0, 500), JSON.stringify(payload));
  }

  listEvents({ limit = 100, eventType = null } = {}) {
    const capped = Math.min(Number(limit) || 100, 500);
    const rows = eventType
      ? this.db.prepare('SELECT * FROM kiosk_events WHERE event_type = ? ORDER BY id DESC LIMIT ?').all(eventType, capped)
      : this.db.prepare('SELECT * FROM kiosk_events ORDER BY id DESC LIMIT ?').all(capped);
    return rows.map((row) => ({ ...row, payload: safeJson(row.payload) }));
  }

  // ------------------------------------------------------------------ quotes

  /**
   * Store the POS's quote server-side and hand the client only an ID. The
   * browser never gets to tell us what an order costs; at checkout we re-read
   * this row and re-validate it against the POS.
   */
  createQuote({ storeId, kioskId, request, quote, menuVersion, ttlSeconds = 600 }) {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO kiosk_quotes (id, store_id, kiosk_id, request_payload, quote_payload, currency, total_minor, menu_version, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, storeId, kioskId ?? null, JSON.stringify(request), JSON.stringify(quote), quote.currency, quote.totalMinor, menuVersion, expiresAt);
    return { id, expiresAt };
  }

  getQuote(quoteId) {
    const row = this.db.prepare('SELECT * FROM kiosk_quotes WHERE id = ?').get(quoteId);
    if (!row) return null;
    return {
      id: row.id,
      storeId: row.store_id,
      kioskId: row.kiosk_id,
      request: safeJson(row.request_payload),
      quote: safeJson(row.quote_payload),
      currency: row.currency,
      totalMinor: row.total_minor,
      menuVersion: row.menu_version,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      expired: row.expires_at < new Date().toISOString(),
    };
  }

  markQuote(quoteId, status) {
    this.db.prepare('UPDATE kiosk_quotes SET status = ? WHERE id = ?').run(status, quoteId);
  }

  /** Any open quote priced against a superseded menu is no longer trustworthy. */
  invalidateQuotesForMenuChange(storeId, currentMenuVersion) {
    const result = this.db
      .prepare(`UPDATE kiosk_quotes SET status = 'invalidated' WHERE store_id = ? AND status = 'open' AND menu_version != ?`)
      .run(storeId, currentMenuVersion);
    return result.changes ?? 0;
  }

  // ------------------------------------------------------- submission queue

  /**
   * The idempotency ledger and the retry queue, in one durable table.
   *
   * `client_request_id` is UNIQUE, so a duplicate POST can only ever return
   * the original outcome. Rows persist across restarts, so an order that was
   * accepted while the POS was unreachable is still waiting when it returns.
   */
  createSubmission({ clientRequestId, storeId, kioskId, quoteId, payload, paymentAccepted = false, paymentReference = null }) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO kiosk_order_submissions
           (id, client_request_id, store_id, kiosk_id, quote_id, payload, status, payment_accepted, payment_reference, next_attempt_at)
         VALUES (?,?,?,?,?,?, 'pending', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(id, clientRequestId, storeId, kioskId ?? null, quoteId ?? null, JSON.stringify(payload), paymentAccepted ? 1 : 0, paymentReference);
    return this.getSubmissionById(id);
  }

  getSubmissionById(id) {
    return hydrateSubmission(this.db.prepare('SELECT * FROM kiosk_order_submissions WHERE id = ?').get(id));
  }

  findSubmission(clientRequestId) {
    return hydrateSubmission(
      this.db.prepare('SELECT * FROM kiosk_order_submissions WHERE client_request_id = ?').get(clientRequestId),
    );
  }

  markSubmissionSubmitted(id, { posOrderId, posOrderNumber }) {
    this.db
      .prepare(
        `UPDATE kiosk_order_submissions SET status = 'submitted', pos_order_id = ?, pos_order_number = ?,
                last_error = NULL, next_attempt_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(posOrderId, posOrderNumber, id);
    return this.getSubmissionById(id);
  }

  /**
   * Record a failed attempt and schedule the next one with exponential
   * backoff, capped. An order whose payment was accepted is never abandoned,
   * however many times it fails — it has to become an ops exception instead,
   * because the customer's money has already moved.
   */
  markSubmissionFailed(id, { error, retryable = true, maxAttempts = 8 }) {
    const current = this.getSubmissionById(id);
    if (!current) return null;
    const attempts = current.attempts + 1;
    const backoffSeconds = Math.min(2 ** Math.min(attempts, 6), 60);
    const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
    const giveUp = !retryable || (attempts >= maxAttempts && !current.paymentAccepted);

    this.db
      .prepare(
        `UPDATE kiosk_order_submissions SET
           status = ?, attempts = ?, last_error = ?,
           last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           next_attempt_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(
        giveUp ? (current.paymentAccepted ? 'pending' : 'failed') : 'pending',
        attempts,
        String(error).slice(0, 500),
        giveUp && !current.paymentAccepted ? null : nextAttemptAt,
        id,
      );
    return this.getSubmissionById(id);
  }

  /** Pending submissions whose backoff has elapsed. */
  listDueSubmissions({ limit = 20 } = {}) {
    return this.db
      .prepare(
        `SELECT * FROM kiosk_order_submissions
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(Math.min(Number(limit) || 20, 100))
      .map(hydrateSubmission);
  }

  /**
   * Submissions needing human attention: payment was accepted but no POS order
   * exists. These must never be silently dropped.
   */
  listOpsExceptions() {
    return this.db
      .prepare(
        `SELECT * FROM kiosk_order_submissions
         WHERE payment_accepted = 1 AND status != 'submitted'
         ORDER BY created_at ASC`,
      )
      .all()
      .map(hydrateSubmission);
  }

  countSubmissions() {
    return this.db
      .prepare(
        // COALESCE because SUM over zero rows is NULL, and a fleet dashboard
        // showing "null pending" instead of "0 pending" looks like a fault.
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END), 0) AS submitted,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN payment_accepted = 1 AND status != 'submitted' THEN 1 ELSE 0 END), 0) AS opsExceptions
         FROM kiosk_order_submissions`,
      )
      .get();
  }

  transaction(fn) {
    return withTransaction(this.db, fn);
  }
}

function hydrateSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    storeId: row.store_id,
    kioskId: row.kiosk_id,
    quoteId: row.quote_id,
    payload: safeJson(row.payload),
    status: row.status,
    posOrderId: row.pos_order_id,
    posOrderNumber: row.pos_order_number,
    attempts: row.attempts,
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    paymentAccepted: Boolean(row.payment_accepted),
    paymentReference: row.payment_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
