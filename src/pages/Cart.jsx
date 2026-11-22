import React from 'react';
import { ArrowRight, ArrowLeft, ShoppingBag, Trash2, AlertCircle } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import Stepper from '../components/Stepper.jsx';
import QuoteSummary from '../components/QuoteSummary.jsx';
import { productName, modifiersText, formatMinor } from '../config.js';

/**
 * The cart.
 *
 * Line prices shown here are the kiosk's own estimate so the screen stays
 * responsive while typing; the SUMMARY comes from the POS quote and is what
 * will actually be charged. If the two ever disagree, the quote is right.
 */
export default function Cart({
  t, lang, currency, cart, quote, quoting, quoteError,
  onLanguage, onBack, onCart, cartCount, onCheckout, onChangeQty, onRemove,
}) {
  return (
    <div className="inner-screen">
      <TopBar {...{ t, lang, onLanguage, onBack, onCart, cartCount }} section={t.cartSection} />
      <main className="page-width cart-page">
        <div className="page-heading simple-heading">
          <div><div className="eyebrow">✳ {t.summary}</div><h1>{t.cart}</h1></div>
        </div>

        {cart.length === 0 ? (
          <div className="empty-state">
            <ShoppingBag size={56} />
            <h2>{t.emptyCart}</h2>
            <p>{t.emptyCartSub}</p>
            <button className="primary-button" onClick={onBack}>{t.keepShopping}</button>
          </div>
        ) : (
          <div className="checkout-grid">
            <div className="cart-items">
              {cart.map((item) => (
                <div className="cart-item" key={item.key}>
                  {item.imageUrl
                    ? <img src={item.imageUrl} alt="" />
                    : <span className="cart-item-fallback" aria-hidden="true">
                        {productName(item, lang).slice(0, 2).toUpperCase()}
                      </span>}
                  <div className="cart-item-info">
                    <h3>{productName(item, lang)}</h3>
                    <p>{modifiersText(item.modifiers, lang) || t.noOptionsChosen}</p>
                    <button className="link-button" onClick={() => onRemove(item.key)}>
                      <Trash2 size={15} />{t.remove}
                    </button>
                  </div>
                  <div className="cart-item-end">
                    <strong>{formatMinor(item.unitPriceMinor * item.quantity, currency, lang)}</strong>
                    <Stepper compact value={item.quantity} min={1} max={20}
                      onChange={(v) => onChangeQty(item.key, v)} />
                  </div>
                </div>
              ))}
            </div>

            <aside className="summary-card">
              <h2>{t.summary}</h2>
              <QuoteSummary {...{ t, lang, currency, quote, quoting, quoteError }} />
              {quoteError && (
                <p className="field-error">
                  <AlertCircle size={15} />
                  {quoteError.code === 'item_unavailable' ? t.itemSoldOutFix : t.quoteFailed}
                </p>
              )}
              <button
                className="primary-button full-button"
                onClick={onCheckout}
                disabled={!quote || Boolean(quoteError)}
              >
                {t.checkout}
                <span className="button-arrow">
                  {lang === 'ar' ? <ArrowLeft size={22} /> : <ArrowRight size={22} />}
                </span>
              </button>
              <p className="demo-hint">{t.vatIncluded}</p>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
