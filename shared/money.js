/**
 * Money handling for the kiosk.
 *
 * RULE: every monetary value crossing a module boundary or entering SQLite is an
 * INTEGER number of MINOR units (agorot for ILS, fils for JOD, cents for USD).
 * Floating-point money is a bug. The legacy prototype stored dollars as floats
 * (e.g. 4.25) and summed them with Math.round(x*100)/100, which drifts; nothing
 * in this module does that.
 *
 * VAT: store prices are VAT-INCLUSIVE. `price_minor` is the gross the customer
 * pays. The VAT contained inside that gross is derived, never added on top.
 */

/** Minor units per major unit, by ISO-4217 code. */
const MINOR_UNITS = Object.freeze({
  ILS: 100, // agorot
  JOD: 1000, // fils — three decimals
  USD: 100, // cents
  EUR: 100,
});

export const SUPPORTED_CURRENCIES = Object.freeze(Object.keys(MINOR_UNITS));

export function minorUnitsPer(currency) {
  const factor = MINOR_UNITS[currency];
  if (!factor) throw new MoneyError(`Unsupported currency: ${currency}`);
  return factor;
}

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Assert a value is a safe integer count of minor units. */
export function assertMinor(value, label = 'amount') {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer in minor units, received ${JSON.stringify(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} is outside the safe integer range`);
  }
  return value;
}

/** Add any number of minor-unit amounts. */
export function addMinor(...amounts) {
  return amounts.reduce((sum, amount, index) => sum + assertMinor(amount, `amount[${index}]`), 0);
}

/** Multiply a minor-unit amount by a non-negative integer quantity. */
export function multiplyMinor(amountMinor, quantity) {
  assertMinor(amountMinor, 'amountMinor');
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new MoneyError(`quantity must be a non-negative integer, received ${JSON.stringify(quantity)}`);
  }
  return amountMinor * quantity;
}

/**
 * Round half-up on a rational. Used for VAT extraction and percentage
 * discounts so results are deterministic and independent of float layout.
 * Both arguments are integers, so no float ever participates.
 */
export function divideRoundHalfUp(numerator, denominator) {
  assertMinor(numerator, 'numerator');
  if (!Number.isInteger(denominator) || denominator === 0) {
    throw new MoneyError('denominator must be a non-zero integer');
  }
  const negative = (numerator < 0) !== (denominator < 0);
  const absNumerator = Math.abs(numerator);
  const absDenominator = Math.abs(denominator);
  const quotient = Math.floor(absNumerator / absDenominator);
  const remainder = absNumerator - quotient * absDenominator;
  const rounded = remainder * 2 >= absDenominator ? quotient + 1 : quotient;
  return negative ? -rounded : rounded;
}

/**
 * VAT contained inside a VAT-INCLUSIVE gross amount.
 *
 *   included = gross * rate / (1 + rate)
 *
 * with the rate given in basis points (1600 bp = 16%). A zero rate yields zero;
 * this never increases the gross.
 */
export function vatIncludedInGross(grossMinor, taxRateBp) {
  assertMinor(grossMinor, 'grossMinor');
  if (!Number.isInteger(taxRateBp) || taxRateBp < 0 || taxRateBp > 100000) {
    throw new MoneyError(`taxRateBp must be an integer between 0 and 100000, received ${JSON.stringify(taxRateBp)}`);
  }
  if (taxRateBp === 0) return 0;
  return divideRoundHalfUp(grossMinor * taxRateBp, 10000 + taxRateBp);
}

/** Net (ex-VAT) portion of a VAT-inclusive gross amount. */
export function netOfGross(grossMinor, taxRateBp) {
  return assertMinor(grossMinor, 'grossMinor') - vatIncludedInGross(grossMinor, taxRateBp);
}

/** Apply a percentage in basis points, rounding half-up. */
export function percentOfMinor(amountMinor, percentBp) {
  assertMinor(amountMinor, 'amountMinor');
  if (!Number.isInteger(percentBp) || percentBp < 0) {
    throw new MoneyError(`percentBp must be a non-negative integer, received ${JSON.stringify(percentBp)}`);
  }
  return divideRoundHalfUp(amountMinor * percentBp, 10000);
}

/** Clamp a discount so it can never exceed what is owed or go negative. */
export function clampDiscount(discountMinor, subtotalMinor) {
  assertMinor(discountMinor, 'discountMinor');
  assertMinor(subtotalMinor, 'subtotalMinor');
  if (discountMinor <= 0) return 0;
  return Math.min(discountMinor, subtotalMinor);
}

/** Parse a human-entered major-unit string ("4.25") into minor units. */
export function parseMajorToMinor(input, currency) {
  const factor = minorUnitsPer(currency);
  const text = String(input).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new MoneyError(`Not a valid amount: ${JSON.stringify(input)}`);
  }
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const decimals = String(factor).length - 1;
  if (fraction.length > decimals) {
    throw new MoneyError(`${currency} supports at most ${decimals} decimal places`);
  }
  const padded = fraction.padEnd(decimals, '0');
  const minor = Number(whole) * factor + Number(padded || '0');
  if (!Number.isSafeInteger(minor)) throw new MoneyError('Amount too large');
  return negative ? -minor : minor;
}

/** Format minor units for display/logs. Locale formatting belongs in the UI. */
export function formatMinor(amountMinor, currency) {
  assertMinor(amountMinor, 'amountMinor');
  const factor = minorUnitsPer(currency);
  const decimals = String(factor).length - 1;
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const whole = Math.floor(abs / factor);
  const fraction = String(abs - whole * factor).padStart(decimals, '0');
  const body = decimals > 0 ? `${whole}.${fraction}` : String(whole);
  return `${negative ? '-' : ''}${body} ${currency}`;
}

/**
 * Split `totalMinor` across `weights` so the parts sum EXACTLY to the total.
 *
 * Needed for VAT on a basket discount: a percentage discount has to be
 * attributed back to the lines it came off before each line's VAT can be
 * derived, and naive per-line rounding loses or invents an agora. Largest
 * remainders receive the leftover units, which is the standard apportionment
 * rule and is deterministic for a given input order.
 *
 * @param {number} totalMinor  Integer minor units to distribute (>= 0).
 * @param {number[]} weights   Non-negative integers (typically line totals).
 * @returns {number[]} Parts, same length as weights, summing to totalMinor.
 */
export function distributeProRata(totalMinor, weights) {
  assertMinor(totalMinor, 'totalMinor');
  if (!Array.isArray(weights) || weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new MoneyError('weights must be an array of non-negative integers');
  }
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((a, b) => a + b, 0);

  // Nothing to weigh against: spread evenly, leftovers to the earliest slots.
  if (weightSum === 0) {
    const base = Math.trunc(totalMinor / weights.length);
    const parts = weights.map(() => base);
    let leftover = totalMinor - base * weights.length;
    for (let i = 0; leftover > 0; i = (i + 1) % weights.length, leftover -= 1) parts[i] += 1;
    return parts;
  }

  const parts = [];
  const remainders = [];
  let assigned = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const exactNumerator = totalMinor * weights[i];
    const floorPart = Math.floor(exactNumerator / weightSum);
    parts.push(floorPart);
    remainders.push({ index: i, remainder: exactNumerator - floorPart * weightSum });
    assigned += floorPart;
  }

  let leftover = totalMinor - assigned;
  // Stable: larger remainder first, then lower index, so output never depends
  // on the engine's sort implementation.
  remainders.sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index));
  for (let i = 0; leftover > 0 && i < remainders.length; i += 1, leftover -= 1) {
    parts[remainders[i].index] += 1;
  }
  return parts;
}
