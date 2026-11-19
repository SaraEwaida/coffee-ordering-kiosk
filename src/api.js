async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' }, ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
export const api = {
  products: () => request('/products'),
  orders: () => request('/orders'),
  summary: () => request('/summary'),
  placeOrder: data => request('/orders', { method:'POST', body:JSON.stringify(data) }),
  updateOrder: (id, data) => request(`/orders/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify(data) }),
  updateProduct: (id, data) => request(`/products/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify(data) }),
};
