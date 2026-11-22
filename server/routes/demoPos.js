import { Router } from 'express';
import { badRequest, notFound, unauthorized, validationFailed } from '../lib/errors.js';
import { posAuth, requireRole } from '../demo-pos/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { PosRejectedError } from '../adapters/pos/PosAdapter.js';
import { AppError } from '../lib/errors.js';
import { parseMajorToMinor } from '../../shared/money.js';

/**
 * Demo POS API — the shop's own till, not part of the kiosk.
 *
 * Mounted on a separate path prefix and behind its own authentication. Nothing
 * here is reachable from the customer kiosk UI: a walk-in customer must not be
 * able to change a price, see the kitchen queue, or read an audit log.
 *
 * Roles:
 *   manager  — catalog, prices, availability, config, audit
 *   barista  — kitchen queue and order status only
 *   readonly — read endpoints only
 */
export function demoPosRoutes({ store, adapter, logger }) {
  const router = Router();
  const auth = posAuth(store);
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  const actorOf = (req) => ({ type: req.posUser.role, id: req.posUser.id });

  /** Turn a POS refusal into the shared API error model. */
  const guard = (fn) => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof PosRejectedError) {
        throw new AppError(error.code ?? 'pos_rejected', error.message, { status: 400, details: error.details });
      }
      throw error;
    }
  };

  // ------------------------------------------------------------------- login
  router.post(
    '/auth/login',
    // Deliberately strict: these are till credentials on a machine in a shop.
    rateLimit({ windowSeconds: 600, max: 8, message: 'Too many sign-in attempts. Please wait and try again.' }),
    (req, res) => {
      const { username, password } = req.body ?? {};
      const user = store.authenticate(username, password);
      if (!user) {
        // One message for both wrong-username and wrong-password, so valid
        // usernames cannot be enumerated.
        logger?.warn?.('demopos.login_failed', { username: String(username ?? '').slice(0, 40) });
        throw unauthorized('Incorrect username or password.');
      }
      const session = store.createSession(user.id);
      store.audit({ type: user.role, id: user.id }, 'auth.login', 'user', user.id, {});
      res.json({ accessToken: session.token, expiresAt: session.expiresAt, user });
    },
  );

  router.post('/auth/logout', auth, (req, res) => {
    store.destroySession(req.posToken);
    store.audit(actorOf(req), 'auth.logout', 'user', req.posUser.id, {});
    res.json({ ok: true });
  });

  router.get('/auth/me', auth, (req, res) => res.json({ user: req.posUser }));

  // ----------------------------------------------------------------- catalog
  router.get('/menu', auth, (_req, res) => res.json(store.getMenu()));

  router.get('/products', auth, (_req, res) => {
    const menu = store.getMenu();
    res.json({
      currency: menu.currency,
      menuVersion: menu.menuVersion,
      products: menu.products.map((p) => ({
        posProductId: p.posProductId,
        sku: p.sku,
        categoryId: p.categoryId,
        nameEn: p.nameEn,
        nameAr: p.nameAr,
        priceMinor: p.priceMinor,
        taxRateBp: p.taxRateBp,
        available: p.available,
        modifierGroupIds: p.modifierGroups.map((g) => g.groupId),
      })),
    });
  });

  /**
   * Change a price, stock flag, or menu detail.
   *
   * Accepts `priceMinor` (integer minor units) or `price` (a decimal string,
   * for the manager UI). The string is parsed exactly — never through
   * parseFloat — so "15.05" cannot land as 1504 agorot.
   */
  router.patch('/products/:id', auth, requireRole('manager'), (req, res) => {
    const body = req.body ?? {};
    const changes = {};

    if (body.priceMinor !== undefined) {
      if (!Number.isInteger(body.priceMinor)) {
        throw validationFailed('priceMinor must be a whole number of minor units.', { field: 'priceMinor' });
      }
      changes.priceMinor = body.priceMinor;
    } else if (body.price !== undefined) {
      const currency = store.getConfig().currency;
      try {
        changes.priceMinor = parseMajorToMinor(body.price, currency);
      } catch (error) {
        throw validationFailed(error.message, { field: 'price' });
      }
    }
    if (body.available !== undefined) changes.available = body.available;
    for (const field of ['nameEn', 'nameAr', 'descriptionEn', 'descriptionAr']) {
      if (body[field] !== undefined) changes[field] = body[field];
    }
    if (body.taxRateBp !== undefined) changes.taxRateBp = body.taxRateBp;

    if (Object.keys(changes).length === 0) throw badRequest('Nothing to update.');

    const updated = guard(() => store.updateProduct(req.params.id, changes, actorOf(req)));
    res.json({
      posProductId: updated.id,
      nameEn: updated.name_en,
      nameAr: updated.name_ar,
      priceMinor: updated.price_minor,
      taxRateBp: updated.tax_rate_bp,
      available: Boolean(updated.available),
    });
  });

  router.patch('/modifiers/:id', auth, requireRole('manager'), (req, res) => {
    const body = req.body ?? {};
    const changes = {};
    if (body.priceDeltaMinor !== undefined) changes.priceDeltaMinor = body.priceDeltaMinor;
    if (body.available !== undefined) changes.available = body.available;
    if (Object.keys(changes).length === 0) throw badRequest('Nothing to update.');
    const updated = guard(() => store.updateModifier(req.params.id, changes, actorOf(req)));
    res.json({
      modifierId: updated.id,
      groupId: updated.group_id,
      nameEn: updated.name_en,
      priceDeltaMinor: updated.price_delta_minor,
      available: Boolean(updated.available),
    });
  });

  // ------------------------------------------------------------------ config
  router.get('/config', auth, (_req, res) => res.json(store.getConfig()));

  router.patch('/config', auth, requireRole('manager'), (req, res) => {
    const allowed = new Set([
      'store_name_en', 'store_name_ar', 'default_tax_rate_bp',
      'dine_in_surcharge_kind', 'dine_in_surcharge_value',
      'dine_in_surcharge_label_en', 'dine_in_surcharge_label_ar',
    ]);
    const entries = Object.entries(req.body ?? {}).filter(([key]) => allowed.has(key));
    if (entries.length === 0) {
      throw badRequest(`Nothing to update. Allowed keys: ${[...allowed].join(', ')}.`);
    }
    // Currency is intentionally not changeable here: changing it would make
    // every stored price mean something different without converting any of
    // them. That needs a migration, not a settings toggle.
    for (const [key, value] of entries) store.setConfig(key, value, actorOf(req));
    res.json(store.getConfig());
  });

  // ------------------------------------------------------------------ orders
  router.get('/orders', auth, (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ orders: store.listOrders({ limit, kitchenStatus: req.query.kitchenStatus ?? null }) });
  });

  /** The barista's screen: what still has to be made. */
  router.get('/kitchen/queue', auth, (_req, res) => {
    res.json({ orders: store.listKitchenQueue(), at: new Date().toISOString() });
  });

  router.get('/orders/:id', auth, (req, res) => {
    const order = store.getOrder(req.params.id);
    if (!order) throw notFound('Order not found.');
    res.json(order);
  });

  router.patch('/orders/:id/kitchen-status', auth, requireRole('manager', 'barista'), (req, res) => {
    const { kitchenStatus } = req.body ?? {};
    if (!kitchenStatus) throw badRequest('kitchenStatus is required.');
    const order = guard(() => store.updateKitchenStatus(req.params.id, kitchenStatus, actorOf(req)));
    res.json(order);
  });

  /**
   * Record a payment taken at the counter.
   *
   * Carried over from Version 3 and kept deliberately: a payment is only ever
   * recorded by an authenticated member of staff who has actually seen the
   * money. Nothing in the customer-facing kiosk can mark an order paid.
   */
  router.post('/orders/:id/payments', auth, requireRole('manager', 'barista'), (req, res) => {
    const { method, status, amountMinor, reference } = req.body ?? {};
    if (!['cash_counter', 'card_simulated', 'gift_card'].includes(method)) {
      throw validationFailed('method must be cash_counter, card_simulated or gift_card.', { field: 'method' });
    }
    if (!['pending', 'approved', 'declined', 'cancelled', 'timed_out', 'failed', 'voided'].includes(status)) {
      throw validationFailed('Invalid payment status.', { field: 'status' });
    }
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      throw validationFailed('amountMinor must be a non-negative whole number.', { field: 'amountMinor' });
    }
    const order = guard(() => store.attachPayment(
      req.params.id,
      { method, status, amountMinor, reference: reference ?? null, recordedBy: req.posUser.id },
      actorOf(req),
    ));
    res.json(order);
  });

  // -------------------------------------------------------------- gift cards
  router.get(
    '/gift-cards/:code',
    auth,
    // A gift-card code is a bearer credential, so brute force must be costly
    // even for a signed-in staff account.
    rateLimit({ windowSeconds: 600, max: 60, message: 'Too many gift card lookups.' }),
    (req, res) => {
      const card = store.findGiftCard(req.params.code);
      if (!card) throw notFound('Gift card not found.');
      res.json({ code: `••••${card.code.slice(-4)}`, balanceMinor: card.balanceMinor, currency: card.currency });
    },
  );

  // ------------------------------------------------------------------- audit
  router.get('/audit', auth, requireRole('manager'), (req, res) => {
    res.json({ events: store.listAuditEvents(Number(req.query.limit ?? 100)) });
  });

  // --------------------------------------------------- demo fault injection
  /**
   * Dev/demo only: make the POS look unreachable so recovery behaviour can be
   * shown live. Manager-authenticated, never exposed to the kiosk UI, and
   * refused outright when NODE_ENV is production.
   */
  router.post('/demo/faults', auth, requireRole('manager'), (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError('forbidden', 'Fault injection is disabled in production.', { status: 403 });
    }
    const { offline, latencyMs, failOnSubmit } = req.body ?? {};
    const faults = {};
    if (offline !== undefined) faults.offline = Boolean(offline);
    if (failOnSubmit !== undefined) faults.failOnSubmit = Boolean(failOnSubmit);
    if (latencyMs !== undefined) {
      if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 10000) {
        throw validationFailed('latencyMs must be between 0 and 10000.', { field: 'latencyMs' });
      }
      faults.latencyMs = latencyMs;
    }
    const applied = adapter.setFaults(faults);
    store.audit(actorOf(req), 'demo.faults_changed', 'adapter', 'demo-pos', applied);
    res.json({ faults: applied, warning: 'Development fault injection. Not available in production.' });
  });

  router.get('/health', (_req, res) => {
    const health = store.health();
    res.status(health.healthy ? 200 : 503).json(health);
  });

  return router;
}
