# Bloom Rewards + SQL + REST API — beginner guide

This project uses **React** for the touchscreen, **Express** for the HTTP API, and **SQLite** for persistent data. The React frontend **never directly opens the database**. Only the Node.js server reads and writes SQL.

## 1. Start everything in VS Code on Windows

The project folder is `C:\Users\User\Desktop\coffee-ordering-kiosk` if you cloned it to the Desktop.

**PowerShell (`PS C:\...>`):**

```powershell
cd "C:\Users\User\Desktop\coffee-ordering-kiosk"
node -v
npm.cmd install
npm.cmd run dev
```

**Git Bash (`MINGW64`):**

```bash
cd /c/Users/User/Desktop/coffee-ordering-kiosk
npm install
npm run dev
```

Node.js **22.13+** is required for built-in `node:sqlite`. `npm run dev` starts **both** backend Express on port **3001** and frontend Vite on **5173**. The frontend sends `/api/...` calls through Vite's proxy to port 3001.

Open:

- Customer kiosk: http://localhost:5173
- Kitchen (staff login): http://localhost:5173/?view=kitchen
- Admin (staff login): http://localhost:5173/?view=admin
- Server check: http://localhost:3001/api/health
- Coffee JSON: http://localhost:3001/api/products

## 2. Where to see the SQL data

The SQLite database is **created automatically** when the backend first starts:

```text
coffee-ordering-kiosk/
└── server/
    └── data/
        └── coffee-kiosk.sqlite  <-- THIS IS YOUR DATABASE
```

It is a single local SQLite file. You do **not** need to create a database manually or install MySQL/Microsoft SQL Server. It is intentionally excluded from GitHub with `.gitignore`, to avoid leaking customer/order data.

### Option A: See data in VS Code (recommended)

1. Open VS Code **Extensions** (`Ctrl+Shift+X`).
2. Search for **SQLite** and install **SQLite** by **alexcvzz** (extension ID `alexcvzz.vscode-sqlite`).
3. Start the app once to create `coffee-kiosk.sqlite`.
4. Press `Ctrl+Shift+P` and select **SQLite: Open Database**; choose `server/data/coffee-kiosk.sqlite`.
5. Open the SQLite Explorer, select a table, and use **Show Table** / run a query.
6. SQL query example:

```sql
SELECT sequence, payment_status, total_cents / 100.0 AS total_usd,
       loyalty_earned_points, loyalty_redeemed_points
FROM orders ORDER BY created_at DESC LIMIT 20;

SELECT points_balance, total_earned, created_at FROM loyalty_accounts;

SELECT kind, points_delta, created_at
FROM loyalty_transactions ORDER BY id DESC;
```

**Safety:** Inspect in read-only mode whenever possible; editing rows in a live database can break business rules. Keep backup copies with the server stopped (or use a SQLite backup operation) before experiments.

### Option B: Terminal inspection without an extension

In a **second** VS Code terminal (while the API is running):

PowerShell: `npm.cmd run db:inspect`

Git Bash: `npm run db:inspect`

It lists table names and previews data. Member codes are masked in terminal output.

## 3. Database tables

| Table | Example fields | What it is for |
|---|---|---|
| `products` | `id`, `name`, `price_cents`, `available` | Coffee menu and prices |
| `orders` | `sequence`, `total_cents`, `payment_status`, `loyalty_account_id`, `loyalty_discount_cents`, `loyalty_earned_points` | Main orders and loyalty data |
| `order_items` | `order_id`, `product_id`, `quantity`, `options_json` | Each drink in an order |
| `payments` | `order_id`, `method`, `status`, `recorded_by` | Payments verified by employees |
| `employees` | `username`, `role`, `pin_hash` | Demo staff access |
| `events` | `actor_type`, `actor_id`, `event_type` | Employee/customer event log |
| `loyalty_accounts` | `code`, `points_balance`, `total_earned` | Digital customer rewards cards |
| `loyalty_transactions` | `order_id`, `points_delta`, `kind`, `created_at` | Points earned, redeemed, and reversed |

**Money is stored in cents**, so `$6.00` is stored as `600`. Point balances are integers, not dollars.

**The upgrade from Version 2 does not delete existing tables, orders, or payments.** New loyalty tables are created and extra order columns are added automatically the first time Version 3 runs. BACK UP your database before upgrading.

## 4. Loyalty business rules in this demo

- Customer selects **Join Bloom Rewards** in Checkout. A random 20-character card code is generated when the order is placed. A QR code is displayed on order confirmation.
- Customer scans QR code and saves mobile URL `/rewards/CARD_CODE`. They can see the available balance and copy their card code.
- For the next order, select **I already have a rewards card**, enter the card code, and check points.
- **Earn:** `floor(paid order amount in USD)` points (for example, `$6.75` earns `6` points). Points are awarded **only once when an employee records payment received**.
- **Redeem:** `50 points = $5 off` or `100 points = $10 off`, if the cart subtotal is at least that much. Points are reserved immediately when placing the discounted order; the SQL transaction subtracts them.
- Staff **cancel unpaid** orders in Kitchen to release the reserved points; paid orders require a separate refund process not included in this demo.
- The API calculates prices and points on the server. The browser can't set prices or add points directly.
- The manager dashboard shows loyalty account count, total outstanding points, lifetime points earned, and the latest ledger entries with masked codes.

> This is **demo loyalty security**, not real customer authentication. The card code functions as a bearer credential: anyone with it can use its points. For a public, real-money deployment use verified phone OTP or another customer authentication mechanism, stricter rate limiting, HTTPS, more durable employee sessions, fraud controls, refunds and privacy policies. A phone number is **not** collected/stored by this demo. No SMS is sent.

## 5. What is an API? How did we create ours?

An API is an address that other applications can send HTTP requests to. For example, React calls:

```js
// Frontend: src/api.js
const products = await fetch('/api/products').then(r => r.json());
```

Express handles it in `server/index.js`, queries SQLite, and returns JSON:

```js
// Backend example — existing code in server/index.js
app.get('/api/products', (_req, res) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY rowid').all();
  res.json(rows.map(productFromDb));
});
```

An API endpoint is made of **HTTP method + path + handler**. Examples:

| Method | Endpoint | Request/response | Access |
|---|---|---|---|
| GET | `/api/health` | Server/DB status | Public |
| GET | `/api/products` | Menu array | Public |
| POST | `/api/orders` | Place order, rewards choice | Public kiosk |
| GET | `/api/loyalty/accounts/:code` | Balance for a private card code | Card-code holder |
| GET | `/api/loyalty/overview` | Loyalty manager summary | Employee admin token |
| POST | `/api/staff/login` | Username + PIN → token | Staff |
| PATCH | `/api/orders/:id` | Staff status / confirmed payment | Staff token |
| GET | `/api/receipts/:token` | Updated phone receipt | Private receipt token |

You can also open **`examples/queries.sql`** for ready-to-run read-only SQL and **`examples/api-examples.http`** for a REST Client request collection.

### Test the API with your browser

While `npm run dev` is running, open:

- http://localhost:3001/api/health
- http://localhost:3001/api/products

You will see **JSON**. That's your API responding!

### Test POST /api/orders in VS Code PowerShell

This creates a new **unpaid** sample order with a new rewards card:

```powershell
$body = @{
  customerName = "Test"
  fulfillment = "takeaway"
  paymentMethod = "counter"
  joinRewards = $true
  items = @(@{
    productId = "latte"
    quantity = 1
    options = @{ size = "medium"; milk = "regular"; syrup = "none"; sugar = 0; extraShot = $false }
  })
} | ConvertTo-Json -Depth 7
Invoke-RestMethod -Uri http://localhost:3001/api/orders -Method Post -ContentType 'application/json' -Body $body
```

The response contains `number`, `receiptToken`, and `loyaltyCode`. Save `loyaltyCode` somewhere private to test the member lookup. For example:

```powershell
Invoke-RestMethod http://localhost:3001/api/loyalty/accounts/YOUR_20_CHARACTER_CODE
```

### Test GET with Git Bash

```bash
curl http://localhost:3001/api/products
```

### Example of the employee payment API

The kitchen screen does this for you, but the HTTP steps are:

1. `POST /api/staff/login` with JSON `{"username":"manager","pin":"123456"}` in development to get `accessToken`.
2. `PATCH /api/orders/ORDER_UUID` with `Authorization: Bearer ACCESS_TOKEN` and JSON `{"paid":true}`.
3. The same SQLite transaction marks the payment paid, credits the points, and creates a loyalty ledger entry.

Do not mark payment as paid before receiving verified money. **Visa/Mastercard payments in this version are at an external counter terminal, not in the kiosk.**

## 6. How to add your own new API endpoint

Example: counting products. Add this to `server/index.js` BEFORE the static-file and error-handling middleware:

```js
app.get('/api/products/count', (_req, res) => {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM products').get();
  res.json({ count });
});
```

**Important:** Put this route before `app.get('/api/products/:id')` if you add that general route later; Express matches routes in order.

Restart the API and open `http://localhost:3001/api/products/count`. You should see `{"count":6}` if all six demo drinks are still stored.

## 7. Where the code lives

```text
src/pages/Checkout.jsx         Loyalty choice + redemption UI
src/pages/Confirmation.jsx     QR code after placing order
src/pages/RewardsCard.jsx      Mobile digital rewards card
src/pages/RewardsLookup.jsx    Check points from welcome screen
src/pages/Admin.jsx            Loyalty metrics and events
src/api.js                     Frontend fetch requests
server/index.js                All backend REST API endpoints
server/db.js                   SQLite schema, migration, SQL helpers
server/inspect-db.js           Local read-only database preview
shared/i18n.js                 English + Arabic screen text
```

## 8. Update GitHub (without your real customer data)

From a VS Code **Git Bash** terminal opened in your repository:

```bash
git status
git add .
git commit -m "Add Bloom Rewards loyalty system and SQLite API"
git push origin main
```

`node_modules/`, `.env`, `server/data/*.sqlite` and generated SQLite WAL files are ignored. Do not upload passwords, customers' private card codes, payment data or database copies to GitHub.
