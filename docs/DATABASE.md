# Database reference

Three SQLite files, with different jobs and different trust levels.

| File | Role | Written by |
|---|---|---|
| `server/data/demo-pos.sqlite` | **The shop's till.** Authoritative for catalog, prices, VAT, orders, payments. 19 tables. | `DemoPosStore` only |
| `server/data/kiosk.sqlite` | Kiosk cache, kiosk-only content, in-flight state. Authoritative for nothing. 11 tables. | `KioskStore` only |
| `server/data/coffee-kiosk.sqlite` | Version 3 data. | **Never written.** Opened read-only as an import source. |

All three are git-ignored. Migrations and seed fixtures are committed — they are
code.

## Rules that hold across both schemas

1. **Money is always `INTEGER`, in minor units.** Every column matching
   `_minor`, `price`, `amount` or `balance` is `INTEGER`; a test asserts no
   money column is ever `REAL`.
2. **Prices are VAT-inclusive.** `price_minor` is the gross a customer pays.
   `tax_rate_bp` is basis points (1600 = 16%). VAT is derived, never added.
3. **Foreign keys are enforced** (`PRAGMA foreign_keys = ON` per connection).
4. **WAL journalling**, so the kiosk's 30-second poll never blocks a manager
   saving a price.
5. **Every table has `created_at`**, and mutable ones have `updated_at`.
6. **No card data, ever.** No PAN, CVV, PIN, expiry or track column exists in
   any table, and a test asserts their absence.

## Demo POS schema

### Catalog

| Table | Notes |
|---|---|
| `pos_categories` | Hot, iced, pastries, snacks |
| `pos_products` | `price_minor` VAT-inclusive, `tax_rate_bp`, `available`. IDs look like `PRD-1003`. |
| `pos_modifier_groups` | `min_select` / `max_select` with `CHECK (max_select >= min_select)` |
| `pos_modifiers` | `price_delta_minor`, may be negative; a line can never go below zero |
| `pos_product_modifier_groups` | Which groups apply to which product, and whether required *there* |

Modifier groups are per-product, not global: espresso has no milk group at all,
so ordering oat milk on an espresso is refused by the schema's intent and by
the pricing engine.

### Orders

| Table | Notes |
|---|---|
| `pos_orders` | 28 columns. `client_request_id` **UNIQUE** (idempotency). `channel` distinguishes `kiosk` from imported `legacy_v3`. |
| `pos_order_items` | Name and price **snapshotted** — a later price change must not rewrite history. `product_id` has **no** foreign key, deliberately, so history survives a product being removed. |
| `pos_order_item_modifiers` | Snapshotted modifier names in both languages |
| `pos_payments` | Adapter `reference` and `masked_detail` only |

Order numbering: live orders start at 1001. Imported Version 3 history sits in
a `9xxxxx` band with `V3-` numbers, and the live counter explicitly ignores it
(`WHERE sequence < 900000`) so no customer is ever told to collect order 901002.

### Money, staff, audit

| Table | Notes |
|---|---|
| `pos_gift_cards` | `CHECK (balance_minor >= 0)` — cannot be overdrawn even by a direct `UPDATE` |
| `pos_gift_card_ledger` | Every movement with `balance_after_minor`; written in the same transaction as the balance change |
| `pos_promotions` | `percent` (basis points) or `fixed` (minor units), with `min_subtotal_minor` |
| `pos_users` | scrypt `password_hash` + per-user `password_salt`. Nothing reversible. |
| `pos_sessions` | SHA-256 **digest** of the token, never the token. In SQLite, so a restart does not log staff out. |
| `pos_audit_events` | Every mutation, with actor type, actor ID and timestamp |
| `pos_loyalty_accounts` / `pos_loyalty_transactions` | `UNIQUE (order_id, kind)` prevents double-earning. Home for imported V3 balances; a loyalty adapter fronts these in Phase 2. |

## Kiosk schema

| Table | Notes |
|---|---|
| `kiosk_stores` | Per-store display config, timeout, sync interval |
| `kiosks` | Kiosk registration, orientation, heartbeat |
| `kiosk_menu_cache` | Last good POS snapshot + `menu_version` + `synced_at` |
| `kiosk_sync_state` | Last success, consecutive failures, totals, latency |
| `kiosk_content_overlays` | **Has no price or availability column, by design.** Structurally incapable of overriding the POS. Can hide an item from the kiosk channel only. |
| `kiosk_item_mappings` | Per-store local key → POS product ID |
| `kiosk_quotes` | Server-side quote; the browser only ever holds the ID |
| `kiosk_order_submissions` | 17 columns. `client_request_id` **UNIQUE**. The idempotency ledger *and* the retry queue. `payment_accepted` drives the ops-exception workflow. |
| `kiosk_events` | Structured kiosk log |
| `kiosk_integration_issues` | `UNIQUE(store_id, kind, detail)` with an `occurrences` counter, so a repeating fault is counted rather than flooding |

## Migrations

Forward-only, in `server/database/migrations/{demo-pos,kiosk}/`, applied in
filename order. Each runs in its own transaction, so a failure leaves the schema
untouched.

**An applied migration is immutable.** The runner stores a checksum and refuses
to proceed if a migration that has already run has been edited — editing one is
a classic way to corrupt a schema silently. Add a new file instead.

```bash
npm run db:migrate    # apply pending migrations without starting the server
npm run db:backup     # timestamped copies of all databases, WAL siblings included
```

## Version 3 import

Runs automatically at boot, and is idempotent — a second run imports nothing.

Guarantees:

1. `coffee-kiosk.sqlite` is opened **read-only**.
2. A timestamped backup is taken first, including `-wal` and `-shm` siblings
   (without them a copy can miss recent commits).
3. Keyed on original row IDs, so nothing duplicates.

**Amounts are not converted.** V3 prices are US dollars and the live catalog is
shekels; converting would mean inventing an exchange rate and rewriting what
customers actually paid. Imported orders keep their original amounts with
`currency = 'USD'` and `vat_included_minor = 0`, because V3 had no VAT concept
and claiming one would be fabrication. Reports can then show both honestly.

Legacy option blobs (`{size:'medium', milk:'oat'}`) are translated into real
modifier IDs. A legacy product key with no mapping is **kept** with a note on
the line, never dropped. Legacy idempotency keys are namespaced `v3:` so an
imported key cannot short-circuit a new order.

## Inspecting data

```bash
npm run db:inspect              # Version 3 database (existing V3 script)
sqlite3 server/data/demo-pos.sqlite
```

Read-only queries that do not expose credentials:

```sql
-- Live kiosk orders, newest first
SELECT order_number, created_at, fulfillment, total_minor, currency,
       payment_status, kitchen_status
FROM pos_orders WHERE channel = 'kiosk'
ORDER BY sequence DESC LIMIT 20;

-- What was actually in an order, modifiers included
SELECT i.name_snapshot_en, i.quantity, i.unit_price_minor,
       group_concat(m.name_snapshot_en, ' + ') AS modifiers
FROM pos_order_items i
LEFT JOIN pos_order_item_modifiers m ON m.order_item_id = i.id
WHERE i.order_id = ?
GROUP BY i.id ORDER BY i.line_index;

-- Current menu with VAT split out
SELECT name_en, price_minor,
       price_minor - CAST(ROUND(price_minor * tax_rate_bp / (10000.0 + tax_rate_bp)) AS INTEGER) AS net_minor,
       available
FROM pos_products ORDER BY display_order;

-- Gift-card balances, codes masked (the code is a bearer credential)
SELECT '••••' || substr(code, -4) AS card, balance_minor, currency FROM pos_gift_cards;

-- Loyalty balances, codes masked
SELECT '••••' || substr(code, -4) AS card, points_balance, total_earned FROM pos_loyalty_accounts;

-- Who changed what
SELECT created_at, actor_type, actor_id, event_type, entity_id, payload
FROM pos_audit_events ORDER BY id DESC LIMIT 30;

-- Orders where money moved but no POS order exists: needs a human
SELECT client_request_id, attempts, last_error, payment_reference, created_at
FROM kiosk_order_submissions          -- in kiosk.sqlite
WHERE payment_accepted = 1 AND status != 'submitted';
```

Never `SELECT *` from `pos_users` or `pos_sessions` in a shared context: they
hold password hashes and session digests.

## Looking at the data

### From the terminal

```
npm run db:inspect              summary of both databases
npm run db:inspect -- pos       Demo POS only
npm run db:inspect -- kiosk     kiosk only
npm run db:inspect -- tables    every table with a row count
```

Run a read-only query against both databases:

```
npm run db:inspect -- "SELECT name_en, price_minor FROM pos_products WHERE available = 1"
```

Both files are opened read-only and anything that is not `SELECT`, `WITH` or
`PRAGMA` is refused, so this cannot modify demo data mid-demonstration.
Amounts in `_minor` columns are printed as major units.

`npm run db:inspect:v3` is the old Version 3 inspector. It reads
`coffee-kiosk.sqlite`, which now holds only imported legacy history.

### In VS Code

Install the **SQLite Viewer** extension (`qwtel.sqlite-viewer`), then click
either file in the Explorer:

```
server/data/demo-pos.sqlite
server/data/kiosk.sqlite
```

Tables open as sortable grids. Useful for browsing; the terminal inspector is
better for the joined views above.

### Which database holds what

`demo-pos.sqlite` is the shop's till: products, prices, modifiers, orders,
payments, gift cards, staff, audit trail. It is the source of truth, and in a
real deployment it is replaced by the client's own POS.

`kiosk.sqlite` is our ordering channel: the menu cache, quotes, order
submissions and their retries, payment sessions, receipts, content overlays,
kiosk registrations and sync health. It holds no prices of its own.

The split is physical rather than by convention, so kiosk code cannot read POS
tables even by accident.
