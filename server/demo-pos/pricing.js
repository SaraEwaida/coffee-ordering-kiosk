import {
  addMinor,
  multiplyMinor,
  percentOfMinor,
  clampDiscount,
  vatIncludedInGross,
  distributeProRata,
} from '../../shared/money.js';
import { PosRejectedError } from '../adapters/pos/PosAdapter.js';

/**
 * POS-side cart pricing.
 *
 * This is the authoritative total. The kiosk browser computes a display figure
 * for responsiveness, but THIS result is what gets charged — the kiosk
 * re-requests it from the POS and compares before payment. A tampered client
 * cannot set a price.
 *
 * Deliberately a pure function: it takes a catalog snapshot and a request and
 * returns a quote, with no database handle. That makes every pricing rule
 * unit-testable without fixtures, which matters because this is the one place
 * where a rounding mistake becomes a cash difference.
 *
 * All prices are VAT-INCLUSIVE. VAT is extracted from the gross, never added.
 */

const MAX_LINES = 30;
const MAX_QUANTITY_PER_LINE = 20;
const MAX_TOTAL_UNITS = 50;

/**
 * @param {object} args
 * @param {Map<string, {product: object, groups: Array}>} args.catalog
 * @param {object} args.config  { currency, defaultTaxRateBp, surcharge*, ... }
 * @param {object} args.request { fulfillment, tableNumber, promotionCode, lines }
 * @param {object|null} args.promotion  Validated promotion row, or null.
 */
export function priceCart({ catalog, config, request, promotion = null }) {
  const lines = Array.isArray(request?.lines) ? request.lines : null;
  if (!lines || lines.length === 0) {
    throw new PosRejectedError('An order needs at least one item.', { code: 'empty_cart' });
  }
  if (lines.length > MAX_LINES) {
    throw new PosRejectedError(`An order cannot have more than ${MAX_LINES} different items.`, {
      code: 'too_many_lines',
    });
  }
  if (!['dine_in', 'takeaway'].includes(request.fulfillment)) {
    throw new PosRejectedError('Order type must be dine_in or takeaway.', { code: 'invalid_fulfillment' });
  }

  const pricedLines = [];
  let totalUnits = 0;

  for (const [index, line] of lines.entries()) {
    const entry = catalog.get(line.posProductId);
    if (!entry) {
      // An ID the POS does not recognise is an integration fault, not a
      // customer error: it means the kiosk's mapping is stale or missing.
      throw new PosRejectedError(`Unknown product: ${line.posProductId}`, {
        code: 'unknown_product',
        details: { posProductId: line.posProductId, lineIndex: index },
      });
    }
    const { product, groups } = entry;
    if (!product.available) {
      throw new PosRejectedError(`${product.nameEn} is sold out.`, {
        code: 'item_unavailable',
        details: { posProductId: product.posProductId, nameEn: product.nameEn, nameAr: product.nameAr },
      });
    }

    const quantity = line.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
      throw new PosRejectedError(`Quantity must be a whole number from 1 to ${MAX_QUANTITY_PER_LINE}.`, {
        code: 'invalid_quantity',
        details: { lineIndex: index, quantity },
      });
    }
    totalUnits += quantity;

    const selectedIds = Array.isArray(line.modifierIds) ? line.modifierIds : [];
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new PosRejectedError('The same option was selected twice.', {
        code: 'duplicate_modifier',
        details: { lineIndex: index },
      });
    }

    const chosen = resolveModifiers({ product, groups, selectedIds, lineIndex: index });

    // A negative modifier total must never produce a negative line.
    const modifierTotal = chosen.reduce((sum, m) => sum + m.priceDeltaMinor, 0);
    const unitPriceMinor = Math.max(0, product.priceMinor + modifierTotal);
    const lineTotalMinor = multiplyMinor(unitPriceMinor, quantity);

    pricedLines.push({
      posProductId: product.posProductId,
      sku: product.sku,
      nameEn: product.nameEn,
      nameAr: product.nameAr,
      quantity,
      basePriceMinor: product.priceMinor,
      unitPriceMinor,
      lineTotalMinor,
      taxRateBp: product.taxRateBp,
      notes: typeof line.notes === 'string' ? line.notes.slice(0, 200) : '',
      modifiers: chosen,
    });
  }

  if (totalUnits > MAX_TOTAL_UNITS) {
    throw new PosRejectedError(`An order cannot exceed ${MAX_TOTAL_UNITS} items in total.`, {
      code: 'too_many_units',
      details: { totalUnits },
    });
  }

  const itemsSubtotalMinor = addMinor(...pricedLines.map((l) => l.lineTotalMinor));

  // ---- Discount ----------------------------------------------------------
  let discountMinor = 0;
  let appliedPromotionCode = null;
  if (promotion) {
    if (itemsSubtotalMinor < promotion.minSubtotalMinor) {
      throw new PosRejectedError('This promotion needs a larger order.', {
        code: 'promotion_minimum_not_met',
        details: { minSubtotalMinor: promotion.minSubtotalMinor },
      });
    }
    const raw = promotion.kind === 'percent'
      ? percentOfMinor(itemsSubtotalMinor, promotion.value)
      : promotion.value;
    discountMinor = clampDiscount(raw, itemsSubtotalMinor);
    appliedPromotionCode = promotion.code;
  }

  const discountedSubtotalMinor = itemsSubtotalMinor - discountMinor;

  // ---- Dine-in surcharge -------------------------------------------------
  // Store policy lives in POS config, so the POS is the one that decides the
  // figure. The kiosk displays it and cannot invent a charge the POS rejects.
  let surchargeMinor = 0;
  if (request.fulfillment === 'dine_in' && config.surchargeKind !== 'none') {
    surchargeMinor = config.surchargeKind === 'percent'
      ? percentOfMinor(discountedSubtotalMinor, config.surchargeValue)
      : config.surchargeValue;
  }

  const totalMinor = discountedSubtotalMinor + surchargeMinor;

  // ---- VAT contained in the total ---------------------------------------
  // A basket discount has to be attributed back to the lines it came off
  // before each line's VAT can be derived, or the VAT figure drifts from the
  // total. Pro-rata by line value, with exact remainder assignment.
  const lineWeights = pricedLines.map((l) => l.lineTotalMinor);
  const discountPerLine = distributeProRata(discountMinor, lineWeights);

  let vatIncludedMinor = 0;
  pricedLines.forEach((line, index) => {
    const netLineGross = line.lineTotalMinor - discountPerLine[index];
    const lineVat = vatIncludedInGross(netLineGross, line.taxRateBp);
    line.discountShareMinor = discountPerLine[index];
    line.vatIncludedMinor = lineVat;
    vatIncludedMinor += lineVat;
  });
  if (surchargeMinor > 0) {
    vatIncludedMinor += vatIncludedInGross(surchargeMinor, config.defaultTaxRateBp);
  }

  return {
    currency: config.currency,
    lines: pricedLines,
    itemsSubtotalMinor,
    discountMinor,
    promotionCode: appliedPromotionCode,
    surchargeMinor,
    surchargeLabelEn: config.surchargeLabelEn,
    surchargeLabelAr: config.surchargeLabelAr,
    totalMinor,
    vatIncludedMinor,
    taxNoteEn: 'All prices include VAT.',
    taxNoteAr: 'جميع الأسعار تشمل ضريبة القيمة المضافة.',
    fulfillment: request.fulfillment,
    tableNumber: request.tableNumber ?? null,
  };
}

/**
 * Validate the selected modifiers against the groups attached to the product,
 * enforcing min/max per group. Returns snapshot rows for the order record.
 */
function resolveModifiers({ product, groups, selectedIds, lineIndex }) {
  const byModifierId = new Map();
  for (const group of groups) {
    for (const modifier of group.modifiers) byModifierId.set(modifier.modifierId, { group, modifier });
  }

  const chosen = [];
  const countPerGroup = new Map();

  for (const modifierId of selectedIds) {
    const found = byModifierId.get(modifierId);
    if (!found) {
      throw new PosRejectedError('That option is not available for this item.', {
        code: 'invalid_modifier',
        details: { lineIndex, modifierId, posProductId: product.posProductId },
      });
    }
    if (!found.modifier.available) {
      throw new PosRejectedError(`${found.modifier.nameEn} is not available right now.`, {
        code: 'modifier_unavailable',
        details: { lineIndex, modifierId },
      });
    }
    countPerGroup.set(found.group.groupId, (countPerGroup.get(found.group.groupId) ?? 0) + 1);
    chosen.push({
      modifierId: found.modifier.modifierId,
      groupId: found.group.groupId,
      nameEn: found.modifier.nameEn,
      nameAr: found.modifier.nameAr,
      priceDeltaMinor: found.modifier.priceDeltaMinor,
    });
  }

  for (const group of groups) {
    const count = countPerGroup.get(group.groupId) ?? 0;
    if (count < group.minSelect) {
      throw new PosRejectedError(
        group.minSelect === 1
          ? `Please choose a ${group.nameEn.toLowerCase()}.`
          : `Please choose at least ${group.minSelect} from ${group.nameEn}.`,
        {
          code: 'modifier_min_not_met',
          details: { lineIndex, groupId: group.groupId, nameEn: group.nameEn, nameAr: group.nameAr, minSelect: group.minSelect, chosen: count },
        },
      );
    }
    if (count > group.maxSelect) {
      throw new PosRejectedError(`You can choose at most ${group.maxSelect} from ${group.nameEn}.`, {
        code: 'modifier_max_exceeded',
        details: { lineIndex, groupId: group.groupId, maxSelect: group.maxSelect, chosen: count },
      });
    }
  }

  // Stable order so an order record and its receipt always read the same.
  return chosen.sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : a.modifierId < b.modifierId ? -1 : 1));
}
