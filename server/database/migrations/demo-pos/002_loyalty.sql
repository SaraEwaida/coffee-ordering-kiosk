-- ============================================================================
-- Bloom Rewards tables.
--
-- Version 3 built loyalty directly into the kiosk application. That assumed
-- every client uses OUR loyalty database, which is wrong: a coffee shop with
-- an existing loyalty programme will want its own. So loyalty lives here, in
-- the shop's own systems, and Phase 2 puts a LoyaltyAdapter in front of it —
-- the same shape as the POS adapter — so a client's programme can replace it.
--
-- These tables exist now, in Phase 1, so Version 3 reward balances have a
-- home and are not lost during the import.
-- ============================================================================

CREATE TABLE pos_loyalty_accounts (
  id             TEXT PRIMARY KEY,
  -- A private bearer credential: possession lets the holder claim a discount.
  -- Never logged, never returned in full by any API (last 4 only).
  code           TEXT NOT NULL UNIQUE,
  points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  total_earned   INTEGER NOT NULL DEFAULT 0 CHECK (total_earned >= 0),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE pos_loyalty_transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL REFERENCES pos_loyalty_accounts(id) ON DELETE RESTRICT,
  order_id      TEXT,
  points_delta  INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('earned','redeemed','reversal','adjust')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Carried over from V3: one earn and one redeem per order, so a replayed
  -- request can never award points twice.
  UNIQUE (order_id, kind)
);
CREATE INDEX idx_pos_loyalty_tx_account ON pos_loyalty_transactions(account_id, id DESC);

-- Points redeemed against an order, recorded on the order itself.
ALTER TABLE pos_orders ADD COLUMN loyalty_account_id TEXT REFERENCES pos_loyalty_accounts(id);
ALTER TABLE pos_orders ADD COLUMN loyalty_redeemed_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_orders ADD COLUMN loyalty_earned_points INTEGER NOT NULL DEFAULT 0;

-- Where an order came from when it was not placed on a kiosk. Imported V3
-- history is tagged 'legacy_v3' so demo reports can tell real kiosk orders
-- from migrated ones.
ALTER TABLE pos_orders ADD COLUMN source_note TEXT NOT NULL DEFAULT '';
