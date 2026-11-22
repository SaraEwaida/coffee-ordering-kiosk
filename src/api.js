async function request(path, options = {}, token = '') {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api${path}`, { ...options, headers, cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
const write = (method, body) => ({ method, body: JSON.stringify(body) });
export const api = {
  products: () => request('/products'),
  config: () => request('/config'),
  loyalty: code => request(`/loyalty/accounts/${encodeURIComponent(code)}`),
  loyaltyOverview: token => request('/loyalty/overview', {}, token),
  receipt: token => request(`/receipts/${encodeURIComponent(token)}`),
  placeOrder: data => request('/orders', write('POST', data)),
  login: (username, pin) => request('/staff/login', write('POST', {username, pin})),
  logout: token => request('/staff/logout', write('POST', {}), token),
  orders: token => request('/orders', {}, token),
  summary: token => request('/summary', {}, token),
  events: token => request('/events', {}, token),
  updateOrder: (id, data, token) => request(`/orders/${encodeURIComponent(id)}`, write('PATCH', data), token),
  updateProduct: (id, data, token) => request(`/products/${encodeURIComponent(id)}`, write('PATCH', data), token),
};
