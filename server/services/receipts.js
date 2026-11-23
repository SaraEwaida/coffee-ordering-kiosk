import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';

/**
 * Digital receipts.
 *
 * Two rules shape this file.
 *
 * 1. The URL must be reachable from a customer's phone. A kiosk serving
 *    `http://localhost:3001` prints a QR code that works on exactly one
 *    device: the kiosk itself. So the origin defaults to the machine's LAN
 *    address, and is overridable for a real deployment behind a domain.
 *
 * 2. The token is a bearer credential. Anyone with the link can read the
 *    receipt, so it is long and random, it expires, and the payload holds no
 *    customer name, phone number or payment instrument detail.
 */

const TOKEN_BYTES = 32;
const DEFAULT_TTL_HOURS = 72;

/** Token format, also used to reject malformed lookups before touching the DB. */
export const RECEIPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Best-guess LAN address of this machine.
 *
 * Returns null rather than guessing wrong when there is no non-internal IPv4
 * interface; the caller then falls back to the configured origin and the QR is
 * suppressed instead of printing a dead link.
 */
export function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

/**
 * Where a phone should fetch receipts from.
 *
 * PUBLIC_RECEIPT_ORIGIN wins, because a deployed kiosk sits behind a real
 * hostname and TLS. Without it we use the LAN address, which is right for a
 * demo on a shop's wifi. Null means we could not work out a reachable origin,
 * and the caller must not render a QR code.
 */
export function receiptOrigin({ env = process.env, port } = {}) {
  const configured = env.PUBLIC_RECEIPT_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host = lanAddress();
  if (!host) return null;
  return `http://${host}:${port ?? env.PORT ?? 3001}`;
}

export class ReceiptService {
  constructor({ kioskStore, adapter, storeId, logger, ttlHours = DEFAULT_TTL_HOURS, origin } = {}) {
    this.db = kioskStore.db;
    this.kioskStore = kioskStore;
    this.adapter = adapter;
    this.storeId = storeId;
    this.logger = logger;
    this.ttlHours = ttlHours;
    this.origin = origin;
  }

  /**
   * Issue (or return) the receipt token for a confirmed POS order.
   *
   * Idempotent by POS order: a retried confirmation, or a customer tapping
   * back and forth, must not mint a second link to the same order.
   */
  issue({ posOrderId, posOrderNumber, kioskId = null }) {
    if (!posOrderId || !posOrderNumber) return null;

    const existing = this.db
      .prepare('SELECT token, expires_at FROM kiosk_receipts WHERE pos_order_id = ?')
      .get(posOrderId);
    if (existing && new Date(existing.expires_at) > new Date()) return existing.token;

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlHours * 3600_000).toISOString();

    if (existing) {
      // Expired link for an order still being collected: refresh it in place so
      // the unique index holds and the old token stops working.
      this.db
        .prepare('UPDATE kiosk_receipts SET token = ?, expires_at = ?, view_count = 0 WHERE pos_order_id = ?')
        .run(token, expiresAt, posOrderId);
      return token;
    }

    this.db
      .prepare(
        `INSERT INTO kiosk_receipts (token, store_id, kiosk_id, pos_order_id, pos_order_number, expires_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(token, this.storeId, kioskId, posOrderId, posOrderNumber, expiresAt);
    return token;
  }

  /** Public URL for a token, or null when no reachable origin is known. */
  urlFor(token) {
    const origin = this.origin ?? receiptOrigin();
    if (!origin || !token) return null;
    return `${origin}/receipt/${token}`;
  }

  /**
   * Resolve a token to receipt content.
   *
   * Order data is re-read from the POS rather than frozen at issue time, so a
   * receipt opened later shows the current kitchen and payment status. An
   * unknown, malformed or expired token is one answer — "not found" — so a
   * guessed token learns nothing from the difference.
   */
  async resolve(token) {
    if (!RECEIPT_TOKEN_PATTERN.test(token ?? '')) return null;
    const row = this.db.prepare('SELECT * FROM kiosk_receipts WHERE token = ?').get(token);
    if (!row) return null;
    if (new Date(row.expires_at) <= new Date()) return null;

    const order = await this.adapter.getOrderStatus(row.pos_order_id).catch((error) => {
      this.logger?.warn?.({ err: error, posOrderId: row.pos_order_id }, 'receipt: POS lookup failed');
      return null;
    });
    if (!order) return null;

    this.db
      .prepare("UPDATE kiosk_receipts SET view_count = view_count + 1, last_viewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token = ?")
      .run(token);

    const store = this.kioskStore.getStore(row.store_id);
    return {
      posOrderNumber: row.pos_order_number,
      issuedAt: row.created_at,
      expiresAt: row.expires_at,
      storeNameEn: store?.nameEn ?? null,
      storeNameAr: store?.nameAr ?? null,
      currency: order.currency,
      fulfillment: order.fulfillment,
      tableNumber: order.tableNumber ?? null,
      status: order.status,
      kitchenStatus: order.kitchenStatus,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod ?? null,
      itemsSubtotalMinor: order.itemsSubtotalMinor,
      surchargeMinor: order.surchargeMinor ?? 0,
      discountMinor: order.discountMinor ?? 0,
      totalMinor: order.totalMinor,
      vatIncludedMinor: order.vatIncludedMinor ?? 0,
      items: (order.items ?? []).map((item) => ({
        nameEn: item.nameEn,
        nameAr: item.nameAr,
        quantity: item.quantity,
        lineTotalMinor: item.lineTotalMinor,
        modifiers: (item.modifiers ?? []).map((m) => ({ nameEn: m.nameEn, nameAr: m.nameAr })),
      })),
    };
  }

  /** Housekeeping: drop links nobody can use any more. */
  purgeExpired() {
    return this.db
      .prepare("DELETE FROM kiosk_receipts WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      .run().changes;
  }
}
