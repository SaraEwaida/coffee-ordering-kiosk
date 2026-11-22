-- ============================================================================
-- Payment sessions.
--
-- Durable because a payment must survive a browser reload, a kiosk restart and
-- a power cut. A customer who has tapped their card must never be charged
-- twice because the screen refreshed, and an approved payment must never be
-- forgotten because the process died.
--
-- NOTHING in this table is card data. There is no column for a PAN, CVV, PIN
-- or track data, and there never will be: the terminal keeps those, and we
-- store only an outcome, a reference and masked metadata. A test asserts the
-- absence of those columns.
-- ============================================================================

CREATE TABLE kiosk_payment_sessions (
  id                TEXT PRIMARY KEY,
  store_id          TEXT NOT NULL REFERENCES kiosk_stores(id) ON DELETE CASCADE,
  kiosk_id          TEXT,
  quote_id          TEXT REFERENCES kiosk_quotes(id) ON DELETE SET NULL,

  -- The idempotency key of the checkout attempt this payment belongs to.
  -- UNIQUE per attempt: a double tap cannot open a second payment.
  client_request_id TEXT NOT NULL UNIQUE,

  method            TEXT NOT NULL CHECK (method IN ('card_simulated','cash_counter','gift_card')),
  state             TEXT NOT NULL DEFAULT 'created'
                    CHECK (state IN ('created','waiting_for_card','processing',
                                     'approved','declined','cancelled','timed_out',
                                     'failed','voided','unknown')),

  -- Always copied from the server-side quote. Never from the browser.
  amount_minor      INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency          TEXT NOT NULL,

  -- Split payment: what a gift card covered, and what the card must cover.
  gift_card_code       TEXT,
  gift_applied_minor   INTEGER NOT NULL DEFAULT 0 CHECK (gift_applied_minor >= 0),
  card_amount_minor    INTEGER NOT NULL DEFAULT 0 CHECK (card_amount_minor >= 0),

  reference         TEXT,
  masked_detail     TEXT,
  failure_reason    TEXT,

  -- Set by the demo operator panel to force an outcome during a demonstration.
  forced_outcome    TEXT,

  -- When the simulator should advance to its next state. Drives the realistic
  -- tap/insert prompts without a timer living in a browser tab.
  advance_at        TEXT,
  expires_at        TEXT NOT NULL,

  -- True once the order has been created for this payment, so a retry can
  -- never create a second order against the same money.
  order_submitted   INTEGER NOT NULL DEFAULT 0 CHECK (order_submitted IN (0,1)),
  pos_order_id      TEXT,

  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kiosk_payments_state ON kiosk_payment_sessions(state, advance_at);
CREATE INDEX idx_kiosk_payments_created ON kiosk_payment_sessions(created_at DESC);

-- Every state change, so a disputed payment can be reconstructed exactly.
CREATE TABLE kiosk_payment_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  TEXT NOT NULL REFERENCES kiosk_payment_sessions(id) ON DELETE CASCADE,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'system',
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kiosk_payment_events ON kiosk_payment_events(payment_id, id);
