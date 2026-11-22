import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase } from './database/connection.js';
import { migrate } from './database/migrate.js';
import { seedDemoPos, legacyProductKeyMap } from './database/seed/seedDemoPos.js';
import { importV3Data } from './database/importV3.js';
import { DemoPosStore } from './demo-pos/store.js';
import { DemoPosAdapter } from './adapters/pos/DemoPosAdapter.js';
import { KioskStore } from './services/kioskStore.js';
import { MenuSyncService } from './services/menuSync.js';
import { CheckoutService } from './services/checkout.js';
import { PaymentService } from './services/payments.js';
import { SimulatorPaymentAdapter } from './adapters/payments/SimulatorPaymentAdapter.js';
import { kioskRoutes } from './routes/kiosk.js';
import { demoPosRoutes } from './routes/demoPos.js';
import { requestId, noStore, errorHandler, notFoundHandler } from './middleware/errors.js';
import { posAuth, requireRole } from './demo-pos/auth.js';
import { createLogger } from './lib/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_ID = 'store-demo';

/**
 * Composition root.
 *
 * Builds both databases, the Demo POS, the adapter, the kiosk services and one
 * Express app with two separately authenticated route namespaces:
 *
 *   /api/kiosk/*     customer kiosk — read-only over the catalog, no auth
 *   /demo-pos/api/*  the shop's till — authenticated, role-gated
 *
 * Returned as an object rather than started here, so tests can build the whole
 * platform in memory and drive it without opening a port.
 */
export function buildPlatform({
  posDbPath = resolve(here, 'data/demo-pos.sqlite'),
  kioskDbPath = resolve(here, 'data/kiosk.sqlite'),
  legacyDbPath = resolve(here, 'data/coffee-kiosk.sqlite'),
  logger = createLogger({ service: 'kiosk-platform' }),
  storeId = DEFAULT_STORE_ID,
  syncIntervalSeconds = Number(process.env.MENU_SYNC_INTERVAL_SECONDS ?? 30),
  importLegacy = true,
  seedUsers = true,
  startWorkers = true,
} = {}) {
  // ---- databases ---------------------------------------------------------
  const posDb = openDatabase(posDbPath);
  migrate(posDb, resolve(here, 'database/migrations/demo-pos'), { logger });
  seedDemoPos(posDb, { logger });

  const kioskDb = openDatabase(kioskDbPath);
  migrate(kioskDb, resolve(here, 'database/migrations/kiosk'), { logger });

  const store = new DemoPosStore(posDb, { logger });

  // ---- Version 3 import, non-destructive and idempotent ------------------
  let importSummary = null;
  if (importLegacy) {
    try {
      importSummary = importV3Data({ posDb, legacyPath: legacyDbPath, logger });
    } catch (error) {
      // A failed import must not stop the platform booting: the V3 database is
      // untouched and the import can be retried once the cause is fixed.
      logger.error('importv3.failed', { message: error.message });
    }
  }

  if (seedUsers) seedPosUsers(store, { logger });
  store.purgeExpiredSessions();

  // ---- kiosk side --------------------------------------------------------
  const kioskStore = new KioskStore(kioskDb, { logger });
  const posConfig = store.getConfig();
  kioskStore.ensureStore({
    id: storeId,
    nameEn: posConfig.storeNameEn,
    nameAr: posConfig.storeNameAr,
    currency: posConfig.currency,
    defaultLocale: 'en',
    dineInEnabled: true,
    tableNumberEnabled: false,
    surchargeKind: posConfig.surchargeKind,
    surchargeValue: posConfig.surchargeValue,
    surchargeLabelEn: posConfig.surchargeLabelEn,
    surchargeLabelAr: posConfig.surchargeLabelAr,
  });
  kioskStore.registerKiosk({ id: 'kiosk-01', storeId, label: 'Front counter kiosk' });

  // Map the old kiosk product keys ('latte') onto POS IDs ('PRD-1003'), so a
  // cart built by the existing V3 UI still resolves while Phase 2 rewires it.
  for (const { legacyKey, posProductId } of legacyProductKeyMap()) {
    kioskStore.upsertMapping(storeId, legacyKey, posProductId);
  }

  // Kiosk-only presentation: the six coffee photos belong to the kiosk
  // channel, not to the till's catalog.
  for (const { legacyKey, posProductId } of legacyProductKeyMap()) {
    kioskStore.upsertOverlay(storeId, posProductId, { imageUrl: `/images/${legacyKey}.webp` });
  }

  const adapter = new DemoPosAdapter({ store, logger });
  const menuSync = new MenuSyncService({ adapter, kioskStore, storeId, logger, intervalSeconds: syncIntervalSeconds });
  const checkout = new CheckoutService({ adapter, kioskStore, menuSync, storeId, logger });

  // The payment simulator stands in for a certified unattended terminal.
  // Real bank adapters are stubs until we have SDKs and hardware.
  const paymentAdapter = new SimulatorPaymentAdapter({ db: kioskDb, logger });
  const payments = new PaymentService({
    paymentAdapter, posAdapter: adapter, kioskStore, checkout, storeId, logger,
  });

  // ---- express -----------------------------------------------------------
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(requestId());
  app.use(noStore());
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'kiosk-platform', storeId }));

  app.use('/api/kiosk', kioskRoutes({ menuSync, checkout, payments, kioskStore, storeId, logger }));
  app.use('/demo-pos/api', demoPosRoutes({ store, adapter, paymentAdapter, logger }));

  // Demo POS staff console. Served from its own path, as a plain static page
  // separate from the kiosk's React bundle: the till is a different
  // application and must never be reachable from the customer screen.
  app.use('/demo-pos', express.static(resolve(here, 'demo-pos/public'), { index: 'index.html' }));

  // Operator view of anything needing human attention.
  //
  // Behind manager authentication: this lists payment references and failure
  // detail for orders where a customer's money moved, which is exactly the
  // data an attacker would want and a customer should never see on a kiosk.
  app.get('/api/ops/exceptions', posAuth(store), requireRole('manager'), (_req, res) => {
    res.json({
      // Payments that stopped answering, or were approved with no order.
      paymentsNeedingAttention: payments.listNeedingAttention().map((p) => ({
        paymentId: p.paymentId,
        state: p.state,
        amountMinor: p.amountMinor,
        currency: p.currency,
        reference: p.reference,
        orderSubmitted: p.orderSubmitted,
        createdAt: p.createdAt,
      })),
      opsExceptions: kioskStore.listOpsExceptions().map((s) => ({
        submissionId: s.id,
        clientRequestId: s.clientRequestId,
        status: s.status,
        attempts: s.attempts,
        lastError: s.lastError,
        paymentReference: s.paymentReference,
        createdAt: s.createdAt,
      })),
      integrationIssues: kioskStore.listIntegrationIssues({ limit: 50 }),
    });
  });

  app.use(notFoundHandler());
  app.use(errorHandler({ logger }));

  if (startWorkers) {
    menuSync.start();
    checkout.startQueueWorker({ intervalSeconds: 10 });
  }

  return {
    app,
    posDb,
    kioskDb,
    store,
    kioskStore,
    adapter,
    paymentAdapter,
    menuSync,
    checkout,
    payments,
    storeId,
    logger,
    importSummary,
    close() {
      menuSync.stop();
      checkout.stopQueueWorker();
      closeDatabase(posDb);
      closeDatabase(kioskDb);
    },
  };
}

/**
 * Create the Demo POS staff accounts.
 *
 * Passwords come from the environment. In production a missing password is a
 * hard failure, never a default — a till that ships with a known password is
 * how a demo becomes an incident. In development a known password is used and
 * warned about loudly on every boot.
 */
export function seedPosUsers(store, { logger } = {}) {
  const production = process.env.NODE_ENV === 'production';
  const accounts = [
    { username: 'manager', role: 'manager', env: 'POS_MANAGER_PASSWORD', devDefault: 'demo-manager-1234' },
    { username: 'barista', role: 'barista', env: 'POS_BARISTA_PASSWORD', devDefault: 'demo-barista-1234' },
  ];

  const created = [];
  for (const account of accounts) {
    const existing = store.db.prepare('SELECT id FROM pos_users WHERE username = ?').get(account.username);
    if (existing) continue;

    const password = process.env[account.env];
    if (!password) {
      if (production) {
        throw new Error(
          `${account.env} must be set before starting in production. ` +
            'Demo passwords are never enabled outside development.',
        );
      }
      store.createUser({ username: account.username, role: account.role, password: account.devDefault }, { type: 'system' });
      created.push({ ...account, usedDevDefault: true });
      continue;
    }
    if (password.length < 10) {
      throw new Error(`${account.env} must be at least 10 characters.`);
    }
    store.createUser({ username: account.username, role: account.role, password }, { type: 'system' });
    created.push({ ...account, usedDevDefault: false });
  }

  const devDefaults = created.filter((c) => c.usedDevDefault);
  if (devDefaults.length > 0) {
    // Loud, every boot, listing exactly what is insecure and how to fix it.
    logger?.warn?.('demopos.dev_credentials_created', {
      message: 'DEVELOPMENT ONLY: Demo POS accounts were created with known default passwords.',
      accounts: devDefaults.map((c) => `${c.username} / ${c.devDefault}`),
      action: 'Set POS_MANAGER_PASSWORD and POS_BARISTA_PASSWORD before any real deployment.',
    });
    if (process.stderr.isTTY) {
      process.stderr.write(
        '\n  ====================================================================\n' +
        '   DEVELOPMENT CREDENTIALS IN USE — do not expose this to a network\n' +
        devDefaults.map((c) => `     ${c.username} / ${c.devDefault}\n`).join('') +
        '   Set POS_MANAGER_PASSWORD and POS_BARISTA_PASSWORD to change these.\n' +
        '  ====================================================================\n\n',
      );
    }
  }
  return created;
}
