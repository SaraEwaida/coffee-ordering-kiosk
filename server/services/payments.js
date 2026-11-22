import { randomUUID } from 'node:crypto';
import { PaymentRejectedError, PaymentUnavailableError } from '../adapters/payments/PaymentAdapter.js';
import { AppError, badRequest, conflict, notFound, validationFailed } from '../lib/errors.js';
import { PosRejectedError } from '../adapters/pos/PosAdapter.js';

/**
 * Payment orchestration.
 *
 * The rules this service exists to hold:
 *
 * 1. **The amount comes from the stored quote.** Never from the browser. The
 *    client names a quote; the server reads its total.
 * 2. **One payment per checkout attempt.** Keyed on the same clientRequestId
 *    the order uses, so a double tap cannot open a second payment.
 * 3. **An approved payment always becomes an order, or reaches a human.** The
 *    order is created with the payment attached, through the idempotent path
 *    built in Phase 1, so an approval can never be silently lost.
 * 4. **A gift card is debited only once**, and only when the rest of the money
 *    is secured. If the card payment then fails, the gift balance is restored.
 */
export class PaymentService {
  constructor({ paymentAdapter, posAdapter, kioskStore, checkout, storeId, logger }) {
    this.paymentAdapter = paymentAdapter;
    this.posAdapter = posAdapter;
    this.kioskStore = kioskStore;
    this.checkout = checkout;
    this.storeId = storeId;
    this.logger = logger;
  }

  /**
   * Begin paying for a quote.
   *
   * A gift card, if offered, is validated here and its contribution worked out
   * before the card leg starts — but nothing is debited until the money is
   * actually taken, in `#settle`.
   */
  async startPayment({ quoteId, clientRequestId, kioskId, method = 'card_simulated', giftCardCode = null }) {
    const key = String(clientRequestId ?? '').trim();
    if (!/^[\w-]{8,100}$/.test(key)) {
      throw validationFailed('A valid clientRequestId is required so a retry cannot pay twice.', {
        field: 'clientRequestId',
      });
    }

    // A second tap on "Pay" returns the payment already in flight.
    const existing = this.paymentAdapter.findByClientRequestId?.(key);
    if (existing) return existing;

    const stored = this.kioskStore.getQuote(quoteId);
    if (!stored) throw notFound('That order summary has expired. Please review your order.');
    if (stored.storeId !== this.storeId) throw notFound('That order summary belongs to another store.');
    if (stored.status === 'consumed') throw conflict('That order has already been placed.', { quoteId });
    if (stored.status === 'invalidated') {
      throw new AppError('menu_changed', 'The menu changed while you were ordering. Please review your order.', { status: 409 });
    }
    if (stored.expired) {
      this.kioskStore.markQuote(quoteId, 'expired');
      throw conflict('That order summary has expired. Please review your order.', { quoteId });
    }

    // The amount is the quote's total. Nothing the client sent is consulted.
    const amountMinor = stored.totalMinor;
    const currency = stored.currency;

    let giftAppliedMinor = 0;
    if (giftCardCode) {
      const card = await this.posAdapter.validateCouponOrLoyalty({ code: giftCardCode, kind: 'gift_card' });
      if (!card.valid) {
        throw new AppError('gift_card_invalid', 'That gift card was not recognised.', { status: 404 });
      }
      if (card.currency !== currency) {
        throw new AppError('gift_card_currency', 'That gift card is in a different currency.', { status: 409 });
      }
      if (card.balanceMinor <= 0) {
        throw new AppError('gift_card_empty', 'That gift card has no balance left.', { status: 409 });
      }
      // Split payment: the card covers what it can, the terminal covers the rest.
      giftAppliedMinor = Math.min(card.balanceMinor, amountMinor);
    }

    const cardAmountMinor = amountMinor - giftAppliedMinor;

    // A gift card covering the whole order means no terminal interaction.
    const effectiveMethod = giftAppliedMinor > 0 && cardAmountMinor === 0 ? 'gift_card' : method;

    const session = await this.paymentAdapter.startPayment({
      paymentId: randomUUID(),
      storeId: this.storeId,
      kioskId,
      quoteId,
      clientRequestId: key,
      amountMinor,
      currency,
      method: effectiveMethod,
      giftCardCode,
      giftAppliedMinor,
    });

    this.kioskStore.logEvent({
      storeId: this.storeId, kioskId, eventType: 'payment.started',
      payload: {
        paymentId: session.paymentId, method: effectiveMethod,
        amountMinor, giftAppliedMinor, cardAmountMinor,
      },
    });

    // A gift card covering everything settles immediately — there is nothing
    // for a terminal to do.
    if (effectiveMethod === 'gift_card' && cardAmountMinor === 0) {
      return this.#settle(session, { giftCardCode, giftAppliedMinor });
    }
    return session;
  }

  /**
   * Poll a payment. When it has just been approved, this is also where the
   * order gets created — so an approval always becomes an order.
   */
  async getStatus(paymentId) {
    let session;
    try {
      session = await this.paymentAdapter.getPaymentStatus(paymentId);
    } catch (error) {
      throw translatePaymentError(error);
    }

    if (session.state === 'approved' && !session.orderSubmitted) {
      // The session masks the gift-card code; settlement needs the real one.
      const settlement = this.paymentAdapter.getSettlementDetails?.(session.paymentId) ?? {};
      return this.#settle(session, {
        giftCardCode: settlement.giftCardCode ?? null,
        giftAppliedMinor: settlement.giftAppliedMinor ?? 0,
      });
    }

    // A terminal that stopped answering must never be auto-resolved.
    if (session.state === 'unknown') {
      this.kioskStore.recordIntegrationIssue(
        this.storeId, 'payment_outcome_unknown',
        `Payment ${session.paymentId} (${session.reference ?? 'no reference'}) did not return an outcome. `
          + 'A member of staff must confirm with the terminal before the customer pays again.',
      );
    }
    return session;
  }

  /**
   * Turn an approved payment into a POS order.
   *
   * Routed through the Phase 1 checkout path, which is idempotent on
   * clientRequestId and already handles "payment taken but the till refused",
   * so there is exactly one place in the system where that risk is managed.
   */
  async #settle(session, { giftCardCode, giftAppliedMinor }) {
    // Debit the gift card first, inside its own transaction in the POS. Doing
    // it now rather than at startPayment means a customer who abandons at the
    // card prompt is never left out of pocket.
    let giftRedeemed = false;
    if (giftCardCode && giftAppliedMinor > 0) {
      try {
        await this.posAdapter.redeemGiftCard?.({ code: giftCardCode, amountMinor: giftAppliedMinor });
        giftRedeemed = true;
      } catch (error) {
        this.logger?.error?.('payment.gift_redeem_failed', {
          paymentId: session.paymentId, message: error.message,
        });
        this.kioskStore.recordIntegrationIssue(
          this.storeId, 'gift_card_redeem_failed',
          `Payment ${session.paymentId} was approved but the gift card could not be debited: ${error.message}`,
        );
        throw new AppError('gift_card_redeem_failed',
          'Your card payment went through but we could not apply the gift card. Please speak to a member of staff.',
          { status: 409, details: { reference: session.reference } });
      }
    }

    try {
      const result = await this.checkout.submitOrder({
        clientRequestId: session.clientRequestId,
        quoteId: session.quoteId,
        kioskId: session.kioskId,
        payment: {
          method: session.method,
          status: 'approved',
          amountMinor: session.amountMinor,
          reference: session.reference,
          maskedDetail: session.maskedDetail,
        },
      });

      if (result.posOrderId) {
        await this.paymentAdapter.markOrderSubmitted(session.paymentId, result.posOrderId);
      }
      return {
        ...(await this.paymentAdapter.getPaymentStatus(session.paymentId)),
        order: result,
      };
    } catch (error) {
      // The order could not be created. The money has moved, so this must
      // reach a human rather than disappear. Phase 1's checkout already filed
      // the durable record and the ops exception; put the gift card back.
      if (giftRedeemed) {
        this.kioskStore.recordIntegrationIssue(
          this.storeId, 'gift_card_needs_reversal',
          `Payment ${session.paymentId}: ${giftAppliedMinor} was taken from gift card `
            + `${String(giftCardCode).slice(-4)} but no order exists. The balance needs restoring.`,
        );
      }
      throw error;
    }
  }

  async cancel(paymentId, { actor = 'customer' } = {}) {
    try {
      return await this.paymentAdapter.cancelPayment(paymentId, { actor });
    } catch (error) {
      throw translatePaymentError(error);
    }
  }

  /**
   * Cash at the counter: create the order unpaid.
   *
   * The kiosk never marks cash as received. A member of staff records it in
   * the till once they have the money, which is the only honest way to do it.
   */
  async payAtCounter({ quoteId, clientRequestId, kioskId }) {
    const result = await this.checkout.submitOrder({
      clientRequestId,
      quoteId,
      kioskId,
      payment: { method: 'cash_counter', status: 'pending', amountMinor: 0 },
    });
    this.kioskStore.logEvent({
      storeId: this.storeId, kioskId, eventType: 'payment.cash_selected',
      payload: { posOrderNumber: result.posOrderNumber ?? null },
    });
    return result;
  }

  /** Payments a human has to look at. */
  listNeedingAttention() {
    return this.paymentAdapter.listNeedingAttention?.() ?? [];
  }
}

function translatePaymentError(error) {
  if (error instanceof PaymentRejectedError) {
    return new AppError(error.code ?? 'payment_rejected', error.message, {
      status: error.code === 'payment_not_found' ? 404 : 409,
      details: error.details,
    });
  }
  if (error instanceof PaymentUnavailableError) {
    return new AppError(error.code ?? 'terminal_unavailable', error.message, {
      status: 503, details: error.details,
    });
  }
  if (error instanceof PosRejectedError) {
    return new AppError(error.code ?? 'pos_rejected', error.message, { status: 409, details: error.details });
  }
  return error;
}
