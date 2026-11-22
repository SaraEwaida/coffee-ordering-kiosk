import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { makeTestPlatform, startHttp, LATTE_LINE } from './helpers.js';
import { buildPlatform } from '../app.js';
import { silentLogger } from '../lib/logger.js';
import { PAYMENT_STATES, isTerminal } from '../adapters/payments/PaymentAdapter.js';
import { ArabBankTerminalAdapter, BankOfPalestineTerminalAdapter } from '../adapters/payments/BankTerminalStubs.js';

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

async function freshQuote(cart = { fulfillment: 'takeaway', lines: [LATTE_LINE] }) {
  const response = await http.post('/api/kiosk/quotes', { kioskId: 'kiosk-01', cart });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

/**
 * Drive the simulator to a terminal state without sleeping.
 *
 * Ages both `advance_at` and `created_at`: the card-timeout path resolves
 * relative to when the payment started, so moving only the next due time
 * would never let a timeout land.
 */
async function settle(paymentId, maxPolls = 25) {
  for (let i = 0; i < maxPolls; i += 1) {
    const session = await platform.payments.getStatus(paymentId);
    if (session.terminal || session.needsStaff) return session;
    platform.kioskDb.prepare(`
      UPDATE kiosk_payment_sessions
      SET advance_at = '2000-01-01T00:00:00.000Z', created_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(paymentId);
  }
  throw new Error('payment did not settle');
}

describe('payments: the amount comes from the server', () => {
  test('a payment request carries no amount at all', async () => {
    const quote = await freshQuote();
    const response = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'amount-from-server-1', kioskId: 'kiosk-01',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.amountMinor, quote.quote.totalMinor);
  });

  test('an amount sent by the client is ignored, not trusted', async () => {
    const quote = await freshQuote();
    const response = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'amount-ignored-1', kioskId: 'kiosk-01',
      amountMinor: 1, totalMinor: 1, total: 1,
    });
    assert.equal(response.body.amountMinor, quote.quote.totalMinor,
      'a browser must not be able to set what it pays');
  });

  test('paying against an expired quote is refused', async () => {
    const quote = await freshQuote();
    platform.kioskDb
      .prepare("UPDATE kiosk_quotes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(quote.quoteId);
    const response = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'expired-quote-1',
    });
    assert.equal(response.status, 409);
  });
});

describe('payments: outcomes', () => {
  test('approved creates exactly one order with the payment attached', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'outcome-approve-1', kioskId: 'kiosk-01',
    });
    const session = await settle(started.body.paymentId);

    assert.equal(session.state, 'approved');
    assert.ok(session.reference?.startsWith('SIM-'), 'reference must be marked simulated');
    assert.ok(session.order, 'an approval must produce an order');
    assert.equal(session.order.status, 'confirmed');

    const orders = platform.store.db
      .prepare("SELECT * FROM pos_orders WHERE client_request_id = 'outcome-approve-1'")
      .all();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].payment_status, 'paid');
    assert.equal(orders[0].total_minor, quote.quote.totalMinor);
  });

  for (const outcome of ['declined', 'failed', 'timed_out']) {
    test(`${outcome} creates NO order`, async () => {
      platform.paymentAdapter.setDefaultOutcome(outcome === 'timed_out' ? 'timed_out' : outcome);
      const quote = await freshQuote();
      const started = await http.post('/api/kiosk/payments', {
        quoteId: quote.quoteId, clientRequestId: `outcome-${outcome}-1`, kioskId: 'kiosk-01',
      });
      const session = await settle(started.body.paymentId);

      assert.equal(session.state, outcome);
      assert.ok(session.failureReason, 'the customer must be told why');
      const orders = platform.store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get();
      assert.equal(orders.n, 0, `a ${outcome} payment must not create an order`);
    });
  }

  test('a declined payment tells the customer no money was taken', async () => {
    platform.paymentAdapter.setDefaultOutcome('declined');
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'declined-msg-1',
    });
    const session = await settle(started.body.paymentId);
    assert.match(session.promptEn, /declined/i);
    assert.ok(session.promptAr.length > 0, 'Arabic prompt required');
  });
});

describe('payments: the terminal that stops answering', () => {
  test('is its own state, never auto-resolved either way', async () => {
    platform.paymentAdapter.setDefaultOutcome('unknown');
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'unknown-1', kioskId: 'kiosk-01',
    });
    const session = await settle(started.body.paymentId);

    assert.equal(session.state, 'unknown');
    assert.equal(session.needsStaff, true);
    // Neither approved nor declined: no order, and no claim either way.
    assert.equal(platform.store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 0);
  });

  test('tells the customer to find a person before paying again', async () => {
    platform.paymentAdapter.setDefaultOutcome('unknown');
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'unknown-msg-1',
    });
    const session = await settle(started.body.paymentId);
    assert.match(session.promptEn, /staff/i);
    assert.match(session.promptEn, /before paying again/i);
  });

  test('reaches the operator exception list', async () => {
    platform.paymentAdapter.setDefaultOutcome('unknown');
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'unknown-ops-1',
    });
    await settle(started.body.paymentId);

    const token = await http.managerToken();
    const ops = await http.get('/api/ops/exceptions', { token });
    assert.equal(ops.body.paymentsNeedingAttention.length, 1);
    assert.equal(ops.body.paymentsNeedingAttention[0].state, 'unknown');
  });

  test('cannot be cancelled by the customer', async () => {
    platform.paymentAdapter.setDefaultOutcome('unknown');
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'unknown-cancel-1',
    });
    await settle(started.body.paymentId);
    const response = await http.post(`/api/kiosk/payments/${started.body.paymentId}/cancel`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'payment_needs_staff');
  });
});

describe('payments: cancellation', () => {
  test('allowed while the terminal is waiting for a card', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'cancel-early-1',
    });
    assert.equal(started.body.state, 'waiting_for_card');
    assert.equal(started.body.cancellable, true);

    const cancelled = await http.post(`/api/kiosk/payments/${started.body.paymentId}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.state, 'cancelled');
    assert.equal(platform.store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 0);
  });

  test('refused once the card is being processed', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'cancel-late-1',
    });
    // Land exactly on `processing`. Ageing advance_at would no longer work:
    // the catch-up correctly runs the machine all the way to its outcome in a
    // single poll, which is the behaviour a late poll depends on.
    platform.kioskDb.prepare(`
      UPDATE kiosk_payment_sessions
      SET state = 'processing', advance_at = ?
      WHERE id = ?
    `).run(new Date(Date.now() + 60_000).toISOString(), started.body.paymentId);
    const mid = await platform.payments.getStatus(started.body.paymentId);
    assert.equal(mid.state, 'processing');

    const response = await http.post(`/api/kiosk/payments/${started.body.paymentId}/cancel`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'payment_not_cancellable');
  });

  test('cancelling twice is harmless', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'cancel-twice-1',
    });
    await http.post(`/api/kiosk/payments/${started.body.paymentId}/cancel`);
    const second = await http.post(`/api/kiosk/payments/${started.body.paymentId}/cancel`);
    assert.equal(second.status, 200);
    assert.equal(second.body.state, 'cancelled');
  });
});

describe('payments: double taps and reloads', () => {
  test('two taps on Pay open one payment, not two', async () => {
    const quote = await freshQuote();
    const payload = { quoteId: quote.quoteId, clientRequestId: 'double-tap-1', kioskId: 'kiosk-01' };
    const first = await http.post('/api/kiosk/payments', payload);
    const second = await http.post('/api/kiosk/payments', payload);

    assert.equal(first.body.paymentId, second.body.paymentId);
    const count = platform.kioskDb.prepare('SELECT COUNT(*) AS n FROM kiosk_payment_sessions').get();
    assert.equal(count.n, 1);
  });

  test('a browser reload mid-payment resumes the same payment', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'reload-1', kioskId: 'kiosk-01',
    });
    // A reload re-reads by id; the payment is durable, not in a tab.
    const resumed = await http.get(`/api/kiosk/payments/${started.body.paymentId}`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.paymentId, started.body.paymentId);
  });

  test('polling an approved payment repeatedly never creates a second order', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'poll-approved-1', kioskId: 'kiosk-01',
    });
    await settle(started.body.paymentId);
    for (let i = 0; i < 5; i += 1) await http.get(`/api/kiosk/payments/${started.body.paymentId}`);
    assert.equal(platform.store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 1);
  });
});

describe('payments: gift cards and split payment', () => {
  test('a gift card covering everything settles with no card leg', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'gift-full-1', kioskId: 'kiosk-01',
      giftCardCode: 'DEMO-GIFT-5000',
    });
    assert.equal(started.body.state, 'approved');
    assert.equal(started.body.cardAmountMinor, 0);
    assert.ok(started.body.order, 'the order is created immediately');

    const card = platform.store.findGiftCard('DEMO-GIFT-5000');
    assert.equal(card.balanceMinor, 5000 - quote.quote.totalMinor);
  });

  test('a partial gift card splits, charging only the remainder to the card', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'gift-split-1', kioskId: 'kiosk-01',
      giftCardCode: 'DEMO-GIFT-1200',
    });
    assert.equal(started.body.giftAppliedMinor, 1200);
    assert.equal(started.body.cardAmountMinor, quote.quote.totalMinor - 1200);

    const session = await settle(started.body.paymentId);
    assert.equal(session.state, 'approved');
    assert.equal(platform.store.findGiftCard('DEMO-GIFT-1200').balanceMinor, 0);

    const order = platform.store.db
      .prepare("SELECT * FROM pos_orders WHERE client_request_id = 'gift-split-1'")
      .get();
    assert.equal(order.total_minor, quote.quote.totalMinor, 'the POS records the full order value');
    assert.equal(order.payment_status, 'paid');
  });

  test('the gift card is NOT debited until the payment is taken', async () => {
    const quote = await freshQuote();
    await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'gift-not-yet-1', giftCardCode: 'DEMO-GIFT-1200',
    });
    // Still waiting for a card: a customer who walks away must not be out of pocket.
    assert.equal(platform.store.findGiftCard('DEMO-GIFT-1200').balanceMinor, 1200);
  });

  test('a declined card leg leaves the gift balance untouched', async () => {
    platform.paymentAdapter.setDefaultOutcome('declined');
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'gift-declined-1', giftCardCode: 'DEMO-GIFT-1200',
    });
    await settle(started.body.paymentId);
    assert.equal(platform.store.findGiftCard('DEMO-GIFT-1200').balanceMinor, 1200,
      'a declined card must not consume the gift card');
  });

  test('an empty gift card is refused', async () => {
    const quote = await freshQuote();
    const response = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'gift-empty-1', giftCardCode: 'DEMO-GIFT-0000',
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'gift_card_empty');
  });

  test('an unknown gift card is refused', async () => {
    const quote = await freshQuote();
    const response = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'gift-unknown-1', giftCardCode: 'NOT-A-CARD',
    });
    assert.equal(response.status, 404);
  });

  test('the customer never sees the full gift card code back', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'gift-mask-1', giftCardCode: 'DEMO-GIFT-1200',
    });
    const body = JSON.stringify(started.body);
    assert.ok(!body.includes('DEMO-GIFT-1200'), 'a gift code is a bearer credential');
    assert.match(started.body.giftCardCode, /^••••/);
  });
});

describe('payments: cash at the counter', () => {
  test('creates an UNPAID order; the kiosk cannot mark cash received', async () => {
    const quote = await freshQuote();
    const response = await http.post('/api/kiosk/payments/cash', {
      quoteId: quote.quoteId, clientRequestId: 'cash-counter-1', kioskId: 'kiosk-01',
    });
    assert.equal(response.status, 201);

    const order = platform.store.db
      .prepare("SELECT * FROM pos_orders WHERE client_request_id = 'cash-counter-1'")
      .get();
    assert.equal(order.payment_status, 'unpaid');
  });

  test('only authenticated staff can mark it paid', async () => {
    const quote = await freshQuote();
    const response = await http.post('/api/kiosk/payments/cash', {
      quoteId: quote.quoteId, clientRequestId: 'cash-staff-1', kioskId: 'kiosk-01',
    });
    const posOrderId = response.body.posOrderId;

    // No kiosk route can do this.
    const unauth = await http.post(`/demo-pos/api/orders/${posOrderId}/payments`, {
      method: 'cash_counter', status: 'approved', amountMinor: quote.quote.totalMinor,
    });
    assert.equal(unauth.status, 401);

    const token = await http.baristaToken();
    const authed = await http.post(`/demo-pos/api/orders/${posOrderId}/payments`, {
      method: 'cash_counter', status: 'approved', amountMinor: quote.quote.totalMinor,
    }, { token });
    assert.equal(authed.status, 200);
    assert.equal(authed.body.paymentStatus, 'paid');
  });
});

describe('payments: no card data anywhere', () => {
  test('the session schema has no card-data columns', () => {
    const columns = platform.kioskDb
      .prepare("SELECT name FROM pragma_table_info('kiosk_payment_sessions')")
      .all().map((c) => c.name.toLowerCase());
    for (const forbidden of ['pan', 'card_number', 'cvv', 'cvc', 'pin', 'track1', 'track2', 'expiry']) {
      assert.ok(!columns.includes(forbidden), `must not store ${forbidden}`);
    }
  });

  test('a client cannot smuggle card data into a payment', async () => {
    const quote = await freshQuote();
    await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'no-card-data-1',
      pan: '4111111111111111', cvv: '123', expiry: '12/29',
    });
    const stored = JSON.stringify(
      platform.kioskDb.prepare('SELECT * FROM kiosk_payment_sessions').all(),
    );
    assert.ok(!stored.includes('4111111111111111'), 'a PAN must never reach the database');
    assert.ok(!stored.includes('123456'), 'no smuggled values');
  });

  test('only a masked brand label is ever shown', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'masked-1',
    });
    const session = await settle(started.body.paymentId);
    assert.match(session.maskedDetail, /••••\d{4}$/);
    assert.equal(session.simulated, true, 'must be flagged as simulated');
  });
});

describe('payments: durability', () => {
  test('a payment in flight survives a full platform restart', async () => {
    const dir = platform.tempDir;
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'restart-pay-1', kioskId: 'kiosk-01',
    });
    const paymentId = started.body.paymentId;

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
      // The payment is still there, and still advances.
      revived.kioskDb
        .prepare("UPDATE kiosk_payment_sessions SET advance_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
        .run(paymentId);
      let session = await revived.payments.getStatus(paymentId);
      for (let i = 0; i < 20 && !session.terminal; i += 1) {
        revived.kioskDb
          .prepare("UPDATE kiosk_payment_sessions SET advance_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
          .run(paymentId);
        session = await revived.payments.getStatus(paymentId);
      }
      assert.equal(session.state, 'approved');
      assert.equal(
        revived.store.db.prepare("SELECT COUNT(*) AS n FROM pos_orders WHERE client_request_id = 'restart-pay-1'").get().n,
        1,
        'exactly one order, no double charge',
      );
    } finally {
      revived.close();
      http = { close: async () => {} };
      platform = { close: () => {}, tempDir: dir };
    }
  });

  test('every state change is recorded for a dispute', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'audit-pay-1',
    });
    await settle(started.body.paymentId);
    const events = platform.paymentAdapter.listEvents(started.body.paymentId);
    const states = events.map((e) => e.to_state);
    assert.deepEqual(states, ['waiting_for_card', 'processing', 'approved']);
  });
});

describe('payments: the operator panel', () => {
  test('forcing an outcome needs a manager', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'force-auth-1',
    });
    const path = `/demo-pos/api/demo/payments/${started.body.paymentId}/force`;

    assert.equal((await http.post(path, { outcome: 'declined' })).status, 401);
    const barista = await http.baristaToken();
    assert.equal((await http.post(path, { outcome: 'declined' }, { token: barista })).status, 403);
    const manager = await http.managerToken();
    assert.equal((await http.post(path, { outcome: 'declined' }, { token: manager })).status, 200);
  });

  test('a forced decline lands immediately', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'force-decline-1',
    });
    const token = await http.managerToken();
    const forced = await http.post(
      `/demo-pos/api/demo/payments/${started.body.paymentId}/force`,
      { outcome: 'declined' }, { token },
    );
    assert.equal(forced.body.state, 'declined');
    assert.equal(platform.store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 0);
  });

  test('a finished payment cannot be forced into another state', async () => {
    const quote = await freshQuote();
    const started = await http.post('/api/kiosk/payments', {
      quoteId: quote.quoteId, clientRequestId: 'force-final-1',
    });
    await settle(started.body.paymentId);
    const token = await http.managerToken();
    const response = await http.post(
      `/demo-pos/api/demo/payments/${started.body.paymentId}/force`,
      { outcome: 'declined' }, { token },
    );
    assert.equal(response.status, 409);
  });

  test('an invalid outcome is refused', async () => {
    const token = await http.managerToken();
    const response = await http.post('/demo-pos/api/demo/payments/default-outcome',
      { outcome: 'free_coffee' }, { token });
    assert.ok(response.status >= 400);
  });
});

describe('payments: real bank adapters are honestly unimplemented', () => {
  test('they throw rather than pretending to approve', async () => {
    for (const Adapter of [ArabBankTerminalAdapter, BankOfPalestineTerminalAdapter]) {
      const adapter = new Adapter();
      assert.equal(adapter.implemented, false);
      await assert.rejects(() => adapter.startPayment({}), /not implemented/i);
      await assert.rejects(() => adapter.getPaymentStatus('x'), /not implemented/i);
    }
  });

  test('health reports them as not implemented, not merely unhealthy', async () => {
    const health = await new ArabBankTerminalAdapter().health();
    assert.equal(health.implemented, false);
    assert.match(health.detail, /SDK/i);
  });

  test('the blocked-on list is specific enough to act on', async () => {
    const adapter = new ArabBankTerminalAdapter();
    const error = await adapter.startPayment({}).catch((e) => e);
    const blockers = error.details.blockedOn.join(' ');
    assert.match(blockers, /unattended/i, 'unattended certification is the critical one');
    assert.match(blockers, /PCI/i);
    assert.match(blockers, /test terminal|test cards/i);
  });
});

describe('payments: state machine shape', () => {
  test('terminal states are terminal', () => {
    for (const state of ['approved', 'declined', 'cancelled', 'timed_out', 'failed', 'voided']) {
      assert.equal(isTerminal(state), true, `${state} must be terminal`);
    }
    for (const state of ['created', 'waiting_for_card', 'processing', 'unknown']) {
      assert.equal(isTerminal(state), false, `${state} must not be terminal`);
    }
  });

  test('every documented state is reachable in the schema', () => {
    const check = platform.kioskDb
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'kiosk_payment_sessions'")
      .get().sql;
    for (const state of PAYMENT_STATES) {
      assert.ok(check.includes(`'${state}'`), `${state} missing from the state CHECK constraint`);
    }
  });
});
