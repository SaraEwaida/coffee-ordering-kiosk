# Bean & Bloom — Coffee Ordering Kiosk (Version 3)

A responsive self-service coffee kiosk for **Windows touchscreen devices**. Built with React/Vite, Express and a persistent **SQLite** database. It includes six local coffee images and English/Arabic support.

## Features

- **NEW Bloom Rewards:** customers join at checkout or enter a private card code, scan a digital loyalty card QR, earn one point per paid dollar, redeem 50 points for $5 off or 100 points for $10 off. Kitchen can cancel an unpaid order and release reserved points; manager sees loyalty metrics.
- **NEW built-in SQL inspector:** `npm run db:inspect` shows tables and recent records.
- Beginner guide: [LOYALTY_API_GUIDE.md](./LOYALTY_API_GUIDE.md), including VS Code SQLite viewer, API walkthrough, sample SQL and PowerShell requests.


- Customer: Welcome → Menu → Customize → Cart → Checkout → Confirmation
- Payment choice: **Cash at counter** or **Visa/Mastercard on the shop's card terminal**. Both remain unpaid until an employee verifies the actual payment. **The kiosk does not charge cards.**
- Digital receipt: a QR code on the confirmation screen opens a mobile-friendly receipt link showing the order and its updated payment/preparation status. No paper needed.
- Employee login (demo). Kitchen: view orders, change preparation status, and record verified payments.
- Manager login: see summary, edit prices/availability, and see recent activity.
- SQLite tables: `products`, `orders`, `order_items`, `payments`, `employees`, `events`, `loyalty_accounts`, `loyalty_transactions`. SQL is executed server-side; never from the browser.
- Existing v1 JSON orders/products are imported automatically when a new SQLite DB is created. Keep backups of the original `server/data/*.json` files.

## Run on Windows / VS Code

1. Install **Node.js 22.13 or newer** (the built-in `node:sqlite` module is used).
2. Open the extracted `coffee-ordering-kiosk` folder in VS Code and open **Terminal → New Terminal**.
3. **PowerShell**:
   ```powershell
   cd "C:\Users\User\Desktop\coffee-ordering-kiosk"
   npm.cmd install
   npm.cmd run dev
   ```
   **Git Bash**:
   ```bash
   cd /c/Users/User/Desktop/coffee-ordering-kiosk
   npm install
   npm run dev
   ```
4. Open:
   - Customer: http://localhost:5173
   - Kitchen: http://localhost:5173/?view=kitchen
   - Admin: http://localhost:5173/?view=admin
5. **Developer demo credentials only**: `manager` / `123456` (on a fresh database in development). **Change the PIN before any real trial.**
6. After changes, `Ctrl+C` to stop server. Git Bash:
   ```bash
   git add .
   git commit -m "Add SQLite, digital receipts and card terminal option"
   git push origin main
   ```

> The `npm run dev` command launches both Express (port 3001) and Vite (port 5173), using the Vite `/api` proxy. You do **not** need a separate server terminal.

## Change employee PIN

On Windows PowerShell, in the project folder:

```powershell
$env:STAFF_PIN="654321"  # replace with a private PIN
npm.cmd run staff:reset-pin
Remove-Item Env:STAFF_PIN
```

The manager account lives in SQLite; simply changing an environment variable **after** its creation does not update the PIN. Run the reset script instead. The current demo has no employee account management or password recovery; add them before deployment.

## Phone receipt QR code

1. Open the kiosk confirmation screen after an order.
2. Scan the QR with the customer's phone; the mobile browser displays a digital receipt.
3. **Local testing**: the phone and Windows kiosk must be on the same Wi-Fi/LAN. Allow Windows Firewall access to the Vite port **5173** if prompted. The app tries to detect the PC's LAN IP.
4. If the generated QR link uses the wrong IP, set the environment variable `PUBLIC_RECEIPT_ORIGIN` to `http://YOUR_WINDOWS_LAN_IP:5173` **before launching the dev server**. In PowerShell:
   ```powershell
   $env:PUBLIC_RECEIPT_ORIGIN="http://192.168.1.100:5173"  # replace with actual IP
   npm.cmd run dev
   ```
   Run `ipconfig` to find your local IPv4 address.
5. Production: serve through **HTTPS and a real domain**, configure `PUBLIC_RECEIPT_ORIGIN` accordingly, and add a receipt retention/deletion policy. The QR includes an unguessable access token; treat it as a private link.

**Note:** The QR is a link to an online receipt on the customer's phone, not an SMS, WhatsApp, Apple Wallet pass, or payment receipt from Visa/Mastercard. Sending messages requires a separate SMS/WhatsApp/email provider and customer consent.

## Database and API

- **SQLite file:** `server/data/coffee-kiosk.sqlite` (automatically created); not tracked in Git.
- **Schema + examples:** see [DATABASE.md](./DATABASE.md).
- Server recalculates prices from the product table and drink options. Client totals are never trusted.
- Order creation records a pending payment and `order.created` event.
- Every employee change records a timestamp and employee ID in `events`.
- Internal orders/admin APIs require a staff login token; public receipt access requires a long, random token.
- Existing `products.json` and `orders.json`, if present when the SQLite file is first created, are imported for migration. Do not delete backups before verifying the new data.

## What is NOT implemented yet

**Real online or kiosk card payments:** To charge Visa/Mastercard at the touchscreen, choose a compatible PSP/acquiring bank/EMV-certified terminal, integrate its hosted/terminal SDK and verified webhooks, manage refunds and failed payments, and test transaction reconciliations. Do **not** collect or store card numbers/CVV in this app.

**Production security:** The staff PIN, in-memory sessions and local HTTP server are appropriate only for a controlled demo. Before real customers: use HTTPS, more robust staff identity/permissions, secure device isolation, data protection/retention, backups, input/rate limits, monitoring, EMV/POS payment integration, payment reconciliation and PCI requirements with your provider. Do not expose the local demo server to the public Internet.

## Build to serve from Express

```bash
npm run build
npm run start
```

Open http://localhost:3001 (production-mode pin configuration is required on a **new** database; set `STAFF_PIN` before first run). For a public deployment, use a reverse proxy with HTTPS and explicitly configure a secure public receipt URL.
