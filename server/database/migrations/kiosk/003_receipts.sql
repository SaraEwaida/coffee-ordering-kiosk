-- Digital receipts for the kiosk ordering channel.
--
-- The token lives on the KIOSK side, not in pos_orders, and that is deliberate.
-- A real client POS will not give us a column for our QR tokens, so storing it
-- there would bake in an assumption that breaks on the first real integration.
-- The kiosk owns the receipt link; the POS owns the order. We keep only the
-- pointer.
--
-- A receipt carries no customer name, phone or payment detail. It is a
-- bearer URL: anyone holding the link can read it, so it holds the minimum
-- needed to prove what was ordered, and it expires.

CREATE TABLE kiosk_receipts (
  token          TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL,
  kiosk_id       TEXT,
  -- The POS order this receipt describes. Receipt content is re-read from the
  -- POS at view time, so a later status change is reflected rather than frozen.
  pos_order_id   TEXT NOT NULL,
  pos_order_number TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at     TEXT NOT NULL,
  -- Lightweight abuse signal: a token being hammered is worth seeing.
  view_count     INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  FOREIGN KEY (store_id) REFERENCES kiosk_stores (id)
);

-- One receipt per POS order: re-issuing must return the existing token rather
-- than minting a second link to the same order.
CREATE UNIQUE INDEX kiosk_receipts_pos_order ON kiosk_receipts (pos_order_id);
CREATE INDEX kiosk_receipts_expiry ON kiosk_receipts (expires_at);
