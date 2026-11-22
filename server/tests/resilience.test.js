import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestPlatform, startHttp, LATTE_LINE } from './helpers.js';
import { buildPlatform } from '../app.js';
import { silentLogger } from '../lib/logger.js';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';

let platform;
let http;
beforeEach(async () => {
  platform = makeTestPlatform();
  await platform.menuSync.syncNow();
  http = await startHttp(platform);
});
afterEach(async () => {
  await http.close();
  platform.close();
});

async function quoteId(cart = { fulfillment: 'takeaway', lines: [LATTE_LINE] }) {
  const response = await http.post('/api/kiosk/quotes', { kioskId: 'kiosk-01', cart });
  assert.equal(response.status, 201, `quote failed: ${JSON.stringify(response.body)}`);
  return response.body.quoteId;
}

describe('resilience: POS unreachable', () => {
  test('the menu is served from cache and flagged stale', async () => {
    platform.adapter.setFaults({ offline: true });
    const sync = await platform.menuSync.syncNow();
    assert.equal(sync.ok, false);

    const menu = await http.get('/api/kiosk/menu');
    assert.equal(menu.status, 200, 'a cached menu must still be served');
    assert.equal(menu.body.available, true);
    assert.equal(menu.body.sync.healthy, false);
    assert.ok(menu.body.sync.consecutiveFailures >= 1);
  });

  test('with no cache at all, the menu endpoint reports unavailable rather than empty', async () => {
    const fresh = makeTestPlatform();
    try {
      fresh.adapter.setFaults({ offline: true });
      await fresh.menuSync.syncNow();
      const menu = fresh.menuSync.getKioskMenu();
      assert.equal(menu.available, false);
      assert.equal(menu.reason, 'no_menu_yet');
      assert.equal(menu.products.length, 0);
    } finally {
      fresh.close();
    }
  });

  test('an unpaid order is queued, not lost, and reports 202', async () => {
    const id = await quoteId();
    platform.adapter.setFaults({ failOnSubmit: true });

    const response = await http.post('/api/kiosk/orders', {
      clientRequestId: 'resil-unpaid-001', quoteId: id, kioskId: 'kiosk-01',
    });
    assert.equal(response.status, 202, 'must not claim success while the till has not confirmed');
    assert.equal(response.body.status, 'pending');
    assert.equal(response.body.paymentAccepted, false);

    const submission = platform.kioskStore.findSubmission('resil-unpaid-001');
    assert.ok(submission, 'a durable row must exist');
    assert.equal(submission.status, 'pending');
  });

  test('the queue drains once the POS returns, creating exactly one order', async () => {
    const id = await quoteId();
    platform.adapter.setFaults({ failOnSubmit: true });
    await http.post('/api/kiosk/orders', { clientRequestId: 'resil-drain-001', quoteId: id });

    platform.adapter.setFaults({ failOnSubmit: false });
    // Backoff is in the future, so drive the retry directly rather than sleeping.
    platform.kioskStore.db
      .prepare('UPDATE kiosk_order_submissions SET next_attempt_at = NULL WHERE client_request_id = ?')
      .run('resil-drain-001');
    const result = await platform.checkout.drainQueue();

    assert.equal(result.confirmed, 1);
    const status = await platform.checkout.getSubmissionStatus('resil-drain-001');
    assert.equal(status.status, 'confirmed');
    assert.ok(status.posOrderNumber);
    assert.equal(platform.store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 1);
  });

  test('retries use exponential backoff and never spin', async () => {
    const id = await quoteId();
    platform.adapter.setFaults({ failOnSubmit: true });
    await http.post('/api/kiosk/orders', { clientRequestId: 'resil-backoff-01', quoteId: id });

    const delays = [];
    for (let i = 0; i < 4; i += 1) {
      platform.kioskStore.db
        .prepare('UPDATE kiosk_order_submissions SET next_attempt_at = NULL WHERE client_request_id = ?')
        .run('resil-backoff-01');
      await platform.checkout.drainQueue();
      const submission = platform.kioskStore.findSubmission('resil-backoff-01');
      delays.push(new Date(submission.nextAttemptAt).getTime() - Date.now());
    }
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok(delays[i] >= delays[i - 1] - 1500, `backoff must not shrink: ${delays.join(',')}`);
    }
    assert.ok(delays.at(-1) <= 65_000, 'backoff must stay capped');
  });
});

describe('resilience: approved payment with no POS order', () => {
  test('becomes an ops exception and is never abandoned', async () => {
    const id = await quoteId();
    platform.adapter.setFaults({ failOnSubmit: true });

    const response = await http.post('/api/kiosk/orders', {
      clientRequestId: 'resil-paid-001',
      quoteId: id,
      payment: { method: 'card_simulated', status: 'approved', amountMinor: 1900, reference: 'SIM-PAID-001' },
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.paymentAccepted, true);
    assert.match(response.body.message, /payment went through/i,
      'the customer must be told their money moved');

    const exceptions = await http.get('/api/ops/exceptions', { token: await http.managerToken() });
    assert.equal(exceptions.body.opsExceptions.length, 1);
    assert.equal(exceptions.body.opsExceptions[0].paymentReference, 'SIM-PAID-001');
    assert.ok(exceptions.body.integrationIssues.some((i) => i.kind === 'paid_order_unconfirmed'));
  });

  test('a paid submission is never marked failed, however many attempts fail', async () => {
    const id = await quoteId();
    platform.adapter.setFaults({ failOnSubmit: true });
    await http.post('/api/kiosk/orders', {
      clientRequestId: 'resil-persist-01', quoteId: id,
      payment: { method: 'card_simulated', status: 'approved', amountMinor: 1900, reference: 'SIM-P-01' },
    });

    for (let i = 0; i < 12; i += 1) {
      platform.kioskStore.db
        .prepare('UPDATE kiosk_order_submissions SET next_attempt_at = NULL WHERE client_request_id = ?')
        .run('resil-persist-01');
      await platform.checkout.drainQueue();
    }
    const submission = platform.kioskStore.findSubmission('resil-persist-01');
    assert.equal(submission.status, 'pending', 'money has moved: this must stay retryable');
    assert.ok(submission.attempts >= 12);
  });

  test('an unpaid submission does eventually give up', async () => {
    const id = await quoteId();
    platform.adapter.setFaults({ failOnSubmit: true });
    await http.post('/api/kiosk/orders', { clientRequestId: 'resil-giveup-01', quoteId: id });

    for (let i = 0; i < 12; i += 1) {
      platform.kioskStore.db
        .prepare('UPDATE kiosk_order_submissions SET next_attempt_at = NULL WHERE client_request_id = ?')
        .run('resil-giveup-01');
      await platform.checkout.drainQueue();
    }
    const submission = platform.kioskStore.findSubmission('resil-giveup-01');
    assert.equal(submission.status, 'failed');
  });

  test('a paid order the POS refuses outright is escalated, not silently dropped', async () => {
    const id = await quoteId();
    // Make the POS reject by changing the price out from under the submission.
    const token = await http.managerToken();
    await http.patch('/demo-pos/api/products/PRD-1003', { price: '50.00' }, { token });

    const response = await http.post('/api/kiosk/orders', {
      clientRequestId: 'resil-reject-01', quoteId: id,
      payment: { method: 'card_simulated', status: 'approved', amountMinor: 1900, reference: 'SIM-REJ-01' },
    });
    assert.ok(response.status >= 400);
    const exceptions = await http.get('/api/ops/exceptions', { token: await http.managerToken() });
    assert.ok(
      exceptions.body.integrationIssues.some((i) => i.kind === 'paid_order_rejected')
        || exceptions.body.opsExceptions.length === 1,
      'a paid order that cannot be created must reach a human',
    );
  });
});

describe('resilience: restart durability', () => {
  test('a pending submission survives a full platform restart and then confirms', async () => {
    const dir = platform.tempDir;
    const id = await quoteId();
    platform.adapter.setFaults({ failOnSubmit: true });
    await http.post('/api/kiosk/orders', {
      clientRequestId: 'resil-restart-01', quoteId: id,
      payment: { method: 'card_simulated', status: 'approved', amountMinor: 1900, reference: 'SIM-RS-01' },
    });

    // Drop everything, as a power cut would.
    await http.close();
    platform.close = () => {};
    platform.menuSync.stop();
    platform.checkout.stopQueueWorker();
    platform.posDb.close();
    platform.kioskDb.close();

    const revived = buildPlatform({
      posDbPath: resolve(dir, 'demo-pos.sqlite'),
      kioskDbPath: resolve(dir, 'kiosk.sqlite'),
      legacyDbPath: resolve(dir, 'none.sqlite'),
      logger: silentLogger,
      importLegacy: false,
      startWorkers: false,
    });
    try {
      const recovered = revived.kioskStore.findSubmission('resil-restart-01');
      assert.ok(recovered, 'the submission must have survived');
      assert.equal(recovered.paymentAccepted, true);
      assert.equal(recovered.status, 'pending');

      revived.kioskStore.db
        .prepare('UPDATE kiosk_order_submissions SET next_attempt_at = NULL WHERE client_request_id = ?')
        .run('resil-restart-01');
      const result = await revived.checkout.drainQueue();
      assert.equal(result.confirmed, 1);

      const orders = revived.store.db
        .prepare("SELECT COUNT(*) AS n FROM pos_orders WHERE client_request_id = 'resil-restart-01'")
        .get();
      assert.equal(orders.n, 1, 'exactly one order, no double charge');
    } finally {
      revived.close();
      http = { close: async () => {} };
      // revived.close() closes the databases but does not own the temp
      // directory, so remove it here rather than leaving it behind.
      platform = {
        close: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
        tempDir: dir,
      };
    }
  });

  test('a staff session survives a restart', async () => {
    const dir = platform.tempDir;
    const token = await http.managerToken();
    assert.equal((await http.get('/demo-pos/api/auth/me', { token })).status, 200);

    await http.close();
    platform.menuSync.stop();
    platform.checkout.stopQueueWorker();
    platform.posDb.close();
    platform.kioskDb.close();
    platform.close = () => {};

    const revived = buildPlatform({
      posDbPath: resolve(dir, 'demo-pos.sqlite'),
      kioskDbPath: resolve(dir, 'kiosk.sqlite'),
      legacyDbPath: resolve(dir, 'none.sqlite'),
      logger: silentLogger, importLegacy: false, startWorkers: false,
    });
    try {
      // V3 kept sessions in an in-memory Map, so this was impossible there.
      assert.ok(revived.store.resolveSession(token), 'the session must still resolve after a restart');
    } finally {
      revived.close();
      http = { close: async () => {} };
      // revived.close() closes the databases but does not own the temp
      // directory, so remove it here rather than leaving it behind.
      platform = {
        close: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
        tempDir: dir,
      };
    }
  });
});

describe('resilience: adapter metrics', () => {
  test('failures are counted but refusals are not', async () => {
    platform.adapter.setFaults({ offline: true });
    await platform.menuSync.syncNow();
    const afterOffline = platform.adapter.getMetrics();
    assert.ok(afterOffline.failures >= 1);
    assert.ok(afterOffline.errorRate > 0);

    platform.adapter.setFaults({ offline: false });
    const failuresBefore = platform.adapter.getMetrics().failures;
    // A sold-out refusal: the POS answered, so it is not an integration failure.
    const token = await http.managerToken();
    await http.patch('/demo-pos/api/products/PRD-1003', { available: false }, { token });
    await http.post('/api/kiosk/quotes', { kioskId: 'kiosk-01', cart: { fulfillment: 'takeaway', lines: [LATTE_LINE] } });
    assert.equal(platform.adapter.getMetrics().failures, failuresBefore,
      'a shop selling out is not a broken connection');
  });
});

describe('resilience: a paying customer is told the truth', () => {
  test('a stranded payment yields a staff-referral message, not "review your order"', async () => {
    const id = await quoteId();
    const token = await http.managerToken();
    // Price moves after the quote but after the card was approved.
    await http.patch('/demo-pos/api/products/PRD-1003', { price: '50.00' }, { token });
    await http.post('/api/kiosk/menu/sync');

    const response = await http.post('/api/kiosk/orders', {
      clientRequestId: 'stranded-msg-001', quoteId: id,
      payment: { method: 'card_simulated', status: 'approved', amountMinor: 1900, reference: 'SIM-STRAND-1' },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'payment_taken_order_failed');
    assert.match(response.body.error.message, /payment went through/i);
    assert.match(response.body.error.message, /staff/i);
    assert.doesNotMatch(response.body.error.message, /review your order/i,
      'never ask someone to re-pick items after taking their money');
    assert.equal(response.body.error.details.reference, 'SIM-STRAND-1');

    // And it must be on the ops list with a durable record.
    const exceptions = await http.get('/api/ops/exceptions', { token: await http.managerToken() });
    assert.equal(exceptions.body.opsExceptions.length, 1);
    assert.equal(exceptions.body.opsExceptions[0].paymentReference, 'SIM-STRAND-1');
    assert.ok(exceptions.body.integrationIssues.some((i) => i.kind === 'paid_order_not_created'));
  });

  test('an unpaid customer IS asked to review, which is correct for them', async () => {
    const id = await quoteId();
    const token = await http.managerToken();
    await http.patch('/demo-pos/api/products/PRD-1003', { price: '50.00' }, { token });
    await http.post('/api/kiosk/menu/sync');

    const response = await http.post('/api/kiosk/orders', { clientRequestId: 'unpaid-msg-001', quoteId: id });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'menu_changed');
    assert.match(response.body.error.message, /review your order/i);
  });
});
