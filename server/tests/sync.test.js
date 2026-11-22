import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestPlatform, LATTE_LINE } from './helpers.js';

let platform;
beforeEach(async () => {
  platform = makeTestPlatform();
  await platform.menuSync.syncNow();
});
afterEach(() => platform.close());

describe('sync: menu versioning', () => {
  test('the version changes when a price changes', async () => {
    const before = platform.store.menuVersion();
    platform.store.updateProduct('PRD-1003', { priceMinor: 2000 }, { type: 'manager', id: 't' });
    assert.notEqual(platform.store.menuVersion(), before);
  });

  test('the version changes when availability changes', async () => {
    const before = platform.store.menuVersion();
    platform.store.updateProduct('PRD-1003', { available: false }, { type: 'manager', id: 't' });
    assert.notEqual(platform.store.menuVersion(), before);
  });

  test('the version changes when a modifier price changes', async () => {
    const before = platform.store.menuVersion();
    platform.store.updateModifier('MOD-MILK-OAT', { priceDeltaMinor: 400 }, { type: 'manager', id: 't' });
    assert.notEqual(platform.store.menuVersion(), before);
  });

  test('the version is stable when nothing changes', async () => {
    assert.equal(platform.store.menuVersion(), platform.store.menuVersion());
  });
});

describe('sync: quote invalidation', () => {
  test('a menu change invalidates open quotes priced against the old version', async () => {
    const { quoteId } = await platform.checkout.createQuote({
      kioskId: 'kiosk-01', cart: { fulfillment: 'takeaway', lines: [LATTE_LINE] },
    });
    assert.equal(platform.kioskStore.getQuote(quoteId).status, 'open');

    platform.store.updateProduct('PRD-1003', { priceMinor: 2500 }, { type: 'manager', id: 't' });
    await platform.menuSync.syncNow();

    assert.equal(platform.kioskStore.getQuote(quoteId).status, 'invalidated');
  });

  test('an unrelated change still invalidates, erring on the safe side', async () => {
    const { quoteId } = await platform.checkout.createQuote({
      kioskId: 'kiosk-01', cart: { fulfillment: 'takeaway', lines: [LATTE_LINE] },
    });
    platform.store.updateProduct('PRD-3002', { priceMinor: 1500 }, { type: 'manager', id: 't' });
    await platform.menuSync.syncNow();
    assert.equal(platform.kioskStore.getQuote(quoteId).status, 'invalidated');
  });
});

describe('sync: staleness', () => {
  test('a fresh sync is not stale', () => {
    const menu = platform.menuSync.getKioskMenu();
    assert.equal(menu.sync.stale, false);
    assert.ok(menu.sync.ageSeconds <= 2);
  });

  test('an old cache is reported stale', () => {
    platform.kioskStore.db
      .prepare("UPDATE kiosk_menu_cache SET synced_at = '2020-01-01T00:00:00.000Z' WHERE store_id = ?")
      .run(platform.storeId);
    const menu = platform.menuSync.getKioskMenu();
    assert.equal(menu.sync.stale, true);
    assert.ok(menu.sync.ageSeconds > 1000);
  });

  test('sync latency and error rate are tracked', async () => {
    const state = platform.kioskStore.getSyncState(platform.storeId);
    assert.ok(state.attemptsTotal >= 1);
    assert.equal(state.failuresTotal, 0);
    assert.equal(state.errorRate, 0);
    assert.ok(typeof state.lastLatencyMs === 'number');

    platform.adapter.setFaults({ offline: true });
    await platform.menuSync.syncNow();
    const after = platform.kioskStore.getSyncState(platform.storeId);
    assert.equal(after.consecutiveFailures, 1);
    assert.ok(after.errorRate > 0);
    assert.ok(after.lastError);
  });

  test('a corrupt cache is treated as absent rather than crashing', () => {
    platform.kioskStore.db
      .prepare('UPDATE kiosk_menu_cache SET payload = ? WHERE store_id = ?')
      .run('{not json', platform.storeId);
    const menu = platform.menuSync.getKioskMenu();
    assert.equal(menu.available, false);
    assert.equal(menu.reason, 'no_menu_yet');
  });
});

describe('sync: overlays cannot override authoritative data', () => {
  test('the overlay table has no price or availability column, by design', () => {
    const columns = platform.kioskStore.db
      .prepare("SELECT name FROM pragma_table_info('kiosk_content_overlays')")
      .all()
      .map((c) => c.name.toLowerCase());
    for (const forbidden of ['price', 'price_minor', 'available', 'availability', 'tax_rate_bp', 'stock']) {
      assert.ok(!columns.includes(forbidden),
        `an overlay must not be able to set ${forbidden}`);
    }
  });

  test('an overlay enriches presentation without touching price or stock', async () => {
    platform.kioskStore.upsertOverlay(platform.storeId, 'PRD-1003', {
      descriptionEn: 'Our house favourite',
      descriptionAr: 'المفضلة لدينا',
      imageUrl: '/images/latte.webp',
      calories: 180,
      allergensEn: 'Milk',
    });
    const product = platform.menuSync.getKioskMenu().products.find((p) => p.posProductId === 'PRD-1003');
    assert.equal(product.descriptionEn, 'Our house favourite');
    assert.equal(product.calories, 180);
    assert.equal(product.allergensEn, 'Milk');
    // Authoritative fields untouched.
    assert.equal(product.priceMinor, 1600);
    assert.equal(product.available, true);
  });

  test('an overlay can hide an item from the kiosk without changing the POS', async () => {
    platform.kioskStore.upsertOverlay(platform.storeId, 'PRD-3002', { hidden: true });
    const menu = platform.menuSync.getKioskMenu();
    assert.ok(!menu.products.some((p) => p.posProductId === 'PRD-3002'), 'hidden from the kiosk');
    // Still fully present and sellable in the POS.
    const posMenu = platform.store.getMenu();
    assert.ok(posMenu.products.some((p) => p.posProductId === 'PRD-3002'));
    assert.equal(posMenu.products.find((p) => p.posProductId === 'PRD-3002').available, true);
  });

  test('an overlay cannot resurrect a sold-out item', async () => {
    platform.store.updateProduct('PRD-1003', { available: false }, { type: 'manager', id: 't' });
    await platform.menuSync.syncNow();
    platform.kioskStore.upsertOverlay(platform.storeId, 'PRD-1003', { descriptionEn: 'Still here!' });
    const product = platform.menuSync.getKioskMenu().products.find((p) => p.posProductId === 'PRD-1003');
    assert.equal(product.available, false, 'the POS decides stock, not the kiosk');
  });
});

describe('sync: ID mapping', () => {
  test('a legacy key resolves to the POS product ID', () => {
    assert.equal(platform.menuSync.resolveProductRef('latte'), 'PRD-1003');
    assert.equal(platform.menuSync.resolveProductRef('espresso'), 'PRD-1001');
  });

  test('a POS ID resolves to itself', () => {
    assert.equal(platform.menuSync.resolveProductRef('PRD-1003'), 'PRD-1003');
  });

  test('an unmapped reference returns null and is logged as an integration issue', () => {
    assert.equal(platform.menuSync.resolveProductRef('flat-white'), null);
    const issues = platform.kioskStore.listIntegrationIssues();
    assert.ok(issues.some((i) => i.kind === 'mapping_missing' && i.detail.includes('flat-white')));
  });

  test('a mapping pointing at a vanished POS product is flagged', async () => {
    platform.kioskStore.upsertMapping(platform.storeId, 'ghost-drink', 'PRD-9999');
    await platform.menuSync.syncNow();
    const issues = platform.kioskStore.listIntegrationIssues();
    assert.ok(issues.some((i) => i.kind === 'mapping_dangling' && i.detail.includes('PRD-9999')));
  });

  test('repeated issues are counted, not duplicated', () => {
    platform.menuSync.resolveProductRef('nope-1');
    platform.menuSync.resolveProductRef('nope-1');
    platform.menuSync.resolveProductRef('nope-1');
    const issue = platform.kioskStore.listIntegrationIssues().find((i) => i.detail.includes('nope-1'));
    assert.equal(issue.occurrences, 3);
  });

  test('an order with an unmapped item is refused, never guessed', async () => {
    await assert.rejects(
      () => platform.checkout.createQuote({
        kioskId: 'kiosk-01',
        cart: { fulfillment: 'takeaway', lines: [{ posProductId: 'flat-white', quantity: 1, modifierIds: [] }] },
      }),
      (error) => error.code === 'mapping_missing',
    );
  });
});
