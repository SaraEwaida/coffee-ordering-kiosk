import React, { useEffect, useRef, useState } from 'react';
import {
  CreditCard, Nfc, Loader2, CheckCircle2, XCircle, Clock,
  AlertTriangle, Banknote, Gift, ArrowLeft, ArrowRight,
} from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import { formatMinor, pickLang } from '../config.js';
import { api, ApiError } from '../api.js';

/**
 * The payment screen.
 *
 * Deliberately NOT a "choose Visa / choose cash" radio button. An unattended
 * terminal makes a customer wait, can decline, can time out, and can stop
 * answering — and every one of those has to look different on screen, because
 * what the customer should do next differs in each case.
 *
 * No card data is ever entered here, and none ever arrives. The browser starts
 * a payment, polls for an outcome, and shows a prompt. Card brands shown are
 * labelled as simulated: they are not real authorizations.
 */
const POLL_MS = 900;

export default function Payment({
  t, lang, currency, quote, clientRequestId, kioskId, storeName,
  onLanguage, onBack, onPaid, onCancelled,
}) {
  const [method, setMethod] = useState(null);     // null until the customer picks
  const [giftCode, setGiftCode] = useState('');
  const [giftInfo, setGiftInfo] = useState(null);
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const totalMinor = quote?.quote?.totalMinor ?? 0;

  // Poll while a payment is live. Stops as soon as it reaches a terminal state.
  useEffect(() => {
    if (!session?.paymentId || session.terminal || session.needsStaff) return undefined;
    pollRef.current = setInterval(async () => {
      try {
        const next = await api.paymentStatus(session.paymentId);
        setSession(next);
        if (next.state === 'approved' && next.order) {
          clearInterval(pollRef.current);
          onPaid(next.order, next);
        }
      } catch (err) {
        // A poll failure is not an outcome. Keep trying; the server is the
        // record of truth and the payment is durable there.
        setError(err instanceof ApiError ? err : new ApiError('offline'));
      }
    }, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [session, onPaid]);

  async function checkGiftCard() {
    const code = giftCode.trim().toUpperCase();
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const info = await api.giftCard(code);
      setGiftInfo(info.valid ? info : null);
      if (!info.valid) setError(new ApiError(t.giftCardNotFound, { code: 'gift_card_invalid' }));
    } catch (err) {
      setGiftInfo(null);
      setError(err instanceof ApiError ? err : new ApiError('offline'));
    } finally {
      setBusy(false);
    }
  }

  async function startCardPayment() {
    setBusy(true);
    setError(null);
    try {
      const started = await api.startPayment({
        quoteId: quote.quoteId,
        clientRequestId,
        kioskId,
        method: 'card_simulated',
        giftCardCode: giftInfo ? giftCode.trim().toUpperCase() : null,
      });
      setSession(started);
      if (started.state === 'approved' && started.order) onPaid(started.order, started);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('offline'));
    } finally {
      setBusy(false);
    }
  }

  async function payCash() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.payCash({ quoteId: quote.quoteId, clientRequestId, kioskId });
      onPaid(result, { method: 'cash_counter' });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('offline'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!session?.paymentId) return onCancelled();
    try {
      const cancelled = await api.cancelPayment(session.paymentId);
      setSession(cancelled);
    } catch (err) {
      // A terminal that has already committed refuses cancellation. That
      // refusal is correct and must be shown, not swallowed.
      setError(err instanceof ApiError ? err : new ApiError('offline'));
    }
  }

  const money = (minor) => formatMinor(minor, currency, lang);

  return (
    <div className="inner-screen">
      <TopBar {...{ t, lang, onLanguage, storeName }}
        onBack={session && !session.terminal ? undefined : onBack}
        section={t.paymentSection} />
      <main className="page-width payment-page">
        <div className="payment-amount">
          <span>{t.amountDue}</span>
          <strong>{money(totalMinor)}</strong>
          {quote?.quote?.vatIncludedMinor > 0 && (
            <small>{t.vatOf.replace('{amount}', money(quote.quote.vatIncludedMinor))}</small>
          )}
        </div>

        {/* ---- live payment ---- */}
        {session ? (
          <PaymentProgress {...{ t, lang, session, currency, money }}
            onCancel={cancel} onRetry={() => { setSession(null); setError(null); }}
            onDone={() => onCancelled()} />
        ) : (
          <div className="payment-methods">
            {error && (
              <div className="error-card inline-error">
                <p><AlertTriangle size={16} /> {error.message}</p>
              </div>
            )}

            {/* ---- gift card, optional, applied before the card leg ---- */}
            <section className="pay-section">
              <h3><Gift size={18} /> {t.giftCardTitle}</h3>
              <p className="muted-note">{t.giftCardHint}</p>
              <div className="gift-row">
                <input
                  value={giftCode}
                  onChange={(e) => { setGiftCode(e.target.value); setGiftInfo(null); }}
                  placeholder={t.giftCardPlaceholder}
                  aria-label={t.giftCardTitle}
                  autoComplete="off"
                  spellCheck="false"
                />
                <button className="outline-button" onClick={checkGiftCard} disabled={busy || !giftCode.trim()}>
                  {t.check}
                </button>
              </div>
              {giftInfo && (
                <p className="gift-applied">
                  <CheckCircle2 size={15} />
                  {t.giftCardApplied
                    .replace('{balance}', money(giftInfo.balanceMinor))
                    .replace('{applied}', money(Math.min(giftInfo.balanceMinor, totalMinor)))}
                  {giftInfo.balanceMinor < totalMinor && (
                    <> {t.giftCardRemainder.replace('{amount}', money(totalMinor - giftInfo.balanceMinor))}</>
                  )}
                </p>
              )}
            </section>

            <section className="pay-section">
              <h3>{t.choosePayment}</h3>
              <button className="pay-method-button" onClick={startCardPayment} disabled={busy}>
                <span className="pay-method-icon"><CreditCard size={26} /></span>
                <span className="pay-method-text">
                  <strong>{t.payByCard}</strong>
                  <small>{t.payByCardHint}</small>
                  {/* Labelled simulated, every time. */}
                  <span className="card-brands">{t.simulatedCards}</span>
                </span>
                {busy ? <Loader2 size={22} className="spin" /> : (lang === 'ar' ? <ArrowLeft size={22} /> : <ArrowRight size={22} />)}
              </button>

              <button className="pay-method-button" onClick={payCash} disabled={busy}>
                <span className="pay-method-icon"><Banknote size={26} /></span>
                <span className="pay-method-text">
                  <strong>{t.payCash}</strong>
                  <small>{t.payCashHint}</small>
                </span>
                {lang === 'ar' ? <ArrowLeft size={22} /> : <ArrowRight size={22} />}
              </button>
            </section>

            <p className="demo-hint">{t.noCardDataNote}</p>
          </div>
        )}
      </main>
    </div>
  );
}

/** What the customer sees once a payment is live. */
function PaymentProgress({ t, lang, session, money, onCancel, onRetry, onDone }) {
  const prompt = pickLang(lang, session.promptEn, session.promptAr);

  if (session.needsStaff) {
    // The terminal stopped answering. Nobody should guess whether this was
    // paid, so the screen stops and sends the customer to a person.
    return (
      <div className="payment-stage payment-stage-staff">
        <AlertTriangle size={64} />
        <h2>{t.paymentNeedsStaff}</h2>
        <p>{prompt}</p>
        {session.reference && (
          <p className="payment-reference">{t.reference}: <code>{session.reference}</code></p>
        )}
        <button className="outline-button" onClick={onDone}>{t.backToStart}</button>
      </div>
    );
  }

  if (session.state === 'approved') {
    return (
      <div className="payment-stage payment-stage-ok">
        <CheckCircle2 size={72} />
        <h2>{prompt}</h2>
        {session.maskedDetail && <p className="masked-card">{session.maskedDetail} <em>{t.simulatedTag}</em></p>}
        {session.giftAppliedMinor > 0 && (
          <p className="split-note">{t.giftPortion.replace('{amount}', money(session.giftAppliedMinor))}</p>
        )}
        <p className="pending-spinner"><Loader2 size={18} className="spin" /> {t.creatingOrder}</p>
      </div>
    );
  }

  if (['declined', 'failed', 'timed_out', 'cancelled'].includes(session.state)) {
    return (
      <div className="payment-stage payment-stage-bad">
        {session.state === 'timed_out' ? <Clock size={64} /> : <XCircle size={64} />}
        <h2>{prompt}</h2>
        <p className="muted-note">{t.noMoneyTaken}</p>
        <div className="payment-actions">
          <button className="primary-button" onClick={onRetry}>{t.tryAgain}</button>
          <button className="outline-button" onClick={onDone}>{t.backToStart}</button>
        </div>
      </div>
    );
  }

  // waiting_for_card / processing
  const waiting = session.state === 'waiting_for_card';
  return (
    <div className="payment-stage payment-stage-live">
      <div className={`reader-graphic ${waiting ? 'reader-waiting' : 'reader-processing'}`}>
        {waiting ? <Nfc size={78} /> : <Loader2 size={78} className="spin" />}
      </div>
      <h2>{prompt}</h2>
      {session.cardAmountMinor > 0 && session.giftAppliedMinor > 0 && (
        <p className="split-note">{t.cardPortion.replace('{amount}', money(session.cardAmountMinor))}</p>
      )}
      <p className="muted-note">{t.doNotLeave}</p>
      {session.cancellable && (
        <button className="outline-button" onClick={onCancel}>{t.cancelPayment}</button>
      )}
    </div>
  );
}
