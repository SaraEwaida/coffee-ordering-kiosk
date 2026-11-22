-- ============================================================================
-- Kiosk schema — NOT a source of truth.
--
-- A deliberately separate database file from the Demo POS. The separation is
-- the architecture: the kiosk physically cannot read POS tables, so every menu
-- read and order write must go through the POS adapter. Swapping DemoPosAdapter
-- for a real client POS adapter touches no table here.
--
-- Everything here is cache, kiosk-only presentation, or in-flight state.
-- ============================================================================

CREATE TABLE kiosk_stores (
  id                  TEXT PRIMARY KEY,
  name_en             TEXT NOT NULL,
  name_ar             TEXT NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'ILS',
  default_locale      TEXT NOT NULL DEFAULT 'en' CHECK (default_locale IN ('en','ar')),
  dine_in_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (dine_in_enabled IN (0,1)),
  table_number_enabled INTEGER NOT NULL DEFAULT 0 CHECK (table_number_enabled IN (0,1)),
  -- Dine-in surcharge is configured here but always VERIFIED against the POS
  -- quote before payment; the kiosk never invents a charge the POS rejects.
  surcharge_kind      TEXT NOT NULL DEFAULT 'none' CHECK (surcharge_kind IN ('none','fixed','percent')),
  surcharge_value     INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_value >= 0),
  surcharge_label_en  TEXT NOT NULL DEFAULT 'Dine-in service',
  surcharge_label_ar  TEXT NOT NULL DEFAULT 'خدمة الجلوس',
  inactivity_timeout_seconds INTEGER NOT NULL DEFAULT 60 CHECK (inactivity_timeout_seconds BETWEEN 15 AND 600),
  menu_sync_interval_seconds INTEGER NOT NULL DEFAULT 30 CHECK (menu_sync_interval_seconds BETWEEN 5 AND 600),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE kiosks (
  id            TEXT PRIMARY KEY,
  store_id      TEXT NOT NULL REFERENCES kiosk_stores(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  orientation   TEXT NOT NULL DEFAULT 'landscape_10'
                CHECK (orientation IN ('landscape_10','portrait_10','portrait_27')),
  app_version   TEXT NOT NULL DEFAULT 'dev',
  last_heartbeat_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kiosks_store ON kiosks(store_id);

-- Last good menu snapshot from the POS. Lets the kiosk show a menu (flagged
-- stale) when the POS is briefly unreachable instead of showing nothing.
CREATE TABLE kiosk_menu_cache (
  store_id      TEXT PRIMARY KEY REFERENCES kiosk_stores(id) ON DELETE CASCADE,
  payload       TEXT NOT NULL,
  menu_version  TEXT NOT NULL,
  synced_at     TEXT NOT NULL
);

CREATE TABLE kiosk_sync_state (
  store_id              TEXT PRIMARY KEY REFERENCES kiosk_stores(id) ON DELETE CASCADE,
  last_success_at       TEXT,
  last_attempt_at       TEXT,
  last_error            TEXT,
  last_error_at         TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  attempts_total        INTEGER NOT NULL DEFAULT 0,
  failures_total        INTEGER NOT NULL DEFAULT 0,
  last_latency_ms       INTEGER,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Kiosk-only presentation enrichment for a POS product.
-- There is deliberately NO price or availability column here: the overlay
-- cannot override authoritative POS pricing or stock. Enforced by tests.
CREATE TABLE kiosk_content_overlays (
  store_id       TEXT NOT NULL REFERENCES kiosk_stores(id) ON DELETE CASCADE,
  pos_product_id TEXT NOT NULL,
  image_url      TEXT,
  description_en TEXT,
  description_ar TEXT,
  allergens_en   TEXT,
  allergens_ar   TEXT,
  calories       INTEGER CHECK (calories IS NULL OR calories >= 0),
  display_order  INTEGER,
  hidden         INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (store_id, pos_product_id)
);

-- Per-store mapping from a kiosk-local key to the POS's own product ID.
-- A client POS will not use our IDs; an unmapped item must be detected and
-- logged as an integration problem rather than silently ordered.
CREATE TABLE kiosk_item_mappings (
  store_id       TEXT NOT NULL REFERENCES kiosk_stores(id) ON DELETE CASCADE,
  local_key      TEXT NOT NULL,
  pos_product_id TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product','modifier')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (store_id, local_key, kind)
);

-- Server-side price quote. The browser's totals are never trusted: checkout
-- re-reads this row, re-validates it against the POS, and pays THIS total.
CREATE TABLE kiosk_quotes (
  id                 TEXT PRIMARY KEY,
  store_id           TEXT NOT NULL REFERENCES kiosk_stores(id) ON DELETE CASCADE,
  kiosk_id           TEXT,
  request_payload    TEXT NOT NULL,
  quote_payload      TEXT NOT NULL,
  currency           TEXT NOT NULL,
  total_minor        INTEGER NOT NULL CHECK (total_minor >= 0),
  menu_version       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','consumed','expired','invalidated')),
  expires_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kiosk_quotes_store ON kiosk_quotes(store_id, created_at DESC);

-- Durable order-submission record: the idempotency ledger AND the retry queue.
-- client_request_id is UNIQUE, so a duplicate POST can only ever return the
-- original outcome. Rows survive process restart, so an accepted order is never
-- lost because the POS was briefly unreachable.
CREATE TABLE kiosk_order_submissions (
  id                 TEXT PRIMARY KEY,
  client_request_id  TEXT NOT NULL UNIQUE,
  store_id           TEXT NOT NULL REFERENCES kiosk_stores(id) ON DELETE CASCADE,
  kiosk_id           TEXT,
  quote_id           TEXT REFERENCES kiosk_quotes(id) ON DELETE SET NULL,
  payload            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','submitted','failed','abandoned')),
  pos_order_id       TEXT,
  pos_order_number   TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_attempt_at    TEXT,
  next_attempt_at    TEXT,
  -- Set when a payment was accepted but the POS order is not yet confirmed.
  -- Phase 3 drives the ops-exception workflow from this flag.
  payment_accepted   INTEGER NOT NULL DEFAULT 0 CHECK (payment_accepted IN (0,1)),
  payment_reference  TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kiosk_submissions_status ON kiosk_order_submissions(status, next_attempt_at);
CREATE INDEX idx_kiosk_submissions_created ON kiosk_order_submissions(created_at DESC);

CREATE TABLE kiosk_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    TEXT,
  kiosk_id    TEXT,
  level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  event_type  TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kiosk_events_created ON kiosk_events(id DESC);
CREATE INDEX idx_kiosk_events_type ON kiosk_events(event_type, id DESC);

-- Integration problems surfaced to operators: missing ID mappings, rejected
-- orders, totals that disagreed with the POS.
CREATE TABLE kiosk_integration_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  occurrences INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_kiosk_issues_unique ON kiosk_integration_issues(store_id, kind, detail);
