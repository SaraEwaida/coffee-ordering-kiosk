import React from 'react';
import { ShoppingBag, Utensils, AlertCircle, Loader2 } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import QuoteSummary from '../components/QuoteSummary.jsx';
import { productName, modifiersText, formatMinor } from '../config.js';

/**
 * Checkout: confirm where you are eating, then place the order.
 *
 * There is no payment step yet — the payment simulator is Phase 3. This screen
 * says plainly that payment happens at the counter rather than implying a card
 * was charged.
 */
export default function Checkout({
  t, lang, currency, cart, quote, quoting, quoteError, config,
  fulfillment, onFulfillment, onLanguage, onBack, onCart, cartCount,
  onPlace, placing, error, onFixCart,
}) {
  const dineInEnabled = config?.dineInEnabled !== false;
  const surcharge = config?.surcharge;
  const canPlace = Boolean(quote) && !quoteError && !placing;

  return (
    <div className="inner-screen">
      <TopBar {...{ t, lang, onLanguage, onBack, onCart, cartCount }} section={t.checkoutSection} />
      <main className="page-width cart-page">
        <div className="page-heading simple-heading">
          <div><div className="eyebrow">✳ {t.details}</div><h1>{t.detailsSub}</h1></div>
        </div>

        <div className="checkout-grid">
          <div className="cart-items">
            {dineInEnabled && (
              <section className="custom-section">
                <h3>{t.orderType}</h3>
                <div className="choice-row fulfillment-row">
                  <button
                    type="button"
                    className={`choice-button ${fulfillment === 'takeaway' ? 'selected' : ''}`}
                    onClick={() => onFulfillment('takeaway')}
                  >
                    <span><ShoppingBag size={18} /> {t.takeaway}</span>
                  </button>
                  <button
                    type="button"
                    className={`choice-button ${fulfillment === 'dine_in' ? 'selected' : ''}`}
                    onClick={() => onFulfillment('dine_in')}
                  >
                    <span>
                      <Utensils size={18} /> {t.dineIn}
                      {surcharge?.kind === 'fixed' && surcharge.value > 0 && (
                        <small>+{formatMinor(surcharge.value, currency, lang)}</small>
                      )}
                      {surcharge?.kind === 'percent' && surcharge.value > 0 && (
                        <small>+{(surcharge.value / 100).toFixed(0)}%</small>
                      )}
                    </span>
                  </button>
                </div>
              </section>
            )}

            <section className="custom-section">
              <h3>{t.yourItems}</h3>
              {cart.map((item) => (
                <div className="review-line" key={item.key}>
                  <span className="review-qty">{item.quantity}×</span>
                  <span className="review-name">
                    {productName(item, lang)}
                    <small>{modifiersText(item.modifiers, lang)}</small>
                  </span>
                  <strong>{formatMinor(item.unitPriceMinor * item.quantity, currency, lang)}</strong>
                </div>
              ))}
            </section>
          </div>

          <aside className="summary-card">
            <h2>{t.summary}</h2>
            <QuoteSummary {...{ t, lang, currency, quote, quoting, quoteError }} />

            {error && (
              <div className="error-card inline-error">
                <p><AlertCircle size={16} /> {errorMessage(error, t)}</p>
                {/* A changed menu is the customer's cue to look again, not a
                    dead end. A stranded payment is a staff matter, so the
                    reference is shown prominently. */}
                {error.details?.reference && (
                  <p className="payment-reference">{t.reference}: <code>{error.details.reference}</code></p>
                )}
                {['menu_changed', 'conflict', 'item_unavailable', 'quote_mismatch'].includes(error.code) && (
                  <button className="outline-button" onClick={onFixCart}>{t.reviewOrder}</button>
                )}
              </div>
            )}

            <button className="primary-button full-button" onClick={onPlace} disabled={!canPlace}>
              {placing ? <><Loader2 size={20} className="spin" /> {t.processing}</> : t.placeOrder}
            </button>
            <p className="demo-hint">{t.payAtCounterNote}</p>
          </aside>
        </div>
      </main>
    </div>
  );
}

function errorMessage(error, t) {
  switch (error.code) {
    case 'menu_changed':
    case 'quote_mismatch':
      return t.errorMenuChanged;
    case 'item_unavailable':
      return t.errorItemUnavailable;
    case 'conflict':
      return t.errorQuoteUsed;
    case 'pos_unavailable':
    case 'network_unreachable':
      return t.errorPosOffline;
    case 'payment_taken_order_failed':
      return error.message;
    default:
      return error.message || t.orderError;
  }
}
