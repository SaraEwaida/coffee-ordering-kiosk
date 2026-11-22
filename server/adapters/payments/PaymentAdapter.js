/**
 * Payment adapter contract.
 *
 * ==========================================================================
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ==========================================================================
 * No raw card data ever enters this application. Not a PAN, not a CVV, not a
 * PIN, not magnetic-stripe track data. The customer's card is read by a
 * certified terminal that we talk to through one of these adapters; what comes
 * back is an OUTCOME and a REFERENCE, and that is all we store.
 *
 * Browser JavaScript cannot talk to a bank SDK. The kiosk UI therefore never
 * sees card data either: it starts a payment, polls for the outcome, and shows
 * prompts. The amount is always taken from the server-side quote, never from
 * anything the browser sent.
 *
 * SimulatorPaymentAdapter implements this today. Real terminal adapters
 * (Arab Bank, Bank of Palestine) are stubs until we have vendor SDKs,
 * unattended-mode certification and test hardware — see the files beside this
 * one. They are not simulated and then described as working.
 */

/** Terminal states: a payment that reaches one of these will not change again. */
export const TERMINAL_STATES = Object.freeze([
  'approved', 'declined', 'cancelled', 'timed_out', 'failed', 'voided',
]);

/**
 * Every state a payment can hold.
 *
 * `unknown` is the important one and the reason this is a state machine rather
 * than a boolean. A terminal can stop answering after the card was presented
 * but before we learn the outcome. Treating that as a decline risks serving an
 * order that was never paid for; treating it as approved risks giving away
 * coffee. It is its own state, it is NEVER auto-resolved, and it goes to a
 * human.
 */
export const PAYMENT_STATES = Object.freeze([
  'created',
  'waiting_for_card',
  'processing',
  ...TERMINAL_STATES,
  'unknown',
]);

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/** Raised when the terminal cannot be reached. Retryable. */
export class PaymentUnavailableError extends Error {
  constructor(message, { code = 'terminal_unavailable', details } = {}) {
    super(message);
    this.name = 'PaymentUnavailableError';
    this.code = code;
    this.retryable = true;
    this.details = details;
  }
}

/** Raised when the request itself is wrong. Not retryable. */
export class PaymentRejectedError extends Error {
  constructor(message, { code = 'payment_rejected', details } = {}) {
    super(message);
    this.name = 'PaymentRejectedError';
    this.code = code;
    this.retryable = false;
    this.details = details;
  }
}

/**
 * @typedef {object} PaymentSession
 * @property {string} paymentId
 * @property {string} state                One of PAYMENT_STATES.
 * @property {number} amountMinor          From the server-side quote only.
 * @property {string} currency
 * @property {string} method               card_simulated | cash_counter | gift_card
 * @property {string|null} reference       Adapter reference. Never a card number.
 * @property {string|null} maskedDetail    e.g. "Visa ••••4417" — simulated.
 * @property {string} promptEn             What the screen should say now.
 * @property {string} promptAr
 * @property {string|null} failureReason   Why it failed, for the customer.
 * @property {boolean} cancellable         Whether a cancel request is honoured now.
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export class PaymentAdapter {
  get name() {
    return 'abstract';
  }

  /** Supported methods, for the UI to offer. */
  get supportedMethods() {
    return [];
  }

  /**
   * Begin a payment. The amount comes from the caller, which takes it from the
   * stored quote — an adapter must never accept an amount from a browser.
   * @returns {Promise<PaymentSession>}
   */
  async startPayment(_input) {
    throw new Error(`${this.constructor.name} must implement startPayment()`);
  }

  /** @returns {Promise<PaymentSession>} */
  async getPaymentStatus(_paymentId) {
    throw new Error(`${this.constructor.name} must implement getPaymentStatus()`);
  }

  /**
   * Request cancellation. Honoured only while the terminal has not committed;
   * once processing has begun, a cancel request may be refused, which is how
   * real terminals behave.
   * @returns {Promise<PaymentSession>}
   */
  async cancelPayment(_paymentId) {
    throw new Error(`${this.constructor.name} must implement cancelPayment()`);
  }

  /** @returns {Promise<{healthy:boolean, detail?:string}>} */
  async health() {
    throw new Error(`${this.constructor.name} must implement health()`);
  }
}
