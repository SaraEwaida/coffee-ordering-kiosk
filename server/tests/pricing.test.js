import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestPlatform } from './helpers.js';
import { vatIncludedInGross } from '../../shared/money.js';

let platform;
let store;
before(() => {
  platform = makeTestPlatform();
  store = platform.store;
});
after(() => platform.close());

const line = (overrides = {}) => ({
  posProductId: 'PRD-1003',
  quantity: 1,
  modifierIds: ['MOD-SIZE-M', 'MOD-MILK-REG', 'MOD-SUG-0'],
  ...overrides,
});

describe('pricing: modifier arithmetic', () => {
  test('modifier deltas add onto the VAT-inclusive base price', () => {
    // Latte 16.00 + Large 6.00 + Oat 2.50 + Vanilla 2.00 = 26.50
    const quote = store.calculateQuote({
      fulfillment: 'takeaway',
      lines: [line({ modifierIds: ['MOD-SIZE-L', 'MOD-MILK-OAT', 'MOD-SYR-VAN', 'MOD-SUG-1'] })],
    });
    assert.equal(quote.lines[0].basePriceMinor, 1600);
    assert.equal(quote.lines[0].unitPriceMinor, 2650);
    assert.equal(quote.totalMinor, 2650);
  });

  test('quantity multiplies the unit price, not the base price', () => {
    const quote = store.calculateQuote({
      fulfillment: 'takeaway',
      lines: [line({ quantity: 3, modifierIds: ['MOD-SIZE-L', 'MOD-MILK-REG', 'MOD-SUG-0'] })],
    });
    assert.equal(quote.lines[0].unitPriceMinor, 2200);
    assert.equal(quote.lines[0].lineTotalMinor, 6600);
  });

  test('a free modifier changes nothing', () => {
    const base = store.calculateQuote({ fulfillment: 'takeaway', lines: [line()] });
    const withCinnamon = store.calculateQuote({
      fulfillment: 'takeaway',
      lines: [line({ modifierIds: ['MOD-SIZE-M', 'MOD-MILK-REG', 'MOD-SUG-0', 'MOD-EXT-CINN'] })],
    });
    assert.equal(base.totalMinor, withCinnamon.totalMinor);
  });
});

describe('pricing: modifier group rules', () => {
  test('a required group must be satisfied', () => {
    assert.throws(
      () => store.calculateQuote({ fulfillment: 'takeaway', lines: [line({ modifierIds: ['MOD-MILK-REG', 'MOD-SUG-0'] })] }),
      (error) => error.code === 'modifier_min_not_met',
    );
  });

  test('max selections per group is enforced', () => {
    assert.throws(
      () => store.calculateQuote({
        fulfillment: 'takeaway',
        lines: [line({ modifierIds: ['MOD-SIZE-M', 'MOD-MILK-REG', 'MOD-SUG-0', 'MOD-SYR-VAN', 'MOD-SYR-CAR', 'MOD-SYR-HAZ'] })],
      }),
      (error) => error.code === 'modifier_max_exceeded',
    );
  });

  test('two syrups are allowed, since max is two', () => {
    const quote = store.calculateQuote({
      fulfillment: 'takeaway',
      lines: [line({ modifierIds: ['MOD-SIZE-M', 'MOD-MILK-REG', 'MOD-SUG-0', 'MOD-SYR-VAN', 'MOD-SYR-CAR'] })],
    });
    assert.equal(quote.lines[0].unitPriceMinor, 1600 + 300 + 400);
  });

  test('an optional group may be skipped entirely', () => {
    const quote = store.calculateQuote({ fulfillment: 'takeaway', lines: [line()] });
    assert.equal(quote.lines[0].unitPriceMinor, 1900);
  });

  test('a modifier from a group not attached to the product is refused', () => {
    // Espresso has no milk group at all.
    assert.throws(
      () => store.calculateQuote({
        fulfillment: 'takeaway',
        lines: [{ posProductId: 'PRD-1001', quantity: 1, modifierIds: ['MOD-SIZE-S', 'MOD-SUG-0', 'MOD-MILK-OAT'] }],
      }),
      (error) => error.code === 'invalid_modifier',
    );
  });

  test('the same modifier cannot be selected twice', () => {
    assert.throws(
      () => store.calculateQuote({
        fulfillment: 'takeaway',
        lines: [line({ modifierIds: ['MOD-SIZE-M', 'MOD-SIZE-M', 'MOD-MILK-REG', 'MOD-SUG-0'] })],
      }),
      (error) => error.code === 'duplicate_modifier',
    );
  });

  test('an unavailable modifier is refused', () => {
    store.updateModifier('MOD-MILK-OAT', { available: false }, { type: 'manager', id: 'test' });
    assert.throws(
      () => store.calculateQuote({
        fulfillment: 'takeaway',
        lines: [line({ modifierIds: ['MOD-SIZE-M', 'MOD-MILK-OAT', 'MOD-SUG-0'] })],
      }),
      (error) => error.code === 'modifier_unavailable',
    );
    store.updateModifier('MOD-MILK-OAT', { available: true }, { type: 'manager', id: 'test' });
  });
});

describe('pricing: availability', () => {
  test('a sold-out product cannot be priced', () => {
    store.updateProduct('PRD-1003', { available: false }, { type: 'manager', id: 'test' });
    assert.throws(
      () => store.calculateQuote({ fulfillment: 'takeaway', lines: [line()] }),
      (error) => error.code === 'item_unavailable',
    );
    store.updateProduct('PRD-1003', { available: true }, { type: 'manager', id: 'test' });
  });

  test('an unknown product ID is refused, never guessed', () => {
    assert.throws(
      () => store.calculateQuote({ fulfillment: 'takeaway', lines: [line({ posProductId: 'latte' })] }),
      (error) => error.code === 'unknown_product',
    );
  });
});

describe('pricing: limits', () => {
  test('an empty cart is refused', () => {
    assert.throws(
      () => store.calculateQuote({ fulfillment: 'takeaway', lines: [] }),
      (error) => error.code === 'empty_cart',
    );
  });

  test('quantity bounds are enforced', () => {
    for (const quantity of [0, -1, 21, 1.5]) {
      assert.throws(
        () => store.calculateQuote({ fulfillment: 'takeaway', lines: [line({ quantity })] }),
        (error) => error.code === 'invalid_quantity',
        `quantity ${quantity} should be refused`,
      );
    }
  });

  test('total unit count is capped', () => {
    assert.throws(
      () => store.calculateQuote({
        fulfillment: 'takeaway',
        lines: [line({ quantity: 20 }), line({ quantity: 20 }), line({ quantity: 20 })],
      }),
      (error) => error.code === 'too_many_units',
    );
  });

  test('an invalid fulfillment type is refused', () => {
    assert.throws(
      () => store.calculateQuote({ fulfillment: 'delivery', lines: [line()] }),
      (error) => error.code === 'invalid_fulfillment',
    );
  });
});

describe('pricing: dine-in surcharge', () => {
  test('applied for dine-in only', () => {
    const takeaway = store.calculateQuote({ fulfillment: 'takeaway', lines: [line()] });
    const dineIn = store.calculateQuote({ fulfillment: 'dine_in', lines: [line()] });
    assert.equal(takeaway.surchargeMinor, 0);
    assert.equal(dineIn.surchargeMinor, 200);
    assert.equal(dineIn.totalMinor, takeaway.totalMinor + 200);
  });

  test('surcharge is a separate line, not folded into item prices', () => {
    const dineIn = store.calculateQuote({ fulfillment: 'dine_in', lines: [line()] });
    assert.equal(dineIn.itemsSubtotalMinor, 1900);
    assert.equal(dineIn.surchargeMinor, 200);
    assert.ok(dineIn.surchargeLabelEn.length > 0 && dineIn.surchargeLabelAr.length > 0);
  });

  test('a percentage surcharge is computed after the discount', () => {
    store.setConfig('dine_in_surcharge_kind', 'percent', { type: 'manager', id: 'test' });
    store.setConfig('dine_in_surcharge_value', '1000', { type: 'manager', id: 'test' });
    const quote = store.calculateQuote({ fulfillment: 'dine_in', promotionCode: 'WELCOME10', lines: [line()] });
    // 19.00 - 1.90 = 17.10, then 10% of 17.10 = 1.71
    assert.equal(quote.discountMinor, 190);
    assert.equal(quote.surchargeMinor, 171);
    assert.equal(quote.totalMinor, 1900 - 190 + 171);
    store.setConfig('dine_in_surcharge_kind', 'fixed', { type: 'manager', id: 'test' });
    store.setConfig('dine_in_surcharge_value', '200', { type: 'manager', id: 'test' });
  });
});

describe('pricing: promotions', () => {
  test('a percentage promotion discounts the subtotal', () => {
    const quote = store.calculateQuote({ fulfillment: 'takeaway', promotionCode: 'WELCOME10', lines: [line()] });
    assert.equal(quote.discountMinor, 190);
    assert.equal(quote.totalMinor, 1710);
    assert.equal(quote.promotionCode, 'WELCOME10');
  });

  test('a fixed promotion below its minimum is refused', () => {
    assert.throws(
      () => store.calculateQuote({
        fulfillment: 'takeaway', promotionCode: 'BLOOM5',
        lines: [{ posProductId: 'PRD-3001', quantity: 1, modifierIds: [] }], // 6.00, below 20.00
      }),
      (error) => error.code === 'promotion_minimum_not_met',
    );
  });

  test('an unknown promotion code is refused, not ignored', () => {
    assert.throws(
      () => store.calculateQuote({ fulfillment: 'takeaway', promotionCode: 'NOPE', lines: [line()] }),
      (error) => error.code === 'promotion_invalid',
    );
  });

  test('a promotion code is matched case-insensitively', () => {
    const quote = store.calculateQuote({ fulfillment: 'takeaway', promotionCode: 'welcome10', lines: [line()] });
    assert.equal(quote.discountMinor, 190);
  });
});

describe('pricing: VAT reconciliation', () => {
  test('VAT reported equals VAT contained in the final total', () => {
    const quote = store.calculateQuote({
      fulfillment: 'dine_in',
      lines: [line({ quantity: 2, modifierIds: ['MOD-SIZE-L', 'MOD-MILK-OAT', 'MOD-SYR-VAN', 'MOD-SUG-1'] }),
        { posProductId: 'PRD-2001', quantity: 1, modifierIds: ['MOD-WARM-YES'] }],
    });
    assert.equal(quote.totalMinor, 6300);
    assert.equal(quote.vatIncludedMinor, vatIncludedInGross(6300, 1600));
  });

  test('VAT never exceeds the total, with or without a discount', () => {
    for (const promotionCode of [null, 'WELCOME10']) {
      for (const fulfillment of ['takeaway', 'dine_in']) {
        const quote = store.calculateQuote({ fulfillment, promotionCode, lines: [line({ quantity: 2 })] });
        assert.ok(quote.vatIncludedMinor <= quote.totalMinor);
        assert.ok(quote.vatIncludedMinor >= 0);
      }
    }
  });

  test('per-line discount shares sum to the basket discount exactly', () => {
    const quote = store.calculateQuote({
      fulfillment: 'takeaway', promotionCode: 'WELCOME10',
      lines: [line(), { posProductId: 'PRD-2001', quantity: 1, modifierIds: [] },
        { posProductId: 'PRD-3001', quantity: 1, modifierIds: [] }],
    });
    const shares = quote.lines.reduce((sum, l) => sum + l.discountShareMinor, 0);
    assert.equal(shares, quote.discountMinor);
  });

  test('prices are stated as VAT-inclusive in both languages', () => {
    const quote = store.calculateQuote({ fulfillment: 'takeaway', lines: [line()] });
    assert.match(quote.taxNoteEn, /include/i);
    assert.ok(quote.taxNoteAr.length > 0);
  });
});
