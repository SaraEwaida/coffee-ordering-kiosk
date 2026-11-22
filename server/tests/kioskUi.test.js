import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatMinor, formatDeltaMinor, modifiersText, productName, pickLang } from '../../src/config.js';
import { defaultSelection, toggleModifier, unmetGroups, unitPriceMinor } from '../../src/lib/modifiers.js';
import { makeTestPlatform, startHttp } from './helpers.js';

/**
 * Kiosk UI logic that can be tested without a DOM: money formatting, language
 * selection, and the modifier pre-selection rules. The rendering itself still
 * needs a browser test, which is a known gap (see docs/TESTING.md).
 */

describe('kiosk UI: money formatting', () => {
  test('formats shekels from integer minor units', () => {
    // The old UI hardcoded USD; a Palestine demo must show shekels.
    assert.match(formatMinor(1600, 'ILS', 'en'), /16\.00/);
    assert.match(formatMinor(900, 'ILS', 'en'), /9\.00/);
    assert.match(formatMinor(5, 'ILS', 'en'), /0\.05/);
  });

  test('never shows a dollar sign for an ILS price', () => {
    assert.ok(!formatMinor(1600, 'ILS', 'en').includes('$'));
    assert.ok(!formatMinor(1600, 'ILS', 'ar').includes('$'));
  });

  test('respects currency scale, including three-decimal JOD', () => {
    assert.match(formatMinor(4250, 'JOD', 'en'), /4\.250/);
  });

  test('Arabic uses Latin digits, as Palestinian price tags do', () => {
    const arabic = formatMinor(1600, 'ILS', 'ar');
    assert.match(arabic, /16/, `expected Latin digits, got ${arabic}`);
    assert.ok(!/[٠-٩]/.test(arabic), 'must not use Arabic-Indic digits');
  });

  test('an unknown currency degrades instead of blanking the price', () => {
    const output = formatMinor(1600, 'XYZ', 'en');
    assert.match(output, /16\.00/);
  });

  test('a missing amount yields an empty string, never NaN on screen', () => {
    assert.equal(formatMinor(undefined, 'ILS', 'en'), '');
    assert.equal(formatMinor(null, 'ILS', 'en'), '');
  });

  test('modifier deltas carry an explicit sign', () => {
    assert.match(formatDeltaMinor(300, 'ILS', 'en'), /^\+/);
    assert.match(formatDeltaMinor(-250, 'ILS', 'en'), /^−/);
    assert.equal(formatDeltaMinor(0, 'ILS', 'en'), '', 'a free option shows no price');
  });
});

describe('kiosk UI: language', () => {
  test('falls back to English when a translation is missing', () => {
    assert.equal(pickLang('ar', 'Latte', ''), 'Latte');
    assert.equal(pickLang('ar', 'Latte', 'لاتيه'), 'لاتيه');
    assert.equal(pickLang('en', 'Latte', 'لاتيه'), 'Latte');
  });

  test('product names switch language', () => {
    const product = { nameEn: 'Butter Croissant', nameAr: 'كرواسان بالزبدة' };
    assert.equal(productName(product, 'en'), 'Butter Croissant');
    assert.equal(productName(product, 'ar'), 'كرواسان بالزبدة');
  });

  test('modifier summaries join in the active language', () => {
    const modifiers = [
      { nameEn: 'Large', nameAr: 'كبير' },
      { nameEn: 'Oat milk', nameAr: 'حليب شوفان' },
    ];
    assert.equal(modifiersText(modifiers, 'en'), 'Large · Oat milk');
    assert.equal(modifiersText(modifiers, 'ar'), 'كبير · حليب شوفان');
    assert.equal(modifiersText([], 'en'), '');
  });
});

describe('kiosk UI: modifier pre-selection', () => {
  const sizeGroup = {
    groupId: 'GRP-SIZE', minSelect: 1, maxSelect: 1,
    modifiers: [
      { modifierId: 'MOD-SIZE-S', available: true },
      { modifierId: 'MOD-SIZE-M', available: true },
    ],
  };
  const syrupGroup = {
    groupId: 'GRP-SYRUP', minSelect: 0, maxSelect: 2,
    modifiers: [{ modifierId: 'MOD-SYR-VAN', available: true }],
  };

  test('a required single-choice group is pre-selected', () => {
    const selection = defaultSelection([sizeGroup]);
    assert.deepEqual(selection['GRP-SIZE'], ['MOD-SIZE-S']);
  });

  test('an optional group starts empty', () => {
    const selection = defaultSelection([syrupGroup]);
    assert.deepEqual(selection['GRP-SYRUP'], []);
  });

  test('a sold-out first option is skipped', () => {
    const group = {
      ...sizeGroup,
      modifiers: [
        { modifierId: 'MOD-SIZE-S', available: false },
        { modifierId: 'MOD-SIZE-M', available: true },
      ],
    };
    assert.deepEqual(defaultSelection([group])['GRP-SIZE'], ['MOD-SIZE-M']);
  });

  test('a group with nothing available selects nothing rather than an invalid option', () => {
    const group = { ...sizeGroup, modifiers: [{ modifierId: 'MOD-SIZE-S', available: false }] };
    assert.deepEqual(defaultSelection([group])['GRP-SIZE'], []);
  });

  test('a product with no groups needs no selection', () => {
    assert.deepEqual(defaultSelection([]), {});
  });
});

describe('kiosk UI: tapping a modifier', () => {
  const single = { groupId: 'GRP-SIZE', minSelect: 1, maxSelect: 1,
    modifiers: [{ modifierId: 'S', available: true }, { modifierId: 'M', available: true }] };
  const optionalSingle = { groupId: 'GRP-WARM', minSelect: 0, maxSelect: 1,
    modifiers: [{ modifierId: 'WARM', available: true }] };
  const multi = { groupId: 'GRP-SYRUP', minSelect: 0, maxSelect: 2,
    modifiers: [{ modifierId: 'VAN', available: true }, { modifierId: 'CAR', available: true }, { modifierId: 'HAZ', available: true }] };

  test('a single-choice group replaces rather than accumulates', () => {
    let selection = { 'GRP-SIZE': ['S'] };
    selection = toggleModifier(selection, single, 'M');
    assert.deepEqual(selection['GRP-SIZE'], ['M']);
  });

  test('a required single-choice group cannot be emptied by tapping again', () => {
    let selection = { 'GRP-SIZE': ['S'] };
    selection = toggleModifier(selection, single, 'S');
    assert.deepEqual(selection['GRP-SIZE'], ['S'], 'the item would otherwise become unorderable');
  });

  test('an optional single-choice group CAN be cleared', () => {
    let selection = { 'GRP-WARM': ['WARM'] };
    selection = toggleModifier(selection, optionalSingle, 'WARM');
    assert.deepEqual(selection['GRP-WARM'], []);
  });

  test('a multi-choice group accumulates up to its maximum', () => {
    let selection = { 'GRP-SYRUP': [] };
    selection = toggleModifier(selection, multi, 'VAN');
    selection = toggleModifier(selection, multi, 'CAR');
    assert.deepEqual(selection['GRP-SYRUP'], ['VAN', 'CAR']);
    // The third is refused rather than silently replacing one.
    selection = toggleModifier(selection, multi, 'HAZ');
    assert.deepEqual(selection['GRP-SYRUP'], ['VAN', 'CAR']);
  });

  test('a selected multi-choice option toggles off', () => {
    let selection = { 'GRP-SYRUP': ['VAN', 'CAR'] };
    selection = toggleModifier(selection, multi, 'VAN');
    assert.deepEqual(selection['GRP-SYRUP'], ['CAR']);
  });

  test('unmetGroups reports exactly what is still missing', () => {
    assert.equal(unmetGroups({ 'GRP-SIZE': [] }, [single]).length, 1);
    assert.equal(unmetGroups({ 'GRP-SIZE': ['S'] }, [single]).length, 0);
    assert.equal(unmetGroups({ 'GRP-SYRUP': [] }, [multi]).length, 0, 'optional groups are never unmet');
  });
});

describe('kiosk UI: unit price', () => {
  test('adds every selected delta to the base price', () => {
    const price = unitPriceMinor({ priceMinor: 1600 }, [
      { priceDeltaMinor: 600 }, { priceDeltaMinor: 250 }, { priceDeltaMinor: 200 },
    ]);
    assert.equal(price, 2650);
  });

  test('no selection leaves the base price', () => {
    assert.equal(unitPriceMinor({ priceMinor: 800 }, []), 800);
  });

  test('negative deltas can never drive a line below zero', () => {
    assert.equal(unitPriceMinor({ priceMinor: 500 }, [{ priceDeltaMinor: -900 }]), 0);
  });
});

describe('kiosk UI: the payload the UI actually sends', () => {
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

  test('a coffee and a pastry quote and order exactly as the screens build them', async () => {
    const menu = await http.get('/api/kiosk/menu');
    const latte = menu.body.products.find((p) => p.posProductId === 'PRD-1003');
    const croissant = menu.body.products.find((p) => p.posProductId === 'PRD-2001');
    assert.ok(latte && croissant, 'bakery must be on the kiosk menu');

    // Exactly what CustomizeDrink would produce for each.
    const latteSelection = Object.values(defaultSelection(latte.modifierGroups)).flat();
    const croissantSelection = Object.values(defaultSelection(croissant.modifierGroups)).flat();

    const quote = await http.post('/api/kiosk/quotes', {
      kioskId: 'kiosk-01',
      cart: {
        fulfillment: 'dine_in',
        lines: [
          { posProductId: latte.posProductId, quantity: 1, modifierIds: latteSelection },
          { posProductId: croissant.posProductId, quantity: 2, modifierIds: croissantSelection },
        ],
      },
    });
    assert.equal(quote.status, 201, JSON.stringify(quote.body));

    const q = quote.body.quote;
    assert.equal(q.currency, 'ILS');
    // Latte 16.00 (small, regular milk, no sugar add nothing) + 2 × croissant 8.00 + 2.00 dine-in
    assert.equal(q.itemsSubtotalMinor, 1600 + 1600);
    assert.equal(q.surchargeMinor, 200);
    assert.equal(q.totalMinor, 3400);
    assert.ok(q.vatIncludedMinor > 0, 'VAT must be reported');

    const order = await http.post('/api/kiosk/orders', {
      clientRequestId: 'ui-payload-test-01',
      quoteId: quote.body.quoteId,
      kioskId: 'kiosk-01',
    });
    assert.equal(order.status, 201);
    assert.equal(order.body.status, 'confirmed');

    // And it reaches the barista with the bakery item on it.
    const token = await http.managerToken();
    const queue = await http.get('/demo-pos/api/kitchen/queue', { token });
    const names = queue.body.orders[0].items.map((i) => i.nameEn);
    assert.ok(names.includes('Butter Croissant'), `bakery missing from kitchen: ${names}`);
  });

  test('the default selection always satisfies the POS, for every product', async () => {
    const menu = await http.get('/api/kiosk/menu');
    for (const product of menu.body.products) {
      const selection = Object.values(defaultSelection(product.modifierGroups)).flat();
      const quote = await http.post('/api/kiosk/quotes', {
        kioskId: 'kiosk-01',
        cart: { fulfillment: 'takeaway', lines: [{ posProductId: product.posProductId, quantity: 1, modifierIds: selection }] },
      });
      assert.equal(quote.status, 201,
        `${product.nameEn} could not be quoted with its default options: ${JSON.stringify(quote.body)}`);
    }
  });
});
