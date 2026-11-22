# SQLite database + REST API

The application creates `server/data/coffee-kiosk.sqlite` with SQLite via Node.js `node:sqlite`. No separate SQL Server installation is needed for this **single-location local prototype**.

## Database tables

| Table | Main fields | Purpose |
|---|---|---|
| `products` | `id`, `name`, `price_cents`, `available` | Menu and server-side authoritative prices |
| `orders` | `id`, `sequence`, `status`, `payment_method`, `payment_status`, `receipt_token`, `total_cents` | Every customer order |
| `order_items` | `order_id`, `product_id`, `options_json`, `quantity`, `unit_price_cents` | Items and customizations in each order |
| `payments` | `order_id`, `method`, `status`, `amount_cents`, `recorded_by` | Payment state and staff member who recorded payment |
| `employees` | `id`, `username`, `role`, `pin_salt`, `pin_hash` | Local demo employee accounts with salted PIN hashes |
| `loyalty_accounts` | `id`, `code`, `points_balance`, `total_earned` | Private digital loyalty cards; no customer phone number stored |
| `loyalty_transactions` | `account_id`, `order_id`, `kind`, `points_delta` | Atomic earn/redeem/reversal point ledger |
| `events` | `actor_type`, `actor_id`, `event_type`, `entity_type`, `entity_id`, `details_json`, `created_at` | Audit trail for order placement, menu edits, employee login, order status, payment received |

Version 3 adds `orders.loyalty_account_id`, `loyalty_redeemed_points`, `loyalty_discount_cents`, `loyalty_earned_points`, and `subtotal_cents`. SQLite migration preserves previous orders. See [LOYALTY_API_GUIDE.md](./LOYALTY_API_GUIDE.md) for real examples.

## Data flow

```text
Touchscreen React UI → Express REST API → SQLite database
                                         ↘ Kitchen + Admin UI (staff token required)
Customer phone QR → /receipt/<unguessable-token> → GET /api/receipts/:token
```

## API reference

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/loyalty/accounts/:code` | Card code | Read rewards balance for private card code |
| GET | `/api/loyalty/overview` | Admin token | Loyalty totals and recent entries |
| GET | `/api/health` | Public | Health check |
| GET | `/api/products` | Public | Available menu and prices |
| GET | `/api/config` | Public | Configured receipt origin |
| POST | `/api/orders` | Public | Create order (server-calculated total), including `paymentMethod: 'counter' \| 'card_terminal'` |
| GET | `/api/receipts/:token` | Receipt token | Customer's receipt and current payment/order state |
| POST | `/api/staff/login` | Username and PIN | Employee session token |
| POST | `/api/staff/logout` | Bearer token | Log out |
| GET | `/api/orders` | Bearer token | Latest 200 orders for kitchen |
| PATCH | `/api/orders/:id` | Bearer token | Set status and/or mark verified payment paid |
| GET | `/api/summary` | Bearer token | Order and payment totals |
| PATCH | `/api/products/:id` | Admin token | Change product price or availability |
| GET | `/api/events` | Admin token | Latest 100 audit events |

The customer API accepts a `requestKey` to reduce accidental duplicate submissions. Statuses: `new`, `preparing`, `ready`, `completed`. Payment statuses: `pending` and `paid`. All money is stored as **integer cents**.

**Payment rules:** `card_terminal` means the customer still pays using an **external POS terminal at the counter**; placing the order is **not** a successful electronic payment. Staff should mark it paid only after the terminal confirms payment. No card data is ever entered, saved or processed by this software.

### Example SQL queries

Open `server/data/coffee-kiosk.sqlite` with a SQLite viewer or `sqlite3` CLI. Examples:

```sql
SELECT sequence, created_at, payment_method, payment_status, total_cents / 100.0 AS total_usd
FROM orders ORDER BY created_at DESC LIMIT 20;

SELECT event_type, actor_type, actor_id, created_at
FROM events ORDER BY id DESC LIMIT 30;

SELECT p.method, p.status, p.amount_cents / 100.0 AS amount_usd,
       e.display_name AS recorded_by
FROM payments p LEFT JOIN employees e ON e.id = p.recorded_by;
```

The database file is intentionally ignored by Git; make backups separately. To change the manager PIN use `npm run staff:reset-pin` with a securely configured `STAFF_PIN`.
