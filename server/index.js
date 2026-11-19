import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialProducts, unitPrice, validOptions } from '../shared/catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');
mkdirSync(dataDir, { recursive: true });
const productsFile = resolve(dataDir, 'products.json');
const ordersFile = resolve(dataDir, 'orders.json');
function readData(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`Cannot read ${path}: ${e.message}`); }
}
function saveData(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(temp, path);
}
let products = readData(productsFile, initialProducts);
let orders = readData(ordersFile, []);
if (!existsSync(productsFile)) saveData(productsFile, products);
if (!existsSync(ordersFile)) saveData(ordersFile, orders);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/products', (_req, res) => res.json(products));
app.get('/api/orders', (_req, res) => res.json([...orders].reverse()));
app.get('/api/summary', (_req, res) => res.json({
  orders: orders.length,
  open: orders.filter((o) => o.status !== 'completed').length,
  paidRevenue: Math.round(orders.filter((o) => o.paid).reduce((sum,o) => sum+o.total,0)*100)/100,
}));
app.post('/api/orders', (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) throw new Error('Order needs 1–30 items');
    if (!['dine_in','takeaway'].includes(body.fulfillment)) throw new Error('Invalid order type');
    const items = body.items.map((item) => {
      const product = products.find(p => p.id === item.productId);
      if (!product || !product.available) throw new Error(`Product unavailable: ${item.productId}`);
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error('Invalid quantity');
      const options = validOptions(item.options);
      const price = unitPrice(product, options);
      return { productId: product.id, name: product.name, nameAr: product.nameAr, image: product.image, options, quantity, unitPrice: price, lineTotal: Math.round(quantity * price * 100) / 100 };
    });
    const total = Math.round(items.reduce((sum,i) => sum+i.lineTotal,0)*100)/100;
    const number = String((orders.at(-1)?.sequence || 1000) + 1);
    const order = {
      id: crypto.randomUUID(), sequence: Number(number), number, createdAt: new Date().toISOString(),
      customerName: String(body.customerName || '').trim().slice(0,40), fulfillment:body.fulfillment,
      paymentMethod: 'counter', paid: false, status: 'new', items, total,
    };
    orders.push(order); saveData(ordersFile, orders);
    res.status(201).json(order);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error:'Order not found' });
  if (Object.hasOwn(req.body, 'status')) {
    if (!['new','preparing','ready','completed'].includes(req.body.status)) return res.status(400).json({ error:'Invalid status' });
    order.status = req.body.status;
  }
  if (Object.hasOwn(req.body, 'paid')) {
    if (typeof req.body.paid !== 'boolean') return res.status(400).json({ error:'Paid must be boolean' });
    order.paid = req.body.paid; // Staff must actually verify payment before marking paid.
  }
  saveData(ordersFile, orders);
  res.json(order);
});
app.patch('/api/products/:id', (req, res) => {
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({error:'Product not found'});
  if (Object.hasOwn(req.body, 'price')) {
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 0 || price > 999) return res.status(400).json({error:'Invalid price'});
    product.price = Math.round(price*100)/100;
  }
  if (Object.hasOwn(req.body, 'available')) {
    if (typeof req.body.available !== 'boolean') return res.status(400).json({error:'Availability must be boolean'});
    product.available = req.body.available;
  }
  saveData(productsFile, products);
  res.json(product);
});

const distDir = resolve(here, '../dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => res.sendFile(resolve(distDir, 'index.html')));
}
app.use((err, _req, res, _next) => res.status(400).json({error: err.message || 'Bad request'}));
const port = Number(process.env.PORT || 3001);
app.listen(port, '0.0.0.0', () => console.log(`Coffee Kiosk API running at http://localhost:${port}`));
