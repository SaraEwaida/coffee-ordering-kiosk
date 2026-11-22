import { Router } from 'express';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * Standard internal kiosk API.
 *
 * The React kiosk talks ONLY to these routes. It never reaches the POS, never
 * opens SQLite, and never learns a Demo POS table name or database path.
 *
 * No route here mutates the catalog: price and availability belong to the POS,
 * so the kiosk channel is read-only over them by construction.
 */
export function kioskRoutes({ menuSync, checkout, payments, kioskStore, storeId, logger }) {
  const router = Router();

  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  // ------------------------------------------------------------- store config
  router.get('/config', (req, res) => {
    const store = kioskStore.getStore(storeId);
    if (!store) throw notFound('Store configuration not found.');
    res.json({
      storeId: store.id,
      nameEn: store.nameEn,
      nameAr: store.nameAr,
      currency: store.currency,
      defaultLocale: store.defaultLocale,
      dineInEnabled: store.dineInEnabled,
      tableNumberEnabled: store.tableNumberEnabled,
      // Shown in the cart as a distinct line. The figure is still verified by
      // the POS at quote time; this is for display only.
      surcharge: {
        kind: store.surchargeKind,
        value: store.surchargeValue,
        labelEn: store.surchargeLabelEn,
        labelAr: store.surchargeLabelAr,
      },
      inactivityTimeoutSeconds: store.inactivityTimeoutSeconds,
      menuSyncIntervalSeconds: store.menuSyncIntervalSeconds,
    });
  });

  // -------------------------------------------------------------------- menu
  router.get('/menu', (_req, res) => {
    const menu = menuSync.getKioskMenu();
    // 503 when there has never been a successful sync: the UI must show a
    // "cannot reach the till" screen rather than an empty menu that looks like
    // a shop with nothing to sell.
    res.status(menu.available ? 200 : 503).json(menu);
  });

  /** Force a sync. Useful in a demo to show a price change landing at once. */
  router.post('/menu/sync', asyncRoute(async (_req, res) => {
    const result = await menuSync.syncNow();
    res.status(result.ok ? 200 : 503).json(result);
  }));

  // ------------------------------------------------------------------ quotes
  router.post('/quotes', asyncRoute(async (req, res) => {
    const { kioskId, cart } = req.body ?? {};
    if (!cart) throw badRequest('A cart is required.');
    const result = await checkout.createQuote({ kioskId, cart });
    res.status(201).json(result);
  }));

  router.get('/quotes/:id', (req, res) => {
    const stored = kioskStore.getQuote(req.params.id);
    if (!stored || stored.storeId !== storeId) throw notFound('That order summary was not found.');
    res.json({
      quoteId: stored.id,
      status: stored.expired && stored.status === 'open' ? 'expired' : stored.status,
      expiresAt: stored.expiresAt,
      quote: stored.quote,
    });
  });

  // ------------------------------------------------------------------ orders
  router.post('/orders', asyncRoute(async (req, res) => {
    const { clientRequestId, quoteId, kioskId, notes, payment } = req.body ?? {};
    const result = await checkout.submitOrder({ clientRequestId, quoteId, kioskId, notes, payment });
    // 202 when the order is saved but the POS has not confirmed it yet: the UI
    // must not tell the customer "done" while the till has not acknowledged.
    res.status(result.status === 'confirmed' ? 201 : 202).json(result);
  }));

  router.get('/orders/by-request/:clientRequestId', asyncRoute(async (req, res) => {
    const status = await checkout.getSubmissionStatus(req.params.clientRequestId);
    if (!status) throw notFound('No order found for that reference.');
    res.json(status);
  }));

  router.get('/orders/:posOrderId/status', asyncRoute(async (req, res) => {
    const order = await checkout.adapter.getOrderStatus(req.params.posOrderId).catch(() => null);
    if (!order) throw notFound('Order not found.');
    res.json({
      posOrderNumber: order.posOrderNumber,
      status: order.status,
      kitchenStatus: order.kitchenStatus,
      paymentStatus: order.paymentStatus,
      totalMinor: order.totalMinor,
      currency: order.currency,
    });
  }));

  // --------------------------------------------------- promotions and cards
  router.get('/promotions/:code', asyncRoute(async (req, res) => {
    const result = await checkout.adapter.validateCouponOrLoyalty({ code: req.params.code, kind: 'promotion' });
    res.status(result.valid ? 200 : 404).json(result);
  }));

  router.get('/gift-cards/:code', asyncRoute(async (req, res) => {
    const result = await checkout.adapter.validateCouponOrLoyalty({ code: req.params.code, kind: 'gift_card' });
    res.status(result.valid ? 200 : 404).json(result);
  }));

  // ---------------------------------------------------------------- payments
  /**
   * Start paying for a quote.
   *
   * The amount is NOT in this request and cannot be: the server reads it from
   * the stored quote. A browser has no way to say what an order costs.
   */
  router.post('/payments', asyncRoute(async (req, res) => {
    const { quoteId, clientRequestId, kioskId, method, giftCardCode } = req.body ?? {};
    if (!quoteId) throw badRequest('A quote is required.');
    const session = await payments.startPayment({ quoteId, clientRequestId, kioskId, method, giftCardCode });
    res.status(201).json(session);
  }));

  /** Poll the terminal. Also the moment an approval becomes a POS order. */
  router.get('/payments/:id', asyncRoute(async (req, res) => {
    const session = await payments.getStatus(req.params.id);
    res.json(session);
  }));

  router.post('/payments/:id/cancel', asyncRoute(async (req, res) => {
    const session = await payments.cancel(req.params.id, { actor: 'customer' });
    res.json(session);
  }));

  /** Cash at the counter: an unpaid order the staff will settle. */
  router.post('/payments/cash', asyncRoute(async (req, res) => {
    const { quoteId, clientRequestId, kioskId } = req.body ?? {};
    if (!quoteId) throw badRequest('A quote is required.');
    const result = await payments.payAtCounter({ quoteId, clientRequestId, kioskId });
    res.status(result.status === 'confirmed' ? 201 : 202).json(result);
  }));

  // ------------------------------------------------------------------ health
  router.get('/health', asyncRoute(async (_req, res) => {
    const snapshot = await menuSync.healthSnapshot();
    const queue = kioskStore.countSubmissions();
    const issues = kioskStore.listIntegrationIssues({ limit: 10 });
    const healthy = snapshot.pos.healthy && (queue.opsExceptions ?? 0) === 0;
    res.status(healthy ? 200 : 503).json({
      ok: healthy,
      storeId,
      pos: snapshot.pos,
      menu: snapshot.menu,
      sync: snapshot.sync,
      queue,
      integrationIssues: issues.length,
      topIssues: issues.slice(0, 5).map((i) => ({ kind: i.kind, detail: i.detail, occurrences: i.occurrences })),
    });
  }));

  router.post('/kiosks/:kioskId/heartbeat', (req, res) => {
    kioskStore.heartbeat(req.params.kioskId, { appVersion: req.body?.appVersion });
    res.json({ ok: true, at: new Date().toISOString() });
  });

  return router;
}
