import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestPlatform, LATTE_LINE } from './helpers.js';
import { ReceiptService, receiptOrigin, RECEIPT_TOKEN_PATTERN, DEFAULT_PLATFORM_PORT } from '../services/receipts.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { receiptRoutes } from '../routes/receipts.js';
import express from 'express';

let platform;
beforeEach(async () => {
  platform = makeTestPlatform();
  await platform.menuSync.syncNow();
});
afterEach(() => platform?.close());

/** Place a real order through the full checkout path. */
async function placeOrder(p, clientRequestId = 'req-receipt-1') {
  const quote = await p.checkout.createQuote({ kioskId: 'kiosk-01', cart: { fulfillment: 'takeaway', lines: [LATTE_LINE] } });
  return p.checkout.submitOrder({ clientRequestId, quoteId: quote.quoteId, kioskId: 'kiosk-01' });
}

describe('receipts: issuing', () => {
  test('a confirmed order gets a receipt token', async () => {
    const result = await placeOrder(platform);
    assert.equal(result.status, 'confirmed');
    assert.ok(result.receiptToken, 'a confirmed order must carry a receipt token');
    assert.match(result.receiptToken, RECEIPT_TOKEN_PATTERN);
  });

  test('the token is unguessable: 32 random bytes, base64url', async () => {
    const seen = new Set();
    for (let i = 0; i < 25; i += 1) {
      const token = platform.receipts.issue({ posOrderId: `pos-${i}`, posOrderNumber: `${1000 + i}` });
      assert.match(token, RECEIPT_TOKEN_PATTERN);
      assert.equal(Buffer.from(token, 'base64url').length, 32);
      seen.add(token);
    }
    assert.equal(seen.size, 25, 'every token must be distinct');
  });

  test('re-issuing for the same POS order returns the same link', async () => {
    const first = platform.receipts.issue({ posOrderId: 'pos-x', posOrderNumber: '1001' });
    const second = platform.receipts.issue({ posOrderId: 'pos-x', posOrderNumber: '1001' });
    assert.equal(first, second, 'one order must not accumulate receipt links');
    const n = platform.kioskDb.prepare('SELECT COUNT(*) AS n FROM kiosk_receipts').get().n;
    assert.equal(n, 1);
  });

  test('a retried submission does not mint a second token', async () => {
    const first = await placeOrder(platform, 'req-same');
    const second = await placeOrder(platform, 'req-same');
    assert.equal(first.receiptToken, second.receiptToken);
  });

  test('the token lives in the kiosk database, never in pos_orders', async () => {
    await placeOrder(platform);
    const posColumns = platform.posDb.prepare('PRAGMA table_info(pos_orders)').all().map((c) => c.name);
    assert.ok(!posColumns.some((c) => c.includes('receipt')),
      'a real client POS will not store our receipt tokens; the column must not exist');
    assert.equal(platform.kioskDb.prepare('SELECT COUNT(*) AS n FROM kiosk_receipts').get().n, 1);
  });
});

describe('receipts: resolving', () => {
  test('a valid token resolves to the order', async () => {
    const order = await placeOrder(platform);
    const receipt = await platform.receipts.resolve(order.receiptToken);
    assert.ok(receipt);
    assert.equal(receipt.posOrderNumber, order.posOrderNumber);
    assert.equal(receipt.totalMinor, order.order.totalMinor);
    assert.ok(receipt.items.length > 0);
  });

  test('status is re-read from the POS, not frozen at issue time', async () => {
    const order = await placeOrder(platform);
    platform.store.updateKitchenStatus(order.posOrderId, 'ready', { type: 'manager', id: 't' });
    const receipt = await platform.receipts.resolve(order.receiptToken);
    assert.equal(receipt.kitchenStatus, 'ready', 'a receipt opened later must show current status');
  });

  test('no payment reference or customer detail leaks onto a bearer URL', async () => {
    const order = await placeOrder(platform);
    const receipt = await platform.receipts.resolve(order.receiptToken);
    const serialised = JSON.stringify(receipt);
    assert.ok(!('paymentReference' in receipt), 'payment reference must not appear on a shareable link');
    assert.ok(!/customer_name|phone|loyalty/i.test(serialised));
  });

  test('an unknown token resolves to nothing', async () => {
    assert.equal(await platform.receipts.resolve('A'.repeat(43)), null);
  });

  test('a malformed token is rejected before touching the database', async () => {
    for (const bad of ['', 'short', '../../etc/passwd', "' OR 1=1 --", 'x'.repeat(200), null]) {
      assert.equal(await platform.receipts.resolve(bad), null, `must reject: ${bad}`);
    }
  });

  test('an expired token stops working', async () => {
    const expired = new ReceiptService({
      kioskStore: platform.kioskStore, adapter: platform.adapter, storeId: platform.storeId, ttlHours: -1,
    });
    // A POS order the live service has not already issued a token for,
    // otherwise issue() correctly hands back the existing un-expired link.
    const order = await placeOrder(platform);
    platform.kioskDb.prepare('DELETE FROM kiosk_receipts WHERE pos_order_id = ?').run(order.posOrderId);
    const token = expired.issue({ posOrderId: order.posOrderId, posOrderNumber: order.posOrderNumber });
    assert.equal(await expired.resolve(token), null, 'an expired link must not resolve');
  });

  test('purgeExpired removes only dead links', async () => {
    const order = await placeOrder(platform);
    const live = order.receiptToken;
    platform.kioskDb
      .prepare("INSERT INTO kiosk_receipts (token, store_id, pos_order_id, pos_order_number, expires_at) VALUES (?,?,?,?,?)")
      .run('B'.repeat(43), platform.storeId, 'pos-dead', '999', '2000-01-01T00:00:00.000Z');
    assert.equal(platform.receipts.purgeExpired(), 1);
    assert.ok(await platform.receipts.resolve(live), 'a live receipt must survive the purge');
  });
});

describe('receipts: reachable origin', () => {
  test('PUBLIC_RECEIPT_ORIGIN wins and loses a trailing slash', () => {
    assert.equal(receiptOrigin({ env: { PUBLIC_RECEIPT_ORIGIN: 'https://shop.example/' } }), 'https://shop.example');
  });

  test('without configuration the origin is never localhost', () => {
    const origin = receiptOrigin({ env: {}, port: 3001 });
    if (origin !== null) {
      assert.ok(!/localhost|127\.0\.0\.1/.test(origin),
        'a QR pointing at localhost scans fine and then fails on the phone');
    }
  });

  test('the default port is the one main.js actually listens on', () => {
    // Regression: the QR pointed at 3001 (the old V3 server) while the
    // platform listened on 4001, so every scan returned "Cannot GET".
    const main = readFileSync(fileURLToPath(new URL('../main.js', import.meta.url)), 'utf8');
    assert.match(main, /PLATFORM_PORT \?\? DEFAULT_PLATFORM_PORT/,
      'main.js must take its default port from the same constant the receipt URL uses');
    const origin = receiptOrigin({ env: {} });
    if (origin) {
      assert.match(origin, new RegExp(`:${DEFAULT_PLATFORM_PORT}$`),
        'a receipt URL must point at the platform port, not a guess');
    }
  });

  test('main.js binds the real listening port into the receipt origin', () => {
    const main = readFileSync(fileURLToPath(new URL('../main.js', import.meta.url)), 'utf8');
    assert.match(main, /bindPort\(boundPort\)/,
      'the port must come from the bound socket, never from an assumption');
    assert.match(main, /server\.address\(\)\?\.port \?\? port/,
      'address() is null on a failed bind and must never be dereferenced blindly');
    assert.ok(!/server\.address\(\)\.port/.test(main),
      'an unguarded address().port turns a port conflict into a TypeError');
  });

  test('main.js reports a port conflict instead of crashing', () => {
    const main = readFileSync(fileURLToPath(new URL('../main.js', import.meta.url)), 'utf8');
    assert.match(main, /server\.on\('error'/, 'a failed bind must be handled');
    assert.match(main, /EADDRINUSE/, 'the common case deserves a named message');
    assert.match(main, /PLATFORM_PORT=/, 'the message must say how to use another port');
  });

  test('bindPort overrides the default with the real port', () => {
    const service = new ReceiptService({
      kioskStore: platform.kioskStore, adapter: platform.adapter, storeId: platform.storeId,
    });
    const origin = service.bindPort(5555);
    if (origin) {
      assert.match(origin, /:5555$/);
      assert.match(service.urlFor('T'.repeat(43)), /:5555\/receipt\/T{43}$/);
    }
  });

  test('PLATFORM_PORT is honoured when set', () => {
    const origin = receiptOrigin({ env: { PLATFORM_PORT: '9099' } });
    if (origin) assert.match(origin, /:9099$/);
  });

  test('no reachable origin means no URL, rather than a broken one', () => {
    const service = new ReceiptService({
      kioskStore: platform.kioskStore, adapter: platform.adapter, storeId: platform.storeId, origin: null,
    });
    service.origin = null;
    const url = service.urlFor(null);
    assert.equal(url, null);
  });
});

describe('receipts: HTTP surface', () => {
  async function serve() {
    const app = express();
    app.use(receiptRoutes({ receipts: platform.receipts }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: () => new Promise((d) => server.close(d)) };
  }

  test('GET /api/receipts/:token returns the receipt', async () => {
    const order = await placeOrder(platform);
    const { base, close } = await serve();
    try {
      const res = await fetch(`${base}/api/receipts/${order.receiptToken}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.receipt.posOrderNumber, order.posOrderNumber);
    } finally { await close(); }
  });

  test('an unknown token is a 404, not a server error', async () => {
    const { base, close } = await serve();
    try {
      assert.equal((await fetch(`${base}/api/receipts/${'C'.repeat(43)}`)).status, 404);
      assert.equal((await fetch(`${base}/receipt/${'C'.repeat(43)}`)).status, 404);
    } finally { await close(); }
  });

  test('GET /receipt/:token renders HTML a phone can read', async () => {
    const order = await placeOrder(platform);
    const { base, close } = await serve();
    try {
      const res = await fetch(`${base}/receipt/${order.receiptToken}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const html = await res.text();
      assert.match(html, /<!doctype html>/i);
      assert.ok(html.includes(order.posOrderNumber), 'the order number must appear');
      assert.match(html, /viewport/, 'must be mobile-sized');
      assert.match(html, /noindex/, 'a receipt must not be indexable');
      assert.ok(!/<script/i.test(html), 'must render without JavaScript');
    } finally { await close(); }
  });

  test('English is the default and shows no Arabic', async () => {
    const order = await placeOrder(platform);
    const { base, close } = await serve();
    try {
      const html = await (await fetch(`${base}/receipt/${order.receiptToken}`)).text();
      assert.match(html, /lang="en"/);
      assert.match(html, /dir="ltr"/);
      assert.match(html, /Digital receipt/);
      assert.ok(!/[\u0600-\u06FF]/.test(html), 'an English receipt must not mix in Arabic');
    } finally { await close(); }
  });

  test('?lang=ar renders a right-to-left Arabic receipt', async () => {
    const order = await placeOrder(platform);
    const { base, close } = await serve();
    try {
      const html = await (await fetch(`${base}/receipt/${order.receiptToken}?lang=ar`)).text();
      assert.match(html, /lang="ar"/);
      assert.match(html, /dir="rtl"/, 'Arabic must lay out right-to-left');
      assert.match(html, /إيصال رقمي/);
      assert.match(html, /المجموع/, 'the total must be labelled in Arabic');
      assert.ok(!/Digital receipt|Dine in|Takeaway/.test(html), 'an Arabic receipt must not mix in English');
    } finally { await close(); }
  });

  test('the order number stays left-to-right inside an Arabic page', async () => {
    const order = await placeOrder(platform);
    const { base, close } = await serve();
    try {
      const html = await (await fetch(`${base}/receipt/${order.receiptToken}?lang=ar`)).text();
      assert.match(html, /\.order \.num \{[^}]*direction:ltr/,
        'a number rendered RTL can read backwards to the customer');
      assert.match(html, /\.amt \{[^}]*direction:ltr/);
    } finally { await close(); }
  });

  test('a junk lang falls back to English rather than erroring', async () => {
    const order = await placeOrder(platform);
    const { base, close } = await serve();
    try {
      for (const bad of ['fr', '', '../x', 'AR']) {
        const res = await fetch(`${base}/receipt/${order.receiptToken}?lang=${encodeURIComponent(bad)}`);
        assert.equal(res.status, 200, `lang=${bad} must still render`);
        assert.match(await res.text(), /lang="en"/);
      }
    } finally { await close(); }
  });

  test('an expired link explains itself in the requested language', async () => {
    const { base, close } = await serve();
    try {
      const ar = await (await fetch(`${base}/receipt/${'D'.repeat(43)}?lang=ar`)).text();
      assert.match(ar, /انتهت صلاحيته/);
      const en = await (await fetch(`${base}/receipt/${'D'.repeat(43)}`)).text();
      assert.match(en, /not valid, or it has expired/);
    } finally { await close(); }
  });

  test('order content is HTML-escaped', async () => {
    const order = await placeOrder(platform);
    platform.posDb.prepare('UPDATE pos_order_items SET name_snapshot_en = ? WHERE order_id = ?')
      .run('<script>alert(1)</script>', order.posOrderId);
    const { base, close } = await serve();
    try {
      const html = await (await fetch(`${base}/receipt/${order.receiptToken}`)).text();
      assert.ok(!html.includes('<script>alert(1)</script>'), 'product names must be escaped');
      assert.match(html, /&lt;script&gt;/);
    } finally { await close(); }
  });
});
