/** Persistent local SQLite storage. Node >= 22.13 includes node:sqlite. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { initialProducts } from '../shared/catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
export const dataDir = resolve(here, 'data');
mkdirSync(dataDir, { recursive: true });
export const dbFile = resolve(dataDir, 'coffee-kiosk.sqlite');
const fresh = !existsSync(dbFile);
export const db = new DatabaseSync(dbFile);
db.exec(`PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, name_ar TEXT NOT NULL,
  description TEXT NOT NULL, description_ar TEXT NOT NULL,
  category TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents>=0),
  image TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1, popular INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','staff')),
  pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, created_at TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '', fulfillment TEXT NOT NULL,
  status TEXT NOT NULL, payment_method TEXT NOT NULL, payment_status TEXT NOT NULL,
  total_cents INTEGER NOT NULL, receipt_token TEXT NOT NULL UNIQUE,
  request_key TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL, name TEXT NOT NULL, name_ar TEXT NOT NULL,
  image TEXT NOT NULL, options_json TEXT NOT NULL, quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL, line_total_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL, status TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  reference TEXT, recorded_at TEXT NOT NULL, recorded_by TEXT REFERENCES employees(id)
);
CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  points_balance INTEGER NOT NULL DEFAULT 0 CHECK(points_balance >= 0),
  total_earned INTEGER NOT NULL DEFAULT 0 CHECK(total_earned >= 0)
);
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES loyalty_accounts(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  points_delta INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('earned','redeemed','reversal')),
  created_at TEXT NOT NULL,
  UNIQUE (order_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_account ON loyalty_transactions(account_id, id DESC);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
  actor_type TEXT NOT NULL, actor_id TEXT, event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, details_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at);`);

// Upgrade existing Version 2 databases in place without deleting existing orders.
const orderColumns=new Set(db.prepare('PRAGMA table_info(orders)').all().map(c=>c.name));
for (const [name, definition] of Object.entries({
  loyalty_account_id:'TEXT REFERENCES loyalty_accounts(id)',
  loyalty_redeemed_points:'INTEGER NOT NULL DEFAULT 0',
  loyalty_discount_cents:'INTEGER NOT NULL DEFAULT 0',
  loyalty_earned_points:'INTEGER NOT NULL DEFAULT 0',
  subtotal_cents:'INTEGER NOT NULL DEFAULT 0',
})) {
  if (!orderColumns.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
}
// Backfill pre-v3 orders, preserving prices and payment states.
db.exec('UPDATE orders SET subtotal_cents=total_cents WHERE subtotal_cents=0 AND loyalty_discount_cents=0');
export const loyaltyFromDb = row => row ? ({code:row.code,points:row.points_balance,
  totalEarned:row.total_earned,createdAt:row.created_at}) : null;
export const dollars = cents => Number(cents) / 100;
export const cents = amount => Math.round(Number(amount) * 100);
export const productFromDb = row => ({
  id:row.id, name:row.name, nameAr:row.name_ar,
  description:row.description, descriptionAr:row.description_ar,
  category:row.category, price:dollars(row.price_cents), image:row.image,
  available:Boolean(row.available), popular:Boolean(row.popular),
});
export function logEvent(actorType,actorId,type,entityType,entityId,details={}) {
  db.prepare(`INSERT INTO events(created_at,actor_type,actor_id,event_type,entity_type,entity_id,details_json)
    VALUES(?,?,?,?,?,?,?)`).run(new Date().toISOString(),actorType,actorId,type,entityType,entityId,JSON.stringify(details));
}
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {const value=fn(); db.exec('COMMIT'); return value;}
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function orderFromDb(row) {
  if (!row) return null;
  const items=db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY rowid').all(row.id).map(i=>({
    productId:i.product_id,name:i.name,nameAr:i.name_ar,image:i.image,
    options:JSON.parse(i.options_json),quantity:i.quantity,unitPrice:dollars(i.unit_price_cents),lineTotal:dollars(i.line_total_cents),
  }));
  return {id:row.id,sequence:row.sequence,number:String(row.sequence),createdAt:row.created_at,
    customerName:row.customer_name,fulfillment:row.fulfillment,status:row.status,
    paymentMethod:row.payment_method,paymentStatus:row.payment_status,
    paid:row.payment_status==='paid',total:dollars(row.total_cents),subtotal:dollars(row.subtotal_cents),items,
    loyalty:{joined:Boolean(row.loyalty_account_id),redeemedPoints:row.loyalty_redeemed_points,discount:dollars(row.loyalty_discount_cents),earnedPoints:row.loyalty_earned_points},
    receiptToken:row.receipt_token};
}
const insertProduct=db.prepare(`INSERT OR IGNORE INTO products
(id,name,name_ar,description,description_ar,category,price_cents,image,available,popular)
VALUES(?,?,?,?,?,?,?,?,?,?)`);
function saveProduct(p) {insertProduct.run(p.id,p.name,p.nameAr,p.description,p.descriptionAr,p.category,cents(p.price),p.image,p.available?1:0,p.popular?1:0);}

/** One-time migration from the earlier JSON prototype, preserving existing orders and menu prices. */
if (fresh) {
  let importedProducts=initialProducts;
  const legacyProducts=resolve(dataDir,'products.json');
  if (existsSync(legacyProducts)) {
    try {const list=JSON.parse(readFileSync(legacyProducts,'utf8'));if(Array.isArray(list)&&list.length) importedProducts=list;}
    catch(e) {console.warn('Products JSON import skipped:',e.message);}
  }
  transaction(()=>{
    importedProducts.forEach(saveProduct);
    const legacyOrders=resolve(dataDir,'orders.json');
    if (existsSync(legacyOrders)) {
      try {
        const old=JSON.parse(readFileSync(legacyOrders,'utf8'));
        for (const o of old) {
          if (!o.id || !Array.isArray(o.items)) continue;
          db.prepare(`INSERT OR IGNORE INTO orders(id,sequence,created_at,customer_name,fulfillment,status,payment_method,payment_status,total_cents,receipt_token,request_key)
          VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).run(o.id,Number(o.sequence||o.number),o.createdAt||new Date().toISOString(),o.customerName||'',o.fulfillment||'takeaway',o.status||'new','counter',o.paid?'paid':'pending',cents(o.total),randomBytes(24).toString('base64url'));
          for(const i of o.items) db.prepare(`INSERT INTO order_items(id,order_id,product_id,name,name_ar,image,options_json,quantity,unit_price_cents,line_total_cents)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),o.id,i.productId,i.name,i.nameAr||i.name,i.image||'',JSON.stringify(i.options||{}),i.quantity,cents(i.unitPrice),cents(i.lineTotal));
          db.prepare(`INSERT INTO payments(id,order_id,method,status,amount_cents,reference,recorded_at,recorded_by) VALUES(?,?,?,?,?,NULL,?,NULL)`)
            .run(randomUUID(),o.id,'counter',o.paid?'paid':'pending',cents(o.total),o.createdAt||new Date().toISOString());
        }
      } catch(e) {throw new Error(`Legacy orders could not be imported: ${e.message}`);}
    }
  });
} else if (!db.prepare('SELECT id FROM products LIMIT 1').get()) transaction(()=>initialProducts.forEach(saveProduct));

export function seedStaff() {
  const pin=process.env.STAFF_PIN || (process.env.NODE_ENV==='production' ? '' : '123456');
  const existing=db.prepare("SELECT id FROM employees WHERE username='manager'").get();
  if (existing) return;
  if (!pin || !/^\d{6,12}$/.test(pin)) {
    throw new Error('Set a 6–12 digit STAFF_PIN environment variable before starting the server.');
  }
  const salt=randomBytes(16).toString('hex');
  const pinHash=scryptSync(pin,salt,32).toString('hex');
  db.prepare('INSERT INTO employees(id,username,display_name,role,pin_salt,pin_hash) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(),'manager','Store manager','admin',salt,pinHash);
  if (!process.env.STAFF_PIN) console.warn('DEMO ONLY: manager PIN = 123456. Set STAFF_PIN and reset the demo database before production use.');
}
seedStaff();
