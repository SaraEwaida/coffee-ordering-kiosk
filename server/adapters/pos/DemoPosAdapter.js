import { PosAdapter, PosIntegrationError, PosRejectedError } from './PosAdapter.js';

/**
 * DemoPosAdapter — the kiosk's client to the Demo POS.
 *
 * Stands in for the client's real POS during the proof of concept. It is the
 * ONLY code that bridges kiosk-side services to `DemoPosStore`; nothing else in
 * the kiosk may import the store.
 *
 * The Demo POS runs in the same process, so these calls are synchronous SQLite
 * reads wrapped in promises. A real adapter will do HTTP or IPC instead. The
 * interface is async precisely so that swap needs no caller changes, and the
 * latency/failure plumbing below exists so the kiosk's retry, backoff and
 * offline handling are exercised now rather than discovered on a client's site.
 */
export class DemoPosAdapter extends PosAdapter {
  /**
   * @param {object} args
   * @param {import('../../demo-pos/store.js').DemoPosStore} args.store
   * @param {object} [args.faults] Dev-only fault injection. See `setFaults`.
   */
  constructor({ store, logger = null, faults = {} } = {}) {
    super();
    if (!store) throw new Error('DemoPosAdapter requires a DemoPosStore');
    this.store = store;
    this.logger = logger;
    this.faults = { offline: false, latencyMs: 0, failOnSubmit: false, ...faults };
    this.metrics = { calls: 0, failures: 0, totalLatencyMs: 0, lastLatencyMs: null, lastErrorAt: null, lastError: null };
  }

  get name() {
    return 'demo-pos';
  }

  /**
   * Dev/demo-only fault injection, so the recovery paths that matter most
   * (POS unreachable, approved payment with no order) can be demonstrated and
   * tested without unplugging anything. Never reachable from the customer UI:
   * it is driven from the authenticated operator panel and from tests.
   */
  setFaults(faults = {}) {
    this.faults = { ...this.faults, ...faults };
    this.logger?.warn?.('demopos.faults_changed', { faults: this.faults });
    return this.faults;
  }

  /** Wraps every call so metrics and the offline switch apply uniformly. */
  async #call(operation, fn) {
    const started = process.hrtime.bigint();
    this.metrics.calls += 1;
    try {
      if (this.faults.offline) {
        throw new PosIntegrationError('The till system is not reachable.', {
          code: 'pos_offline',
          details: { operation, simulated: true },
        });
      }
      if (this.faults.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.faults.latencyMs));
      }
      const result = await fn();
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.metrics.lastLatencyMs = latencyMs;
      this.metrics.totalLatencyMs += latencyMs;
      return result;
    } catch (error) {
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.metrics.lastLatencyMs = latencyMs;
      this.metrics.totalLatencyMs += latencyMs;

      // A refusal is not a failure of the integration: the POS answered, it
      // just said no. Counting those as failures would make a shop that sells
      // out of oat milk look like it has a broken connection.
      if (!(error instanceof PosRejectedError)) {
        this.metrics.failures += 1;
        this.metrics.lastErrorAt = new Date().toISOString();
        this.metrics.lastError = error.message;
      }
      if (error instanceof PosRejectedError || error instanceof PosIntegrationError) throw error;

      // Anything else is an unexpected fault in the POS itself.
      this.logger?.error?.('demopos.unexpected_error', { operation, message: error.message });
      throw new PosIntegrationError('The till system returned an unexpected error.', {
        code: 'pos_error',
        details: { operation },
        cause: error,
      });
    }
  }

  async getMenu() {
    return this.#call('getMenu', () => this.store.getMenu());
  }

  async getAvailability() {
    return this.#call('getAvailability', () => this.store.getAvailability());
  }

  async calculateQuote(request) {
    return this.#call('calculateQuote', () => this.store.calculateQuote(request));
  }

  async validateCouponOrLoyalty({ code, kind = 'promotion' } = {}) {
    return this.#call('validateCouponOrLoyalty', () => {
      if (kind === 'gift_card') {
        const card = this.store.findGiftCard(code);
        if (!card) return { valid: false, reason: 'not_found' };
        return {
          valid: true,
          kind: 'gift_card',
          balanceMinor: card.balanceMinor,
          currency: card.currency,
          descriptionEn: 'Gift card',
          descriptionAr: 'بطاقة هدية',
        };
      }
      const promotion = this.store.findPromotion(code);
      if (!promotion) return { valid: false, reason: 'not_found' };
      return {
        valid: true,
        kind: 'promotion',
        promotionKind: promotion.kind,
        value: promotion.value,
        minSubtotalMinor: promotion.minSubtotalMinor,
        descriptionEn: promotion.kind === 'percent' ? `${promotion.value / 100}% off` : 'Fixed discount',
        descriptionAr: promotion.kind === 'percent' ? `خصم ${promotion.value / 100}%` : 'خصم ثابت',
      };
    });
  }

  async submitOrder(request) {
    return this.#call('submitOrder', () => {
      if (this.faults.failOnSubmit) {
        // Simulates the worst case: the POS goes away at the moment of order
        // creation. Scenario G in the brief depends on this being reachable.
        throw new PosIntegrationError('The till system did not confirm the order.', {
          code: 'pos_submit_failed',
          details: { simulated: true },
        });
      }
      return this.store.createOrder(request, { actor: { type: 'kiosk', id: request.kioskId } });
    });
  }

  async attachPayment({ posOrderId, payment }) {
    return this.#call('attachPayment', () =>
      this.store.attachPayment(posOrderId, payment, { type: 'kiosk', id: payment?.kioskId ?? null }));
  }

  async getOrderStatus(posOrderId) {
    return this.#call('getOrderStatus', () => {
      const order = this.store.getOrder(posOrderId);
      if (!order) throw new PosRejectedError('Order not found.', { code: 'order_not_found' });
      return order;
    });
  }

  async health() {
    const started = process.hrtime.bigint();
    try {
      if (this.faults.offline) {
        return { healthy: false, latencyMs: 0, detail: 'Simulated offline (demo fault injection is on)' };
      }
      const result = this.store.health();
      return {
        healthy: result.healthy,
        latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
        detail: result.detail,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
        detail: error.message,
      };
    }
  }

  /** Error rate and latency for the health endpoint and fleet console. */
  getMetrics() {
    const { calls, failures, totalLatencyMs, lastLatencyMs, lastError, lastErrorAt } = this.metrics;
    return {
      adapter: this.name,
      calls,
      failures,
      errorRate: calls === 0 ? 0 : Number((failures / calls).toFixed(4)),
      averageLatencyMs: calls === 0 ? 0 : Number((totalLatencyMs / calls).toFixed(2)),
      lastLatencyMs: lastLatencyMs === null ? null : Number(lastLatencyMs.toFixed(2)),
      lastError,
      lastErrorAt,
      faultsActive: Object.entries(this.faults).some(([, v]) => v !== false && v !== 0),
    };
  }
}
