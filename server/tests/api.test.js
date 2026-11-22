import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestPlatform, startHttp, LATTE_LINE } from './helpers.js';

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

describe('API: kiosk menu', () => {
  test('serves the menu with freshness metadata', async () => {
    const { status, body } = await http.get('/api/kiosk/menu');
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.equal(body.currency, 'ILS');
    assert.equal(body.products.length, 12);
    assert.equal(body.sync.stale, false);
    assert.ok(typeof body.sync.ageSeconds === 'number');
    assert.ok(body.menuVersion);
  });

  test('every product carries VAT-inclusive integer prices and modifier groups', async () => {
    const { body } = await http.get('/api/kiosk/menu');
    for (const product of body.products) {
      assert.ok(Number.isInteger(product.priceMinor), `${product.nameEn} price must be an integer`);
      assert.ok(Number.isInteger(product.taxRateBp));
      assert.equal(typeof product.available, 'boolean');
      assert.ok(Array.isArray(product.modifierGroups));
      assert.ok(product.nameAr && product.nameAr.length > 0, `${product.nameEn} needs an Arabic name`);
    }
  });

  test('no monetary value is ever sent as a float', async () => {
    const { body } = await http.get('/api/kiosk/menu');
    const walk = (value, path) => {
      if (typeof value === 'number' && /Minor$/.test(path)) {
        assert.ok(Number.isInteger(value), `${path} must be an integer, got ${value}`);
      }
      if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) walk(inner, key);
      }
    };
    walk(body, 'root');
  });

  test('store config exposes the surcharge and timeout for the UI', async () => {
    const { body } = await http.get('/api/kiosk/config');
    assert.equal(body.currency, 'ILS');
    assert.equal(body.surcharge.kind, 'fixed');
    assert.equal(body.surcharge.value, 200);
    assert.ok(body.surcharge.labelAr.length > 0);
    assert.equal(body.inactivityTimeoutSeconds, 60);
  });
});

describe('API: kiosk cannot mutate the catalog', () => {
  test('there is no kiosk route that changes a price', async () => {
    for (const [method, path] of [
      ['PATCH', '/api/kiosk/menu/PRD-1003'],
      ['PATCH', '/api/kiosk/products/PRD-1003'],
      ['POST', '/api/kiosk/products'],
    ]) {
      const response = await (method === 'PATCH'
        ? http.patch(path, { priceMinor: 1 })
        : http.post(path, { priceMinor: 1 }));
      assert.equal(response.status, 404, `${method} ${path} must not exist`);
    }
  });
});

describe('API: Demo POS authentication', () => {
  test('staff routes reject an absent or bad token', async () => {
    for (const path of ['/demo-pos/api/menu', '/demo-pos/api/orders', '/demo-pos/api/kitchen/queue', '/demo-pos/api/audit']) {
      assert.equal((await http.get(path)).status, 401, `${path} must require auth`);
      assert.equal((await http.get(path, { token: 'not-a-real-token' })).status, 401);
    }
  });

  test('login succeeds and the token works', async () => {
    const login = await http.post('/demo-pos/api/auth/login', { username: 'manager', password: 'demo-manager-1234' });
    assert.equal(login.status, 200);
    assert.ok(login.body.accessToken);
    assert.equal(login.body.user.role, 'manager');
    const me = await http.get('/demo-pos/api/auth/me', { token: login.body.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'manager');
  });

  test('a wrong password gives the same message as a wrong username', async () => {
    const badUser = await http.post('/demo-pos/api/auth/login', { username: 'nobody', password: 'demo-manager-1234' });
    const badPass = await http.post('/demo-pos/api/auth/login', { username: 'manager', password: 'wrong-password' });
    assert.equal(badUser.status, 401);
    assert.equal(badPass.status, 401);
    assert.equal(badUser.body.error.message, badPass.body.error.message,
      'messages must match so usernames cannot be enumerated');
  });

  test('logout invalidates the token', async () => {
    const token = await http.managerToken();
    assert.equal((await http.get('/demo-pos/api/auth/me', { token })).status, 200);
    await http.post('/demo-pos/api/auth/logout', undefined, { token });
    assert.equal((await http.get('/demo-pos/api/auth/me', { token })).status, 401);
  });

  test('repeated failed logins are rate limited', async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const response = await http.post('/demo-pos/api/auth/login', { username: 'manager', password: 'wrong' });
      if (response.status === 429) { sawRateLimit = true; break; }
    }
    assert.ok(sawRateLimit, 'brute force must be throttled');
  });
});

describe('API: role separation', () => {
  test('a barista cannot change a price or read the audit log', async () => {
    const token = await http.baristaToken();
    assert.equal((await http.patch('/demo-pos/api/products/PRD-1003', { price: '1.00' }, { token })).status, 403);
    assert.equal((await http.get('/demo-pos/api/audit', { token })).status, 403);
    assert.equal((await http.patch('/demo-pos/api/config', { store_name_en: 'Hacked' }, { token })).status, 403);
  });

  test('a barista CAN work the kitchen queue', async () => {
    const token = await http.baristaToken();
    assert.equal((await http.get('/demo-pos/api/kitchen/queue', { token })).status, 200);
  });

  test('a manager can change a price', async () => {
    const token = await http.managerToken();
    const response = await http.patch('/demo-pos/api/products/PRD-1003', { price: '21.50' }, { token });
    assert.equal(response.status, 200);
    assert.equal(response.body.priceMinor, 2150);
  });
});

describe('API: price parsing', () => {
  test('decimal strings parse exactly', async () => {
    const token = await http.managerToken();
    for (const [input, expected] of [['15.05', 1505], ['18', 1800], ['0.05', 5], ['21.50', 2150]]) {
      const response = await http.patch('/demo-pos/api/products/PRD-1003', { price: input }, { token });
      assert.equal(response.body.priceMinor, expected, `"${input}" should be ${expected}`);
    }
  });

  test('junk prices are refused, not coerced', async () => {
    const token = await http.managerToken();
    for (const bad of ['abc', '', '4.255', '1e3', '-5', null]) {
      const response = await http.patch('/demo-pos/api/products/PRD-1003', { price: bad }, { token });
      assert.ok(response.status >= 400, `"${bad}" must be refused, got ${response.status}`);
    }
  });

  test('a float priceMinor is refused', async () => {
    const token = await http.managerToken();
    const response = await http.patch('/demo-pos/api/products/PRD-1003', { priceMinor: 15.5 }, { token });
    assert.equal(response.status, 422);
  });
});

describe('API: full ordering flow', () => {
  test('quote then order, with the price coming from the server', async () => {
    const quote = await http.post('/api/kiosk/quotes', {
      kioskId: 'kiosk-01',
      cart: { fulfillment: 'dine_in', lines: [LATTE_LINE] },
    });
    assert.equal(quote.status, 201);
    assert.equal(quote.body.quote.totalMinor, 2100); // 19.00 + 2.00 surcharge
    assert.ok(quote.body.quoteId);

    const order = await http.post('/api/kiosk/orders', {
      clientRequestId: 'api-flow-key-01',
      quoteId: quote.body.quoteId,
      kioskId: 'kiosk-01',
    });
    assert.equal(order.status, 201);
    assert.equal(order.body.status, 'confirmed');
    assert.ok(order.body.posOrderNumber);

    const token = await http.managerToken();
    const queue = await http.get('/demo-pos/api/kitchen/queue', { token });
    assert.equal(queue.body.orders.length, 1);
    assert.equal(queue.body.orders[0].posOrderNumber, order.body.posOrderNumber);
    assert.equal(queue.body.orders[0].totalMinor, 2100);
  });

  test('a duplicate POST returns the original order, not a second one', async () => {
    const quote = await http.post('/api/kiosk/quotes', {
      kioskId: 'kiosk-01', cart: { fulfillment: 'takeaway', lines: [LATTE_LINE] },
    });
    const payload = { clientRequestId: 'api-dupe-key-01', quoteId: quote.body.quoteId, kioskId: 'kiosk-01' };
    const first = await http.post('/api/kiosk/orders', payload);
    const second = await http.post('/api/kiosk/orders', payload);

    assert.equal(first.body.posOrderNumber, second.body.posOrderNumber);
    assert.equal(second.body.duplicate, true);

    const token = await http.managerToken();
    const orders = await http.get('/demo-pos/api/orders?limit=100', { token });
    assert.equal(orders.body.orders.filter((o) => o.clientRequestId === 'api-dupe-key-01').length, 1);
  });

  test('a quote cannot be spent twice', async () => {
    const quote = await http.post('/api/kiosk/quotes', {
      kioskId: 'kiosk-01', cart: { fulfillment: 'takeaway', lines: [LATTE_LINE] },
    });
    await http.post('/api/kiosk/orders', { clientRequestId: 'spend-key-0001', quoteId: quote.body.quoteId });
    const reuse = await http.post('/api/kiosk/orders', { clientRequestId: 'spend-key-0002', quoteId: quote.body.quoteId });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.body.error.code, 'conflict');
  });

  test('a missing clientRequestId is refused', async () => {
    const quote = await http.post('/api/kiosk/quotes', {
      kioskId: 'kiosk-01', cart: { fulfillment: 'takeaway', lines: [LATTE_LINE] },
    });
    const response = await http.post('/api/kiosk/orders', { quoteId: quote.body.quoteId });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'validation_failed');
  });

  test('an unknown quote ID is refused', async () => {
    const response = await http.post('/api/kiosk/orders', {
      clientRequestId: 'ghost-quote-0001',
      quoteId: '00000000-0000-0000-0000-000000000000',
    });
    assert.equal(response.status, 404);
  });
});

describe('API: price change visible to the kiosk', () => {
  test('a manager price change reaches the kiosk after a sync', async () => {
    const token = await http.managerToken();
    const before = await http.get('/api/kiosk/menu');
    const latteBefore = before.body.products.find((p) => p.posProductId === 'PRD-1002').priceMinor;
    assert.equal(latteBefore, 1500);

    await http.patch('/demo-pos/api/products/PRD-1002', { price: '18.50' }, { token });
    await http.post('/api/kiosk/menu/sync');

    const after = await http.get('/api/kiosk/menu');
    assert.equal(after.body.products.find((p) => p.posProductId === 'PRD-1002').priceMinor, 1850);
    assert.notEqual(after.body.menuVersion, before.body.menuVersion, 'menu version must change');
  });

  test('a sold-out item cannot be quoted', async () => {
    const token = await http.managerToken();
    await http.patch('/demo-pos/api/products/PRD-1003', { available: false }, { token });
    await http.post('/api/kiosk/menu/sync');

    const menu = await http.get('/api/kiosk/menu');
    assert.equal(menu.body.products.find((p) => p.posProductId === 'PRD-1003').available, false);

    const quote = await http.post('/api/kiosk/quotes', {
      kioskId: 'kiosk-01', cart: { fulfillment: 'takeaway', lines: [LATTE_LINE] },
    });
    assert.equal(quote.status, 409);
    assert.equal(quote.body.error.code, 'item_unavailable');
  });

  test('a cart quoted before a price change cannot be paid at the old total', async () => {
    const quote = await http.post('/api/kiosk/quotes', {
      kioskId: 'kiosk-01', cart: { fulfillment: 'takeaway', lines: [LATTE_LINE] },
    });
    const token = await http.managerToken();
    await http.patch('/demo-pos/api/products/PRD-1003', { price: '99.00' }, { token });
    await http.post('/api/kiosk/menu/sync');

    const order = await http.post('/api/kiosk/orders', {
      clientRequestId: 'stale-cart-key-1', quoteId: quote.body.quoteId,
    });
    assert.equal(order.status, 409);
    assert.equal(order.body.error.code, 'menu_changed');
  });
});

describe('API: error model', () => {
  test('errors share one shape and carry a request ID', async () => {
    const response = await http.get('/api/kiosk/quotes/nope');
    assert.equal(response.status, 404);
    assert.ok(response.body.error.code);
    assert.ok(response.body.error.message);
    assert.ok(response.body.error.requestId);
  });

  test('malformed JSON gets a clean 400, not a stack trace', async () => {
    const response = await fetch(`${http.base}/api/kiosk/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'bad_request');
    assert.ok(!JSON.stringify(body).includes('at '), 'no stack trace may leak');
  });

  test('responses are not cacheable', async () => {
    const response = await fetch(`${http.base}/api/kiosk/menu`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('the server does not advertise its framework', async () => {
    const response = await fetch(`${http.base}/api/health`);
    assert.equal(response.headers.get('x-powered-by'), null);
  });
});

describe('API: health', () => {
  test('health reports POS reachability, menu age and queue depth', async () => {
    const { status, body } = await http.get('/api/kiosk/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.pos.healthy, true);
    assert.ok(typeof body.pos.errorRate === 'number');
    assert.ok(typeof body.menu.ageSeconds === 'number');
    assert.equal(body.queue.opsExceptions ?? 0, 0);
  });
});

describe('API: operator endpoint is protected', () => {
  test('ops exceptions require a manager token', async () => {
    // This endpoint lists payment references for orders where money moved.
    assert.equal((await http.get('/api/ops/exceptions')).status, 401);
    assert.equal((await http.get('/api/ops/exceptions', { token: 'bogus' })).status, 401);
    const barista = await http.baristaToken();
    assert.equal((await http.get('/api/ops/exceptions', { token: barista })).status, 403);
    const manager = await http.managerToken();
    assert.equal((await http.get('/api/ops/exceptions', { token: manager })).status, 200);
  });

  test('no payment reference is reachable without authentication', async () => {
    const response = await http.get('/api/ops/exceptions');
    assert.equal(response.status, 401);
    assert.ok(!JSON.stringify(response.body).includes('paymentReference'));
  });
});

describe('API: health counts are numbers, not nulls', () => {
  test('an empty queue reports zeros', async () => {
    const { body } = await http.get('/api/kiosk/health');
    for (const field of ['total', 'pending', 'submitted', 'failed', 'opsExceptions']) {
      assert.equal(typeof body.queue[field], 'number', `queue.${field} must be a number, got ${body.queue[field]}`);
      assert.equal(body.queue[field], 0);
    }
  });
});

describe('API: changing a password', () => {
  test('requires the current password, even when already signed in', async () => {
    // A token left open on an unattended till must not be enough to lock the
    // real owner out.
    const token = await http.managerToken();
    const response = await http.patch('/demo-pos/api/auth/password', {
      currentPassword: 'not-the-right-one',
      newPassword: 'a-perfectly-fine-password',
    }, { token });
    assert.equal(response.status, 401);
  });

  test('enforces a minimum length and refuses digits-only', async () => {
    const token = await http.managerToken();
    for (const bad of ['short', '1234567890123', '']) {
      const response = await http.patch('/demo-pos/api/auth/password', {
        currentPassword: 'demo-manager-1234', newPassword: bad,
      }, { token });
      assert.ok(response.status >= 400, `"${bad}" should be refused`);
    }
  });

  test('refuses reusing the same password', async () => {
    const token = await http.managerToken();
    const response = await http.patch('/demo-pos/api/auth/password', {
      currentPassword: 'demo-manager-1234', newPassword: 'demo-manager-1234',
    }, { token });
    assert.equal(response.status, 422);
  });

  test('changing it ends every session, including the current one', async () => {
    const tokenA = await http.managerToken();
    const tokenB = await http.managerToken(); // a second device
    assert.equal((await http.get('/demo-pos/api/auth/me', { token: tokenB })).status, 200);

    const changed = await http.patch('/demo-pos/api/auth/password', {
      currentPassword: 'demo-manager-1234', newPassword: 'a-brand-new-password',
    }, { token: tokenA });
    assert.equal(changed.status, 200);

    // Whoever had the old password keeps nothing.
    assert.equal((await http.get('/demo-pos/api/auth/me', { token: tokenA })).status, 401);
    assert.equal((await http.get('/demo-pos/api/auth/me', { token: tokenB })).status, 401);
  });

  test('the old password stops working and the new one starts', async () => {
    const token = await http.managerToken();
    await http.patch('/demo-pos/api/auth/password', {
      currentPassword: 'demo-manager-1234', newPassword: 'a-brand-new-password',
    }, { token });

    const oldLogin = await http.post('/demo-pos/api/auth/login', {
      username: 'manager', password: 'demo-manager-1234',
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await http.post('/demo-pos/api/auth/login', {
      username: 'manager', password: 'a-brand-new-password',
    });
    assert.equal(newLogin.status, 200);
  });

  test('a barista cannot reset a manager', async () => {
    const barista = await http.baristaToken();
    assert.equal((await http.patch('/demo-pos/api/users/manager/password',
      { newPassword: 'sneaky-new-password' }, { token: barista })).status, 403);
  });

  test('a manager can reset a barista, which ends the barista sessions', async () => {
    const manager = await http.managerToken();
    const barista = await http.baristaToken();
    assert.equal((await http.get('/demo-pos/api/auth/me', { token: barista })).status, 200);

    assert.equal((await http.patch('/demo-pos/api/users/barista/password',
      { newPassword: 'barista-new-password' }, { token: manager })).status, 200);

    // The point of a reset is that the old holder loses access immediately.
    assert.equal((await http.get('/demo-pos/api/auth/me', { token: barista })).status, 401);
    // The manager's own session is unaffected.
    assert.equal((await http.get('/demo-pos/api/auth/me', { token: manager })).status, 200);

    const relogin = await http.post('/demo-pos/api/auth/login', {
      username: 'barista', password: 'barista-new-password',
    });
    assert.equal(relogin.status, 200);
  });

  test('resetting an unknown user is a 404, not a silent success', async () => {
    const token = await http.managerToken();
    const response = await http.patch('/demo-pos/api/users/ghost/password',
      { newPassword: 'some-new-password' }, { token });
    assert.equal(response.status, 404);
  });

  test('password changes are audited without recording the password', async () => {
    const token = await http.managerToken();
    await http.patch('/demo-pos/api/auth/password', {
      currentPassword: 'demo-manager-1234', newPassword: 'a-brand-new-password',
    }, { token });

    const fresh = await http.post('/demo-pos/api/auth/login', {
      username: 'manager', password: 'a-brand-new-password',
    });
    const audit = await http.get('/demo-pos/api/audit?limit=20', { token: fresh.body.accessToken });
    const event = audit.body.events.find((e) => e.eventType === 'user.password_changed');
    assert.ok(event, 'the change must be audited');
    const serialised = JSON.stringify(event);
    assert.ok(!serialised.includes('a-brand-new-password'), 'a password must never be logged');
    assert.ok(!serialised.includes('demo-manager-1234'));
  });

  test('no password hash is ever returned by an endpoint', async () => {
    const token = await http.managerToken();
    for (const path of ['/demo-pos/api/auth/me', '/demo-pos/api/users', '/demo-pos/api/audit']) {
      const response = await http.get(path, { token });
      const body = JSON.stringify(response.body);
      assert.ok(!body.includes('password_hash'), `${path} leaked a hash`);
      assert.ok(!body.includes('password_salt'), `${path} leaked a salt`);
    }
  });
});
