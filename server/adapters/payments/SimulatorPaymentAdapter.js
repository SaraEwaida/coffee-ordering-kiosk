import { randomUUID, randomBytes } from 'node:crypto';
import { PaymentAdapter, PaymentRejectedError, isTerminal } from './PaymentAdapter.js';
import { withTransaction } from '../../database/connection.js';

/**
 * Deterministic unattended card-reader simulator.
 *
 * This exists because "choose Visa, then pay at the counter" does not
 * demonstrate anything a coffee shop cares about. A real unattended terminal
 * makes the customer wait, can decline, can time out, and can stop answering
 * halfway. Every one of those paths has to be shown working before a client
 * will trust the kiosk with their money.
 *
 * Deterministic means: an outcome is never random. It is whatever the operator
 * panel forced, or `approved` otherwise. A demo in front of a client must do
 * the same thing every time.
 *
 * Progress is time-driven and stored in SQLite rather than held in a timer, so
 * it survives a browser reload, a kiosk restart and a power cut. The kiosk
 * polls; the state advances when its due time passes.
 *
 * NO CARD DATA. The simulator invents a masked brand label ("Visa ••••4417")
 * and a reference. Those strings are fabricated for display and are clearly
 * marked simulated; they are not authorization codes and must never be
 * presented as such.
 */

/** Realistic-feeling delays, in milliseconds. Short enough to demo. */
const TIMING = Object.freeze({
  waitingForCard: 400,   // terminal wakes and asks for the card
  processing: 1600,      // card presented, talking to the "acquirer"
  cardTimeout: 45000,    // customer never presents a card
});

const SIMULATED_CARDS = Object.freeze([
  { brand: 'Visa', last4: '4417' },
  { brand: 'Mastercard', last4: '8802' },
  { brand: 'Visa', last4: '1095' },
]);

export class SimulatorPaymentAdapter extends PaymentAdapter {
  constructor({ db, logger = null, clock = () => Date.now() } = {}) {
    super();
    if (!db) throw new Error('SimulatorPaymentAdapter requires the kiosk database');
    this.db = db;
    this.logger = logger;
    this.clock = clock;
    // What the NEXT payment will do. Set from the authenticated operator panel
    // so a demonstration can show a decline on purpose.
    this.defaultOutcome = 'approved';
  }

  get name() {
    return 'simulator';
  }

  get supportedMethods() {
    return ['card_simulated', 'cash_counter', 'gift_card'];
  }

  /**
   * Dev/demo only. Decides the outcome of payments started from now on.
   * Never reachable from the customer UI.
   */
  setDefaultOutcome(outcome) {
    const allowed = ['approved', 'declined', 'timed_out', 'failed', 'unknown'];
    if (!allowed.includes(outcome)) {
      throw new PaymentRejectedError(`Outcome must be one of ${allowed.join(', ')}.`, {
        code: 'invalid_outcome',
      });
    }
    this.defaultOutcome = outcome;
    this.logger?.warn?.('simulator.default_outcome_changed', { outcome });
    return outcome;
  }

  // ------------------------------------------------------------------ start

  /**
   * @param {object} input
   * @param {number} input.amountMinor  From the stored quote. Never from a browser.
   */
  async startPayment({
    paymentId, storeId, kioskId, quoteId, clientRequestId,
    amountMinor, currency, method = 'card_simulated',
    giftCardCode = null, giftAppliedMinor = 0,
  }) {
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      throw new PaymentRejectedError('A payment needs a whole-number amount.', {
        code: 'invalid_amount',
      });
    }
    if (!this.supportedMethods.includes(method)) {
      throw new PaymentRejectedError(`Unsupported payment method: ${method}`, {
        code: 'unsupported_method',
      });
    }

    const id = paymentId ?? randomUUID();
    const now = this.clock();
    const cardAmountMinor = Math.max(0, amountMinor - giftAppliedMinor);

    return withTransaction(this.db, () => {
      // One payment per checkout attempt. A double tap on "Pay" finds the
      // existing session instead of opening a second one against the same card.
      const existing = this.db
        .prepare('SELECT id FROM kiosk_payment_sessions WHERE client_request_id = ?')
        .get(clientRequestId);
      if (existing) return this.#read(existing.id);

      // Three different shapes of payment:
      //   cash_counter — not a terminal interaction at all. Recorded pending;
      //                  only a member of staff can mark the money received.
      //   gift_card    — the balance IS the payment when it covers the whole
      //                  order, so there is no card to wait for.
      //   card         — goes through the full terminal state machine.
      const initialState = method === 'cash_counter'
        ? 'created'
        : method === 'gift_card' ? 'approved' : 'waiting_for_card';
      const advanceAt = initialState === 'waiting_for_card'
        ? new Date(now + TIMING.waitingForCard).toISOString()
        : null;
      const initialReference = method === 'gift_card'
        ? `SIM-GIFT-${randomBytes(4).toString('hex').toUpperCase()}`
        : null;

      this.db.prepare(`
        INSERT INTO kiosk_payment_sessions (
          id, store_id, kiosk_id, quote_id, client_request_id, method, state,
          amount_minor, currency, gift_card_code, gift_applied_minor, card_amount_minor,
          forced_outcome, advance_at, expires_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, storeId, kioskId ?? null, quoteId ?? null, clientRequestId, method, initialState,
        amountMinor, currency, giftCardCode, giftAppliedMinor, cardAmountMinor,
        this.defaultOutcome, advanceAt,
        new Date(now + 15 * 60 * 1000).toISOString(),
      );
      if (initialReference) {
        this.db.prepare('UPDATE kiosk_payment_sessions SET reference = ? WHERE id = ?')
          .run(initialReference, id);
      }
      this.#event(id, null, initialState, 'system', `started (${method})`);
      this.logger?.info?.('payment.started', {
        paymentId: id, method, amountMinor, currency, giftAppliedMinor,
      });
      return this.#read(id);
    });
  }

  // ----------------------------------------------------------------- status

  /**
   * Current state, advancing the machine first if its due time has passed.
   *
   * Advancing on read rather than on a timer is what makes this survive a
   * restart: there is no in-memory timer to lose.
   */
  async getPaymentStatus(paymentId) {
    this.#advanceFully(paymentId);
    const session = this.#read(paymentId);
    if (!session) {
      throw new PaymentRejectedError('Payment not found.', { code: 'payment_not_found' });
    }
    return session;
  }

  /**
   * Catch the machine up to the present.
   *
   * One poll must not advance only one step. If the kiosk polls slowly, or the
   * browser was backgrounded, or the process restarted after a gap, the
   * payment has to land where elapsed time says it should — not one step
   * behind. Bounded so a clock jump cannot spin.
   */
  #advanceFully(paymentId) {
    for (let i = 0; i < 8; i += 1) {
      const before = this.db
        .prepare('SELECT state, advance_at FROM kiosk_payment_sessions WHERE id = ?')
        .get(paymentId);
      if (!before) return;
      this.#advance(paymentId);
      const after = this.db
        .prepare('SELECT state, advance_at FROM kiosk_payment_sessions WHERE id = ?')
        .get(paymentId);
      if (!after || (after.state === before.state && after.advance_at === before.advance_at)) return;
    }
  }

  /**
   * Move the machine on by one step if it is due.
   *
   *   waiting_for_card → processing   (card presented)
   *   waiting_for_card → timed_out    (nobody presented one)
   *   processing       → the forced outcome
   */
  #advance(paymentId) {
    withTransaction(this.db, () => {
      const row = this.db
        .prepare('SELECT * FROM kiosk_payment_sessions WHERE id = ?')
        .get(paymentId);
      if (!row || isTerminal(row.state) || row.state === 'unknown') return;
      if (!row.advance_at) return;

      const now = this.clock();
      if (new Date(row.advance_at).getTime() > now) return;

      // Advance from the time the step was DUE, not from now. Rebasing on
      // `now` would push every next step into the future, so a late poll could
      // never catch up — it would crawl forward one step per request.
      const dueAt = new Date(row.advance_at).getTime();
      const createdAt = new Date(row.created_at).getTime();

      if (row.state === 'waiting_for_card') {
        if (row.forced_outcome === 'timed_out') {
          // The customer never presents a card. Resolve exactly when a real
          // terminal would give up.
          const timeoutAt = createdAt + TIMING.cardTimeout;
          if (now >= timeoutAt) {
            this.#set(row.id, 'timed_out', { failureReason: 'no_card_presented', advanceAt: null });
          } else {
            this.#set(row.id, 'waiting_for_card', { advanceAt: new Date(timeoutAt).toISOString() });
          }
          return;
        }
        const card = SIMULATED_CARDS[Math.abs(hash(row.id)) % SIMULATED_CARDS.length];
        this.#set(row.id, 'processing', {
          maskedDetail: `${card.brand} \u2022\u2022\u2022\u2022${card.last4}`,
          advanceAt: new Date(dueAt + TIMING.processing).toISOString(),
        });
        return;
      }

      if (row.state === 'processing') {
        const outcome = row.forced_outcome || 'approved';
        if (outcome === 'approved') {
          this.#set(row.id, 'approved', {
            // Clearly marked simulated. This is NOT an authorization code and
            // must never be shown as one.
            reference: `SIM-${randomBytes(6).toString('hex').toUpperCase()}`,
            advanceAt: null,
          });
        } else if (outcome === 'unknown') {
          // The dangerous case: the terminal stopped answering mid-authorisation.
          // Never auto-resolved — a human decides.
          this.#set(row.id, 'unknown', {
            failureReason: 'terminal_no_response',
            reference: `SIM-UNK-${randomBytes(4).toString('hex').toUpperCase()}`,
            advanceAt: null,
          });
        } else {
          this.#set(row.id, outcome, {
            failureReason: outcome === 'declined' ? 'card_declined' : 'terminal_error',
            advanceAt: null,
          });
        }
      }
    });
  }

  // ----------------------------------------------------------------- cancel

  /**
   * Cancel, if the terminal has not committed yet.
   *
   * Refused once processing has started, which is how a real terminal behaves:
   * at that point the acquirer may already hold the authorisation, and letting
   * a customer "cancel" it would be a lie.
   */
  async cancelPayment(paymentId, { actor = 'customer' } = {}) {
    return withTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM kiosk_payment_sessions WHERE id = ?').get(paymentId);
      if (!row) throw new PaymentRejectedError('Payment not found.', { code: 'payment_not_found' });

      if (isTerminal(row.state)) {
        if (row.state === 'cancelled') return this.#read(paymentId);
        throw new PaymentRejectedError('This payment has already finished.', {
          code: 'payment_already_final',
          details: { state: row.state },
        });
      }
      if (row.state === 'unknown') {
        throw new PaymentRejectedError('This payment needs a member of staff.', {
          code: 'payment_needs_staff',
        });
      }
      if (row.state === 'processing') {
        throw new PaymentRejectedError('The card is being processed and cannot be cancelled now.', {
          code: 'payment_not_cancellable',
          details: { state: row.state },
        });
      }
      this.#set(paymentId, 'cancelled', { failureReason: 'cancelled_by_' + actor, advanceAt: null }, actor);
      return this.#read(paymentId);
    });
  }

  /** Operator panel: force a specific outcome on a live payment, immediately. */
  async forceOutcome(paymentId, outcome, { actor = 'manager' } = {}) {
    const allowed = ['approved', 'declined', 'cancelled', 'timed_out', 'failed', 'unknown'];
    if (!allowed.includes(outcome)) {
      throw new PaymentRejectedError(`Outcome must be one of ${allowed.join(', ')}.`, {
        code: 'invalid_outcome',
      });
    }
    return withTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM kiosk_payment_sessions WHERE id = ?').get(paymentId);
      if (!row) throw new PaymentRejectedError('Payment not found.', { code: 'payment_not_found' });
      if (isTerminal(row.state)) {
        throw new PaymentRejectedError('This payment has already finished.', {
          code: 'payment_already_final', details: { state: row.state },
        });
      }
      this.#set(paymentId, outcome, {
        reference: outcome === 'approved' ? `SIM-${randomBytes(6).toString('hex').toUpperCase()}` : row.reference,
        failureReason: outcome === 'approved' ? null : `forced_${outcome}`,
        advanceAt: null,
      }, actor);
      return this.#read(paymentId);
    });
  }

  /** Mark that the POS order for this payment exists, so it cannot be re-created. */
  async markOrderSubmitted(paymentId, posOrderId) {
    this.db.prepare(`
      UPDATE kiosk_payment_sessions
      SET order_submitted = 1, pos_order_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(posOrderId, paymentId);
    return this.#read(paymentId);
  }

  /**
   * Settlement details, including the UNMASKED gift-card code.
   *
   * Server-side only: no route returns this. The customer-facing session masks
   * the code to its last four characters, because a gift-card code is a bearer
   * credential — anyone holding it can spend the balance.
   */
  getSettlementDetails(paymentId) {
    const row = this.db
      .prepare('SELECT gift_card_code, gift_applied_minor FROM kiosk_payment_sessions WHERE id = ?')
      .get(paymentId);
    if (!row) return null;
    return { giftCardCode: row.gift_card_code, giftAppliedMinor: row.gift_applied_minor };
  }

  findByClientRequestId(clientRequestId) {
    const row = this.db
      .prepare('SELECT id FROM kiosk_payment_sessions WHERE client_request_id = ?')
      .get(clientRequestId);
    return row ? this.#read(row.id) : null;
  }

  /** Payments needing a human: stopped answering, or approved with no order. */
  listNeedingAttention() {
    return this.db.prepare(`
      SELECT * FROM kiosk_payment_sessions
      WHERE state = 'unknown'
         OR (state = 'approved' AND order_submitted = 0)
      ORDER BY created_at ASC
    `).all().map(hydrate);
  }

  listEvents(paymentId) {
    return this.db
      .prepare('SELECT * FROM kiosk_payment_events WHERE payment_id = ? ORDER BY id')
      .all(paymentId);
  }

  async health() {
    return { healthy: true, detail: 'Simulated terminal. No real card is ever charged.' };
  }

  // ---------------------------------------------------------------- private

  #set(paymentId, state, { reference, maskedDetail, failureReason, advanceAt } = {}, actor = 'system') {
    const before = this.db.prepare('SELECT state FROM kiosk_payment_sessions WHERE id = ?').get(paymentId);
    this.db.prepare(`
      UPDATE kiosk_payment_sessions SET
        state = ?,
        reference = COALESCE(?, reference),
        masked_detail = COALESCE(?, masked_detail),
        failure_reason = ?,
        advance_at = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(state, reference ?? null, maskedDetail ?? null, failureReason ?? null, advanceAt ?? null, paymentId);
    if (before?.state !== state) this.#event(paymentId, before?.state ?? null, state, actor, '');
  }

  #event(paymentId, fromState, toState, actor, detail) {
    this.db.prepare(`
      INSERT INTO kiosk_payment_events (payment_id, from_state, to_state, actor, detail)
      VALUES (?,?,?,?,?)
    `).run(paymentId, fromState, toState, actor, detail);
  }

  #read(paymentId) {
    const row = this.db.prepare('SELECT * FROM kiosk_payment_sessions WHERE id = ?').get(paymentId);
    return row ? hydrate(row) : null;
  }
}

/** Prompts the screen shows. Both languages, because the kiosk is bilingual. */
const PROMPTS = {
  created: {
    en: 'Getting the card reader ready...',
    ar: 'جارٍ تجهيز قارئ البطاقة...',
  },
  waiting_for_card: {
    en: 'Tap, insert or swipe your card',
    ar: 'قرّب بطاقتك أو أدخلها أو مرّرها',
  },
  processing: {
    en: 'Please wait — do not remove your card',
    ar: 'الرجاء الانتظار — لا تسحب بطاقتك',
  },
  approved: { en: 'Payment approved', ar: 'تمت الموافقة على الدفع' },
  declined: { en: 'Card declined. Please try another card.', ar: 'تم رفض البطاقة. جرّب بطاقة أخرى.' },
  cancelled: { en: 'Payment cancelled', ar: 'تم إلغاء الدفع' },
  timed_out: { en: 'No card was presented. Please start again.', ar: 'لم يتم تقديم بطاقة. الرجاء البدء من جديد.' },
  failed: { en: 'The card reader had a problem. Please try again.', ar: 'حدثت مشكلة في قارئ البطاقة. الرجاء المحاولة مرة أخرى.' },
  voided: { en: 'Payment voided', ar: 'تم إبطال الدفع' },
  // Deliberately tells the customer to find a person, because nobody should
  // guess whether this one was paid.
  unknown: {
    en: 'We could not confirm your payment. Please speak to a member of staff before paying again.',
    ar: 'لم نتمكن من تأكيد الدفع. الرجاء مراجعة أحد الموظفين قبل الدفع مرة أخرى.',
  },
  cash_counter: { en: 'Please pay at the counter', ar: 'الرجاء الدفع عند الكاشير' },
  gift_card_paid: { en: 'Paid with your gift card', ar: 'تم الدفع باستخدام بطاقة الهدية' },
};

function hydrate(row) {
  let prompt = PROMPTS[row.state] ?? PROMPTS.created;
  if (row.method === 'cash_counter' && row.state === 'created') prompt = PROMPTS.cash_counter;
  if (row.method === 'gift_card' && row.state === 'approved') prompt = PROMPTS.gift_card_paid;
  return {
    paymentId: row.id,
    state: row.state,
    method: row.method,
    amountMinor: row.amount_minor,
    currency: row.currency,
    giftCardCode: row.gift_card_code ? `••••${row.gift_card_code.slice(-4)}` : null,
    giftAppliedMinor: row.gift_applied_minor,
    cardAmountMinor: row.card_amount_minor,
    reference: row.reference,
    maskedDetail: row.masked_detail,
    failureReason: row.failure_reason,
    promptEn: prompt.en,
    promptAr: prompt.ar,
    cancellable: ['created', 'waiting_for_card'].includes(row.state),
    terminal: isTerminal(row.state),
    needsStaff: row.state === 'unknown',
    orderSubmitted: Boolean(row.order_submitted),
    posOrderId: row.pos_order_id,
    clientRequestId: row.client_request_id,
    quoteId: row.quote_id,
    simulated: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Stable per-id card pick, so the same payment always shows the same card. */
function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}
