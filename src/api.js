/**
 * Kiosk API client.
 *
 * Talks ONLY to /api/kiosk/*. The kiosk never reaches the POS, never opens a
 * database, and cannot change a price: there is no endpoint here that would
 * let it.
 */

export class ApiError extends Error {
  constructor(message, { code, status, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`/api/kiosk${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    // Network-level failure: the kiosk cannot reach its own server.
    throw new ApiError('offline', { code: 'network_unreachable', status: 0 });
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new ApiError(data?.error?.message || `Request failed (${response.status})`, {
      code: data?.error?.code,
      status: response.status,
      details: data?.error?.details,
    });
  }
  return data;
}

export const api = {
  config: () => request('/config'),
  menu: () => request('/menu'),
  forceSync: () => request('/menu/sync', { method: 'POST' }),

  /** Ask the POS to price a cart. The returned total is the only chargeable one. */
  quote: ({ kioskId, cart }, signal) =>
    request('/quotes', { method: 'POST', body: { kioskId, cart }, signal }),

  /**
   * Submit an order. `clientRequestId` must be stable across retries of the
   * SAME checkout attempt, so a double tap cannot create a second order.
   */
  submitOrder: (payload) => request('/orders', { method: 'POST', body: payload }),

  orderByRequest: (clientRequestId) =>
    request(`/orders/by-request/${encodeURIComponent(clientRequestId)}`),

  orderStatus: (posOrderId) => request(`/orders/${encodeURIComponent(posOrderId)}/status`),

  promotion: (code) => request(`/promotions/${encodeURIComponent(code)}`),

  heartbeat: (kioskId, appVersion) =>
    request(`/kiosks/${encodeURIComponent(kioskId)}/heartbeat`, {
      method: 'POST',
      body: { appVersion },
    }),
};

/**
 * A stable idempotency key for one checkout attempt.
 *
 * Generated once when the customer reaches checkout and reused for every retry,
 * which is what makes a double tap or a flaky network safe.
 */
export function newClientRequestId(kioskId = 'kiosk-01') {
  const random = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kioskId}-${Date.now()}-${random.slice(0, 8)}`.replace(/[^\w-]/g, '').slice(0, 100);
}
