import { minorUnitsPer } from '../shared/money.js';

/**
 * Kiosk display configuration.
 *
 * Nothing authoritative lives here any more. Currency, store name and the
 * surcharge all arrive from `GET /api/kiosk/config`, which gets them from the
 * POS. The old hardcoded `currency = 'USD'` is gone: a Palestine demo must not
 * show dollars because a constant said so.
 */

export const FALLBACK_BRAND = 'BEAN & BLOOM';

/**
 * Format an integer minor-unit amount for display.
 *
 * Takes minor units because that is what the API sends and what the server
 * charges; converting to a float for display is the only place a division
 * happens, and it never feeds back into a calculation.
 *
 * Arabic uses Latin digits (`-u-nu-latn`) deliberately: Palestinian price tags
 * and receipts overwhelmingly use them, and Arabic-Indic digits on a till
 * display invite misreading.
 */
export function formatMinor(amountMinor, currency = 'ILS', lang = 'en') {
  if (!Number.isFinite(amountMinor)) return '';
  const scale = safeScale(currency);
  const decimals = String(scale).length - 1;
  const locale = lang === 'ar' ? 'ar-PS-u-nu-latn' : 'en-GB';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amountMinor / scale);
  } catch {
    // An unknown currency code must not blank the price on a kiosk screen.
    return `${(amountMinor / scale).toFixed(decimals)} ${currency}`;
  }
}

function safeScale(currency) {
  try {
    return minorUnitsPer(currency);
  } catch {
    return 100;
  }
}

/** A signed delta, for modifier prices: "+₪2.50". */
export function formatDeltaMinor(amountMinor, currency = 'ILS', lang = 'en') {
  if (!amountMinor) return '';
  const sign = amountMinor > 0 ? '+' : '−';
  return `${sign}${formatMinor(Math.abs(amountMinor), currency, lang)}`;
}

export const pickLang = (lang, en, ar) => (lang === 'ar' ? (ar || en) : en);

/** Product name in the active language. */
export const productName = (product, lang) => pickLang(lang, product?.nameEn, product?.nameAr);

/** Product description, which may have come from a kiosk content overlay. */
export const productDescription = (product, lang) =>
  pickLang(lang, product?.descriptionEn, product?.descriptionAr);

/** One-line summary of chosen modifiers, for the cart and receipt. */
export function modifiersText(modifiers, lang) {
  if (!Array.isArray(modifiers) || modifiers.length === 0) return '';
  return modifiers.map((m) => pickLang(lang, m.nameEn, m.nameAr)).join(' · ');
}
