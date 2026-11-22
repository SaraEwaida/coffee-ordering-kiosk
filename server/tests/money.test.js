import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMinor, multiplyMinor, divideRoundHalfUp, vatIncludedInGross, netOfGross,
  percentOfMinor, clampDiscount, parseMajorToMinor, formatMinor,
  distributeProRata, assertMinor, MoneyError,
} from '../../shared/money.js';

describe('money: integer discipline', () => {
  test('rejects floats, NaN and non-numbers', () => {
    for (const bad of [4.25, NaN, Infinity, '100', null, undefined, {}]) {
      assert.throws(() => assertMinor(bad), MoneyError, `should reject ${String(bad)}`);
    }
  });

  test('rejects values beyond safe integer range', () => {
    assert.throws(() => assertMinor(Number.MAX_SAFE_INTEGER + 2), MoneyError);
  });

  test('addMinor and multiplyMinor stay exact where floats would drift', () => {
    // 0.1 + 0.2 !== 0.3 in floating point; in agorot it is simply 10 + 20.
    assert.equal(addMinor(10, 20), 30);
    // Summing 4.25 one hundred times as a float accumulates error.
    assert.equal(addMinor(...Array(100).fill(425)), 42500);
    assert.equal(multiplyMinor(425, 100), 42500);
  });

  test('multiplyMinor rejects a negative or fractional quantity', () => {
    assert.throws(() => multiplyMinor(425, -1), MoneyError);
    assert.throws(() => multiplyMinor(425, 1.5), MoneyError);
  });
});

describe('money: rounding', () => {
  test('divideRoundHalfUp rounds halves away from zero', () => {
    assert.equal(divideRoundHalfUp(5, 2), 3);
    assert.equal(divideRoundHalfUp(4, 2), 2);
    assert.equal(divideRoundHalfUp(1, 2), 1);
    assert.equal(divideRoundHalfUp(-5, 2), -3);
    assert.equal(divideRoundHalfUp(0, 7), 0);
  });

  test('rejects a zero denominator', () => {
    assert.throws(() => divideRoundHalfUp(1, 0), MoneyError);
  });
});

describe('money: VAT is extracted, never added', () => {
  test('16% VAT inside a gross amount', () => {
    // 11.60 gross at 16% = 10.00 net + 1.60 VAT.
    assert.equal(vatIncludedInGross(1160, 1600), 160);
    assert.equal(netOfGross(1160, 1600), 1000);
  });

  test('net plus VAT always reconstitutes the gross exactly', () => {
    for (let gross = 0; gross <= 3000; gross += 7) {
      const vat = vatIncludedInGross(gross, 1600);
      assert.equal(netOfGross(gross, 1600) + vat, gross, `failed at gross=${gross}`);
      assert.ok(vat <= gross, 'VAT can never exceed the gross');
    }
  });

  test('a zero rate yields zero VAT and never inflates the total', () => {
    assert.equal(vatIncludedInGross(1600, 0), 0);
    assert.equal(netOfGross(1600, 0), 1600);
  });

  test('rejects an out-of-range tax rate', () => {
    assert.throws(() => vatIncludedInGross(100, -1), MoneyError);
    assert.throws(() => vatIncludedInGross(100, 1.5), MoneyError);
  });
});

describe('money: discounts', () => {
  test('percentage uses basis points', () => {
    assert.equal(percentOfMinor(1000, 1000), 100); // 10%
    assert.equal(percentOfMinor(1155, 1000), 116); // rounds half-up
  });

  test('a discount can never exceed the subtotal or go negative', () => {
    assert.equal(clampDiscount(5000, 1900), 1900);
    assert.equal(clampDiscount(-100, 1900), 0);
    assert.equal(clampDiscount(500, 1900), 500);
  });
});

describe('money: parsing and formatting', () => {
  test('parses decimal strings exactly, by currency scale', () => {
    assert.equal(parseMajorToMinor('4.25', 'ILS'), 425);
    assert.equal(parseMajorToMinor('15.05', 'ILS'), 1505);
    assert.equal(parseMajorToMinor('18', 'ILS'), 1800);
    assert.equal(parseMajorToMinor('4.250', 'JOD'), 4250); // three decimals
  });

  test('refuses more precision than the currency has', () => {
    assert.throws(() => parseMajorToMinor('4.255', 'ILS'), MoneyError);
  });

  test('refuses junk rather than coercing it', () => {
    for (const bad of ['', 'abc', '4.2.5', '4,25', '1e3', ' ']) {
      assert.throws(() => parseMajorToMinor(bad, 'ILS'), MoneyError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('formats by currency scale', () => {
    assert.equal(formatMinor(1160, 'ILS'), '11.60 ILS');
    assert.equal(formatMinor(4250, 'JOD'), '4.250 JOD');
    assert.equal(formatMinor(-500, 'ILS'), '-5.00 ILS');
    assert.equal(formatMinor(5, 'ILS'), '0.05 ILS');
  });

  test('an unsupported currency is an error, not a guess', () => {
    assert.throws(() => parseMajorToMinor('1.00', 'XYZ'), MoneyError);
  });
});

describe('money: pro-rata distribution', () => {
  test('parts always sum exactly to the total', () => {
    const cases = [
      [100, [1, 1, 1]], [10, [425, 475, 525]], [7, [1, 1]], [0, [5, 5]],
      [5, [0, 0]], [333, [1000, 1, 1]], [1, [1, 1, 1, 1]], [999, [3, 3, 3]],
    ];
    for (const [total, weights] of cases) {
      const parts = distributeProRata(total, weights);
      assert.equal(parts.length, weights.length);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `total=${total} weights=${weights}`);
      assert.ok(parts.every((p) => p >= 0), 'no negative parts');
    }
  });

  test('is deterministic for the same input', () => {
    const a = distributeProRata(10, [425, 475, 525]);
    const b = distributeProRata(10, [425, 475, 525]);
    assert.deepEqual(a, b);
  });

  test('larger weights receive no less than smaller ones', () => {
    const parts = distributeProRata(100, [1000, 500, 100]);
    assert.ok(parts[0] >= parts[1] && parts[1] >= parts[2]);
  });

  test('rejects negative or fractional weights', () => {
    assert.throws(() => distributeProRata(10, [-1, 2]), MoneyError);
    assert.throws(() => distributeProRata(10, [1.5, 2]), MoneyError);
  });

  test('an empty weight list yields an empty result', () => {
    assert.deepEqual(distributeProRata(0, []), []);
  });
});
