import React, { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api.js';
import { formatMinor } from '../config.js';

/**
 * Order confirmation.
 *
 * Two distinct outcomes, kept visually distinct because they mean different
 * things to the customer:
 *
 *   confirmed — the till has the order; here is your number.
 *   pending   — we have saved it but the till has not confirmed. This must NOT
 *               look like success, because it is not one yet.
 */
export default function Confirmation({ t, lang, currency, order, onNew }) {
  const confirmed = order.status === 'confirmed';
  const [live, setLive] = useState(order);

  // While pending, keep checking: the retry queue usually resolves it within
  // seconds, and the customer should see that happen rather than walk away.
  useEffect(() => {
    if (confirmed || !order.clientRequestId) return undefined;
    const interval = setInterval(async () => {
      try {
        const status = await api.orderByRequest(order.clientRequestId);
        if (status.status === 'confirmed') {
          setLive({ ...order, ...status, status: 'confirmed' });
          clearInterval(interval);
        }
      } catch {
        // Keep waiting; the next tick tries again.
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [confirmed, order]);

  const isConfirmed = live.status === 'confirmed';
  const total = live.order?.totalMinor ?? order.order?.totalMinor;

  // The receipt URL is built by the server from a LAN-reachable address. If it
  // could not work one out it sends null, and we show no QR rather than a code
  // pointing at localhost — which would scan fine and then fail on the phone.
  const receiptUrl = live.receiptUrl ?? order.receiptUrl ?? null;

  return (
    <div className="inner-screen">
      <main className="page-width confirm-page">
        <div className={`confirm-card ${isConfirmed ? '' : 'confirm-pending'}`}>
          {isConfirmed ? <CheckCircle2 size={64} /> : <Clock size={64} />}

          <h1>{isConfirmed ? t.success : t.orderPendingTitle}</h1>
          <p>{isConfirmed ? t.successSub : (live.message || t.orderPendingSub)}</p>

          {isConfirmed && live.posOrderNumber && (
            <div className="order-number-block">
              <span>{t.number}</span>
              <strong>{live.posOrderNumber}</strong>
            </div>
          )}

          {!isConfirmed && (
            <>
              <p className="pending-spinner"><Loader2 size={18} className="spin" /> {t.stillConfirming}</p>
              {live.paymentAccepted && live.clientRequestId && (
                <p className="payment-reference">{t.reference}: <code>{live.clientRequestId}</code></p>
              )}
            </>
          )}

          {total != null && (
            <p className="confirm-total">{t.total}: <strong>{formatMinor(total, currency, lang)}</strong></p>
          )}

          {isConfirmed && receiptUrl && (
            <div className="receipt-qr">
              <QRCodeSVG
                value={receiptUrl}
                size={148}
                level="M"
                marginSize={2}
                title={t.receiptQrTitle}
              />
              <p>{t.receiptQrHint}</p>
            </div>
          )}

          <p className="demo-hint">{t.payAtCounterNote}</p>
          <button className="primary-button" onClick={onNew}>{t.newOrder}</button>
        </div>
      </main>
    </div>
  );
}
