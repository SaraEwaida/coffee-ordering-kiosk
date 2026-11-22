import { PaymentAdapter, PaymentUnavailableError } from './PaymentAdapter.js';

/**
 * Real bank terminal adapters — NOT IMPLEMENTED.
 *
 * These are contracts, not working code, and they throw rather than pretend.
 * A stub that quietly returned "approved" would be the single most dangerous
 * thing in this repository: it would make an unpaid order look paid.
 *
 * Everything below is BLOCKED on things we do not have. None of it can be
 * written from documentation we have not read.
 */

/** What has to be answered before either adapter can be written. */
export const INTEGRATION_CHECKLIST = Object.freeze([
  'Vendor SDK documentation and a licensed copy of the SDK itself.',
  'Confirmation the terminal is certified for UNATTENDED use. Attended-only '
    + 'terminals are not permitted on a self-service kiosk.',
  'A physical test terminal plus test cards, and acquirer test credentials.',
  'The integration transport: USB HID, serial, local TCP service, or a '
    + 'Windows DLL. This decides whether a local device service is required.',
  'Where PCI scope lands. The kiosk must stay out of scope: the terminal '
    + 'reads and encrypts the card, and we receive only an outcome.',
  'Timeout, cancellation and reversal semantics — specifically what the SDK '
    + 'returns when the terminal stops responding mid-authorisation, which is '
    + 'the case that decides whether a customer can be charged twice.',
  'Refund and void capability, and whether either can be initiated '
    + 'unattended or needs a cashier.',
  'Settlement and reconciliation: batch close, and how a kiosk order is '
    + 'matched to an acquirer transaction at end of day.',
  'Receipt requirements: what the acquirer obliges us to print.',
  'Certification process and the sign-off needed before going live.',
]);

class NotImplementedBankAdapter extends PaymentAdapter {
  constructor(bankName, contactNote) {
    super();
    this.bankName = bankName;
    this.contactNote = contactNote;
    this.implemented = false;
  }

  get supportedMethods() {
    return [];
  }

  #blocked(operation) {
    return new PaymentUnavailableError(
      `${this.bankName} terminal integration is not implemented. ${this.contactNote}`,
      {
        code: 'adapter_not_implemented',
        details: {
          bank: this.bankName,
          operation,
          blockedOn: INTEGRATION_CHECKLIST,
        },
      },
    );
  }

  async startPayment() { throw this.#blocked('startPayment'); }
  async getPaymentStatus() { throw this.#blocked('getPaymentStatus'); }
  async cancelPayment() { throw this.#blocked('cancelPayment'); }

  async health() {
    return {
      healthy: false,
      implemented: false,
      detail: `${this.bankName}: adapter not implemented — SDK and certified hardware needed.`,
    };
  }
}

export class ArabBankTerminalAdapter extends NotImplementedBankAdapter {
  constructor() {
    super('Arab Bank', 'Request the unattended terminal SDK and a test device from the bank.');
  }
  get name() { return 'arab-bank-terminal'; }
}

export class BankOfPalestineTerminalAdapter extends NotImplementedBankAdapter {
  constructor() {
    super('Bank of Palestine', 'Request the unattended terminal SDK and a test device from the bank.');
  }
  get name() { return 'bank-of-palestine-terminal'; }
}

/** Every payment adapter the platform knows about, and whether it works. */
export function paymentAdapterRegistry() {
  return [
    { id: 'simulator', name: 'Payment simulator', implemented: true, usableForDemo: true },
    { id: 'arab-bank-terminal', name: 'Arab Bank terminal', implemented: false, usableForDemo: false },
    { id: 'bank-of-palestine-terminal', name: 'Bank of Palestine terminal', implemented: false, usableForDemo: false },
  ];
}
