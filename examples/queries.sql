-- Open server/data/coffee-kiosk.sqlite in a VS Code SQLite extension.
-- These examples are READ ONLY.

-- 1. Recent orders
SELECT sequence AS order_no, created_at, customer_name,
       total_cents / 100.0 AS amount_usd, payment_method,
       payment_status, loyalty_earned_points, loyalty_redeemed_points
FROM orders ORDER BY sequence DESC LIMIT 30;

-- 2. All products and their prices
SELECT name, price_cents / 100.0 AS price_usd, available
FROM products ORDER BY name;

-- 3. Digital reward cards (member codes masked)
SELECT '••••' || substr(code, -4) AS card_last4,
       points_balance, total_earned, created_at
FROM loyalty_accounts ORDER BY created_at DESC;

-- 4. Full point history and associated orders
SELECT o.sequence AS order_no,
       '••••' || substr(a.code, -4) AS card_last4,
       t.kind, t.points_delta, t.created_at
FROM loyalty_transactions t
JOIN loyalty_accounts a ON a.id=t.account_id
JOIN orders o ON o.id=t.order_id
ORDER BY t.id DESC LIMIT 100;

-- 5. Pending payments
SELECT o.sequence AS order_no, p.method, p.status,
       p.amount_cents / 100.0 AS amount_usd
FROM payments p JOIN orders o ON o.id=p.order_id
WHERE p.status='pending' ORDER BY o.sequence DESC;

-- 6. Employee and customer activity log
SELECT actor_type, event_type, entity_type, created_at
FROM events ORDER BY id DESC LIMIT 50;

-- 7. Total paid orders and recorded revenue
SELECT COUNT(*) AS paid_orders,
       COALESCE(SUM(total_cents),0)/100.0 AS revenue_usd
FROM orders WHERE payment_status='paid';
