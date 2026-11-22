import React from 'react';
import { formatMinor } from '../config.js';

/**
 * The authoritative totals block.
 *
 * Every figure here comes from the POS quote. Nothing is summed in the browser,
 * which is why the dine-in surcharge and the VAT line can be trusted to match
 * the receipt.
 */
export default function QuoteSummary({ t, lang, currency, quote, quoting, quoteError }) {
  if (quoteError) {
    return <p className="summary-placeholder">{t.totalUnavailable}</p>;
  }
  if (!quote?.quote) {
    return <p className="summary-placeholder">{quoting ? t.calculating : t.calculating}</p>;
  }

  const q = quote.quote;
  const money = (minor) => formatMinor(minor, q.currency || currency, lang);

  return (
    <div className={quoting ? 'summary-lines summary-updating' : 'summary-lines'}>
      <div className="summary-line">
        <span>{t.subtotal}</span><strong>{money(q.itemsSubtotalMinor)}</strong>
      </div>

      {q.discountMinor > 0 && (
        <div className="summary-line summary-discount">
          <span>{t.discount}{q.promotionCode ? ` (${q.promotionCode})` : ''}</span>
          <strong>−{money(q.discountMinor)}</strong>
        </div>
      )}

      {/* A distinct, labelled line — never folded into item prices. */}
      {q.surchargeMinor > 0 && (
        <div className="summary-line">
          <span>{lang === 'ar' ? q.surchargeLabelAr : q.surchargeLabelEn}</span>
          <strong>{money(q.surchargeMinor)}</strong>
        </div>
      )}

      <div className="summary-total">
        <span>{t.total}</span><strong>{money(q.totalMinor)}</strong>
      </div>

      {/* VAT is contained in the total, never added to it. */}
      {q.vatIncludedMinor > 0 && (
        <p className="summary-vat">
          {t.vatOf.replace('{amount}', money(q.vatIncludedMinor))}
        </p>
      )}
    </div>
  );
}
