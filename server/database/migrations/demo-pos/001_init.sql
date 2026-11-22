-- ============================================================================
-- Demo POS — source-of-truth schema.
--
-- This database stands in for the COFFEE SHOP'S OWN POS SYSTEM. The kiosk never
-- opens this file; it reaches everything here through DemoPosAdapter so that a
-- real client POS can replace it by implementing the same adapter interface.
--
-- Money: every *_minor column is an INTEGER count of minor currency units
-- (agorot for ILS). Prices are VAT-INCLUSIVE gross amounts. VAT is derived from
-- the gross, never added on top.
-- ============================================================================

CREATE TABLE pos_store_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE pos_categories (
  id            TEXT PRIMARY KEY,
  name_en       TEXT NOT NULL,
  name_ar       TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE pos_products (
  id             TEXT PRIMARY KEY,           -- stable POS product ID
  sku            TEXT NOT NULL UNIQUE,
  category_id    TEXT NOT NULL REFERENCES pos_categories(id) ON DELETE RESTRICT,
  name_en        TEXT NOT NULL,
  name_ar        TEXT NOT NULL,
  description_en TEXT NOT NULL DEFAULT '',
  description_ar TEXT NOT NULL DEFAULT '',
  price_minor    INTEGER NOT NULL CHECK (price_minor >= 0),   -- VAT-INCLUSIVE
  tax_rate_bp    INTEGER NOT NULL DEFAULT 1600 CHECK (tax_rate_bp BETWEEN 0 AND 100000),
  available      INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  display_order  INTEGER NOT NULL DEFAULT 0,
  -- Image path is a POS-side hint only. Kiosk presentation photos live in the
  -- kiosk overlay table, which must never override price or availability.
  image_hint     TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pos_products_category ON pos_products(category_id, display_order);
CREATE INDEX idx_pos_products_available ON pos_products(available);

-- Modifier groups: "Cup size" (exactly one), "Syrup" (zero to two), etc.
CREATE TABLE pos_modifier_groups (
  id             TEXT PRIMARY KEY,
  name_en        TEXT NOT NULL,
  name_ar        TEXT NOT NULL,
  min_select     INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select     INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (max_select >= min_select)
);

CREATE TABLE pos_modifiers (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES pos_modifier_groups(id) ON DELETE CASCADE,
  name_en           TEXT NOT NULL,
  name_ar           TEXT NOT NULL,
  -- May be negative (e.g. "no milk" discount) but never below the item price.
  price_delta_minor INTEGER NOT NULL DEFAULT 0,
  available         INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  display_order     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pos_modifiers_group ON pos_modifiers(group_id, display_order);

-- Which groups apply to which product, and whether the group is required there.
CREATE TABLE pos_product_modifier_groups (
  product_id    TEXT NOT NULL REFERENCES pos_products(id) ON DELETE CASCADE,
  group_id      TEXT NOT NULL REFERENCES pos_modifier_groups(id) ON DELETE CASCADE,
  required      INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id)
);

CREATE TABLE pos_promotions (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value             INTEGER NOT NULL CHECK (value > 0),  -- basis points, or minor units
  min_subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (min_subtotal_minor >= 0),
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  starts_at         TEXT,
  ends_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE pos_gift_cards (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  balance_minor INTEGER NOT NULL CHECK (balance_minor >= 0),
  currency      TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE pos_orders (
  id                 TEXT PRIMARY KEY,
  order_number       TEXT NOT NULL UNIQUE,
  sequence           INTEGER NOT NULL,
  -- Idempotency: the kiosk generates this before submitting. A retry of the
  -- same submission carries the same value and must not create a second order.
  client_request_id  TEXT UNIQUE,
  channel            TEXT NOT NULL DEFAULT 'kiosk',
  kiosk_id           TEXT,
  store_id           TEXT NOT NULL DEFAULT 'store-demo',
  fulfillment        TEXT NOT NULL CHECK (fulfillment IN ('dine_in','takeaway')),
  table_number       TEXT,
  status             TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','accepted','cancelled','completed')),
  kitchen_status     TEXT NOT NULL DEFAULT 'queued'
                     CHECK (kitchen_status IN ('queued','preparing','ready','served','cancelled')),
  currency           TEXT NOT NULL,
  items_subtotal_minor INTEGER NOT NULL CHECK (items_subtotal_minor >= 0),
  surcharge_minor    INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_minor >= 0),
  discount_minor     INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor        INTEGER NOT NULL CHECK (total_minor >= 0),
  vat_included_minor INTEGER NOT NULL DEFAULT 0 CHECK (vat_included_minor >= 0),
  payment_status     TEXT NOT NULL DEFAULT 'unpaid'
                     CHECK (payment_status IN ('unpaid','authorized','paid','refunded','voided')),
  payment_method     TEXT,
  payment_reference  TEXT,
  promotion_code     TEXT,
  notes              TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pos_orders_kitchen ON pos_orders(kitchen_status, created_at);
CREATE INDEX idx_pos_orders_created ON pos_orders(created_at DESC);
CREATE INDEX idx_pos_orders_payment ON pos_orders(payment_status);

CREATE TABLE pos_order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE,
  product_id       TEXT NOT NULL,
  -- Name and price are snapshotted: a later price change must not rewrite history.
  name_snapshot_en TEXT NOT NULL,
  name_snapshot_ar TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  base_price_minor INTEGER NOT NULL CHECK (base_price_minor >= 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  tax_rate_bp      INTEGER NOT NULL DEFAULT 1600,
  line_index       INTEGER NOT NULL,
  notes            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_pos_order_items_order ON pos_order_items(order_id, line_index);

CREATE TABLE pos_order_item_modifiers (
  id                TEXT PRIMARY KEY,
  order_item_id     TEXT NOT NULL REFERENCES pos_order_items(id) ON DELETE CASCADE,
  modifier_id       TEXT NOT NULL,
  group_id          TEXT NOT NULL,
  name_snapshot_en  TEXT NOT NULL,
  name_snapshot_ar  TEXT NOT NULL,
  price_delta_minor INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pos_item_mods_item ON pos_order_item_modifiers(order_item_id);

CREATE TABLE pos_payments (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE,
  method         TEXT NOT NULL CHECK (method IN ('card_simulated','cash_counter','gift_card')),
  status         TEXT NOT NULL CHECK (status IN ('pending','approved','declined','cancelled','timed_out','failed','voided')),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency       TEXT NOT NULL,
  -- Reference from the payment adapter only. No card number, PAN, CVV, PIN or
  -- track data is ever written here; the kiosk never receives those values.
  reference      TEXT,
  masked_detail  TEXT,
  recorded_by    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pos_payments_order ON pos_payments(order_id);

CREATE TABLE pos_gift_card_ledger (
  id            TEXT PRIMARY KEY,
  gift_card_id  TEXT NOT NULL REFERENCES pos_gift_cards(id) ON DELETE RESTRICT,
  order_id      TEXT REFERENCES pos_orders(id) ON DELETE SET NULL,
  delta_minor   INTEGER NOT NULL,
  balance_after_minor INTEGER NOT NULL CHECK (balance_after_minor >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('issue','redeem','reverse','adjust')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pos_gift_ledger_card ON pos_gift_card_ledger(gift_card_id, created_at);

CREATE TABLE pos_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('manager','barista','readonly')),
  -- scrypt hash + per-user salt. No plaintext or reversible PIN is stored.
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  must_change   INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE pos_sessions (
  token_hash  TEXT PRIMARY KEY,   -- SHA-256 of the bearer token; token is never stored
  user_id     TEXT NOT NULL REFERENCES pos_users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pos_sessions_user ON pos_sessions(user_id);

-- Every mutation records who did it and when.
CREATE TABLE pos_audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('manager','barista','kiosk','system','readonly')),
  actor_id    TEXT,
  event_type  TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pos_audit_entity ON pos_audit_events(entity_type, entity_id, id DESC);
CREATE INDEX idx_pos_audit_created ON pos_audit_events(id DESC);
