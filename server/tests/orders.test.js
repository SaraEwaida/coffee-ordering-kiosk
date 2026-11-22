import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestPlatform, LATTE_LINE } from './helpers.js';

let platform;
let store;
beforeEach(() => {
  platform = makeTestPlatform();
  store = platform.store;
});
afterEach(() => platform.close());

const submitRequest = (overrides = {}) => ({
  clientRequestId: 'test-request-0001',
  storeId: 'store-demo',
  kioskId: 'kiosk-01',
  fulfillment: 'takeaway',
  lines: [LATTE_LINE],
  currency: 'ILS',
  ...overrides,
});

describe('orders: idempotency', () => {
  test('the same clientRequestId never creates a second order', () => {
    const first = store.createOrder(submitRequest());
    const second = store.createOrder(submitRequest());

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.posOrderId, second.posOrderId);
    assert.equal(first.posOrderNumber, second.posOrderNumber);

    const count = store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n;
    assert.equal(count, 1, 'exactly one order row must exist');
  });

  test('ten concurrent-style retries still produce one order', () => {
    for (let i = 0; i < 10; i += 1) store.createOrder(submitRequest());
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pos_order_items').get().n, 1);
  });

  test('different keys create different orders', () => {
    const a = store.createOrder(submitRequest({ clientRequestId: 'key-aaaa-0001' }));
    const b = store.createOrder(submitRequest({ clientRequestId: 'key-bbbb-0002' }));
    assert.notEqual(a.posOrderId, b.posOrderId);
    assert.notEqual(a.posOrderNumber, b.posOrderNumber);
  });

  test('a malformed clientRequestId is refused', () => {
    for (const bad of ['', 'short', 'has spaces here', null, undefined]) {
      assert.throws(
        () => store.createOrder(submitRequest({ clientRequestId: bad })),
        (error) => error.code === 'invalid_client_request_id',
        `should refuse ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('orders: order numbers', () => {
  test('numbering starts above 1000 and increments', () => {
    const a = store.createOrder(submitRequest({ clientRequestId: 'num-key-0001' }));
    const b = store.createOrder(submitRequest({ clientRequestId: 'num-key-0002' }));
    assert.equal(Number(a.posOrderNumber), 1001);
    assert.equal(Number(b.posOrderNumber), 1002);
  });

  test('imported legacy history does not advance the live counter', () => {
    // Simulates an imported V3 order in the 9xxxxx band.
    store.db
      .prepare(
        `INSERT INTO pos_orders (id, order_number, sequence, channel, fulfillment, currency,
           items_subtotal_minor, total_minor, status, kitchen_status)
         VALUES ('legacy-1','V3-1','901001','legacy_v3','takeaway','USD',525,525,'completed','served')`,
      )
      .run();
    const fresh = store.createOrder(submitRequest({ clientRequestId: 'after-import-01' }));
    assert.equal(Number(fresh.posOrderNumber), 1001, 'a customer must not be given order 901002');
  });
});

describe('orders: server-side price authority', () => {
  test('a mismatched expected total is refused', () => {
    assert.throws(
      () => store.createOrder(submitRequest({ expectedTotalMinor: 1 })),
      (error) => error.code === 'total_mismatch',
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 0);
  });

  test('the matching expected total is accepted', () => {
    const order = store.createOrder(submitRequest({ expectedTotalMinor: 1900 }));
    assert.equal(order.totalMinor, 1900);
  });

  test('a price change between quote and submit is caught', () => {
    const quote = store.calculateQuote({ fulfillment: 'takeaway', lines: [LATTE_LINE] });
    store.updateProduct('PRD-1003', { priceMinor: 2500 }, { type: 'manager', id: 'test' });
    assert.throws(
      () => store.createOrder(submitRequest({ expectedTotalMinor: quote.totalMinor })),
      (error) => error.code === 'total_mismatch' && error.details.authoritativeTotalMinor === 2800,
    );
  });

  test('a currency mismatch is refused', () => {
    assert.throws(
      () => store.createOrder(submitRequest({ currency: 'USD' })),
      (error) => error.code === 'currency_mismatch',
    );
  });
});

describe('orders: payment safety', () => {
  test('an approved payment for the wrong amount is refused outright', () => {
    assert.throws(
      () => store.createOrder(submitRequest({
        payment: { method: 'card_simulated', status: 'approved', amountMinor: 100, reference: 'SIM-1' },
      })),
      (error) => error.code === 'payment_amount_mismatch',
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pos_orders').get().n, 0,
      'no order may exist after a rejected payment');
  });

  test('an approved payment for the exact amount marks the order paid', () => {
    const order = store.createOrder(submitRequest({
      payment: { method: 'card_simulated', status: 'approved', amountMinor: 1900, reference: 'SIM-OK' },
    }));
    assert.equal(order.paymentStatus, 'paid');
    assert.equal(order.paymentReference, 'SIM-OK');
  });

  test('an unknown payment method is refused', () => {
    assert.throws(
      () => store.createOrder(submitRequest({
        payment: { method: 'bitcoin', status: 'approved', amountMinor: 1900 },
      })),
      (error) => error.code === 'invalid_payment_method',
    );
  });

  test('a pending payment leaves the order unpaid', () => {
    const order = store.createOrder(submitRequest({
      payment: { method: 'cash_counter', status: 'pending', amountMinor: 1900 },
    }));
    assert.equal(order.paymentStatus, 'unpaid');
  });

  test('attachPayment refuses a wrong amount too', () => {
    const order = store.createOrder(submitRequest());
    assert.throws(
      () => store.attachPayment(order.posOrderId, {
        method: 'card_simulated', status: 'approved', amountMinor: 999, reference: 'SIM-BAD',
      }, { type: 'manager', id: 'test' }),
      (error) => error.code === 'payment_amount_mismatch',
    );
  });

  test('replaying the same payment reference does not double-record it', () => {
    const order = store.createOrder(submitRequest());
    const payment = { method: 'card_simulated', status: 'approved', amountMinor: 1900, reference: 'SIM-REPLAY' };
    const first = store.attachPayment(order.posOrderId, payment, { type: 'manager', id: 'test' });
    const second = store.attachPayment(order.posOrderId, payment, { type: 'manager', id: 'test' });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM pos_payments WHERE reference = ?').get('SIM-REPLAY');
    assert.equal(rows.n, 1);
  });

  test('no card data is stored anywhere in the schema', () => {
    const columns = store.db
      .prepare("SELECT name FROM pragma_table_info('pos_payments')")
      .all()
      .map((c) => c.name.toLowerCase());
    for (const forbidden of ['pan', 'card_number', 'cvv', 'cvc', 'pin', 'track1', 'track2', 'expiry']) {
      assert.ok(!columns.includes(forbidden), `pos_payments must not have a ${forbidden} column`);
    }
  });
});

describe('orders: kitchen status', () => {
  test('status transitions are recorded and audited', () => {
    const order = store.createOrder(submitRequest());
    const actor = { type: 'barista', id: 'barista-1' };
    assert.equal(store.updateKitchenStatus(order.posOrderId, 'preparing', actor).kitchenStatus, 'preparing');
    assert.equal(store.updateKitchenStatus(order.posOrderId, 'ready', actor).kitchenStatus, 'ready');
    const served = store.updateKitchenStatus(order.posOrderId, 'served', actor);
    assert.equal(served.kitchenStatus, 'served');
    assert.equal(served.status, 'completed');

    const events = store.listAuditEvents(20).filter((e) => e.eventType === 'order.kitchen_status_changed');
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.actorId === 'barista-1'));
  });

  test('an invalid status is refused', () => {
    const order = store.createOrder(submitRequest());
    assert.throws(
      () => store.updateKitchenStatus(order.posOrderId, 'exploded', { type: 'barista', id: 'b' }),
      (error) => error.code === 'invalid_kitchen_status',
    );
  });

  test('a PAID order cannot be cancelled without a refund', () => {
    const order = store.createOrder(submitRequest({
      payment: { method: 'card_simulated', status: 'approved', amountMinor: 1900, reference: 'SIM-PAID' },
    }));
    assert.throws(
      () => store.updateKitchenStatus(order.posOrderId, 'cancelled', { type: 'manager', id: 'm' }),
      (error) => error.code === 'refund_required',
    );
  });

  test('a cancelled order cannot be changed afterwards', () => {
    const order = store.createOrder(submitRequest());
    store.updateKitchenStatus(order.posOrderId, 'cancelled', { type: 'manager', id: 'm' });
    assert.throws(
      () => store.updateKitchenStatus(order.posOrderId, 'preparing', { type: 'manager', id: 'm' }),
      (error) => error.code === 'order_cancelled',
    );
  });

  test('imported legacy orders stay out of the live kitchen queue', () => {
    store.db
      .prepare(
        `INSERT INTO pos_orders (id, order_number, sequence, channel, fulfillment, currency,
           items_subtotal_minor, total_minor, status, kitchen_status)
         VALUES ('legacy-2','V3-7','901007','legacy_v3','takeaway','USD',525,525,'received','queued')`,
      )
      .run();
    const live = store.createOrder(submitRequest({ clientRequestId: 'queue-key-0001' }));
    const queue = store.listKitchenQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].posOrderId, live.posOrderId);
  });
});

describe('orders: price snapshots', () => {
  test('a later price change does not rewrite a past order', () => {
    const order = store.createOrder(submitRequest());
    assert.equal(order.totalMinor, 1900);
    store.updateProduct('PRD-1003', { priceMinor: 9900 }, { type: 'manager', id: 'test' });
    const reread = store.getOrder(order.posOrderId);
    assert.equal(reread.totalMinor, 1900, 'history must be immutable');
    assert.equal(reread.items[0].unitPriceMinor, 1900);
  });

  test('modifier names are snapshotted onto the order', () => {
    const order = store.createOrder(submitRequest({
      lines: [{ ...LATTE_LINE, modifierIds: ['MOD-SIZE-L', 'MOD-MILK-OAT', 'MOD-SUG-0'] }],
    }));
    const names = order.items[0].modifiers.map((m) => m.nameEn).sort();
    assert.deepEqual(names, ['Large', 'No sugar', 'Oat milk']);
    assert.ok(order.items[0].modifiers.every((m) => m.nameAr && m.nameAr.length > 0), 'Arabic names stored too');
  });
});

describe('orders: gift card atomicity', () => {
  test('redeeming moves the balance and writes a ledger entry together', () => {
    const before = store.findGiftCard('DEMO-GIFT-5000');
    const result = store.redeemGiftCard({ code: 'DEMO-GIFT-5000', amountMinor: 1500 }, { type: 'manager', id: 'm' });
    assert.equal(result.balanceMinor, before.balanceMinor - 1500);
    const ledger = store.db
      .prepare("SELECT * FROM pos_gift_card_ledger WHERE gift_card_id = 'GC-0001' AND kind = 'redeem'")
      .all();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].delta_minor, -1500);
    assert.equal(ledger[0].balance_after_minor, result.balanceMinor);
  });

  test('overdrawing is refused and leaves the balance untouched', () => {
    const before = store.findGiftCard('DEMO-GIFT-1200');
    assert.throws(
      () => store.redeemGiftCard({ code: 'DEMO-GIFT-1200', amountMinor: 999999 }, { type: 'manager', id: 'm' }),
      (error) => error.code === 'insufficient_balance',
    );
    assert.equal(store.findGiftCard('DEMO-GIFT-1200').balanceMinor, before.balanceMinor);
  });

  test('a zero or negative redemption is refused', () => {
    for (const amountMinor of [0, -100, 1.5]) {
      assert.throws(
        () => store.redeemGiftCard({ code: 'DEMO-GIFT-5000', amountMinor }, { type: 'manager', id: 'm' }),
        (error) => error.code === 'invalid_amount',
      );
    }
  });

  test('a card balance can never go negative, per the schema', () => {
    assert.throws(() => {
      store.db.prepare("UPDATE pos_gift_cards SET balance_minor = -1 WHERE id = 'GC-0001'").run();
    });
  });
});

describe('orders: audit trail', () => {
  test('every order creation is audited with an actor', () => {
    store.createOrder(submitRequest());
    const events = store.listAuditEvents(10).filter((e) => e.eventType === 'order.created');
    assert.equal(events.length, 1);
    assert.equal(events[0].actorType, 'kiosk');
    assert.ok(events[0].payload.orderNumber);
  });

  test('price changes are audited with before and after', () => {
    store.updateProduct('PRD-1002', { priceMinor: 1850 }, { type: 'manager', id: 'mgr-7' });
    const event = store.listAuditEvents(10).find((e) => e.eventType === 'product.price_changed');
    assert.equal(event.payload.fromMinor, 1500);
    assert.equal(event.payload.toMinor, 1850);
    assert.equal(event.actorId, 'mgr-7');
  });
});
