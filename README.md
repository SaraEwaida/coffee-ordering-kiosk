# Coffee Ordering Kiosk — Bean & Bloom

A self-service coffee ordering kiosk for a **Windows 10-inch touchscreen**,
built as an in-house proof of concept to show prospective coffee-shop clients
in Palestine. It runs with no physical POS, card reader or printer by using a
Demo POS and simulators.

**Core rule:** the client's POS is the source of truth for menu, prices,
availability, taxes and order records. The kiosk is a new *ordering channel*,
not a replacement POS. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Two applications in this repository

```bash
npm install
npm run dev           # vite (5173) + the kiosk platform (4001)
npm test              # 271 tests
```

The kiosk UI talks to the platform API on 4001. The Version 3 Express API is
still in the repository and still runs (`npm run dev:v3-api`) for reference and
for its data, but it no longer has screens: the React UI moved onto the new API
in Phase 2.

| What | URL |
|---|---|
| Customer kiosk | http://localhost:5173 |
| **Demo POS staff console** | http://localhost:4001/demo-pos/ |
| Kiosk menu API | http://localhost:4001/api/kiosk/menu |
| Kiosk health | http://localhost:4001/api/kiosk/health |
| Ops exceptions (manager auth) | http://localhost:4001/api/ops/exceptions |

### Set passwords before first run

Without these, development builds create till accounts with **known default
passwords** and warn loudly on every boot. The app refuses to start in
production without them.

```powershell
$env:POS_MANAGER_PASSWORD = "choose-something-long"
$env:POS_BARISTA_PASSWORD = "choose-something-else"
$env:STAFF_PIN = "654321"          # Version 3 app only
```

See [`.env.example`](.env.example).

**These apply only when the accounts are first created.** To change a password
afterwards, use one of:

| Situation | How |
|---|---|
| You know your password | Staff console → **My account** → Change my password |
| A barista forgot theirs | Sign in as manager → **My account** → Reset someone else's password |
| **Nobody can sign in** | `npm.cmd run pos:password -- manager` and type a new one |

Changing a password signs out every session for that account immediately — if
a password is being changed because it may have leaked, leaving old sessions
alive would defeat the point. Minimum 10 characters, and not only digits.

---

## Feature status

Honest status. "Tested" means an automated test or a recorded run proves it.

### Working and tested

| Feature | Notes |
|---|---|
| Demo POS as a separate database and application | Catalog, modifiers with min/max, VAT-inclusive prices, gift cards, promotions, orders, payments, staff, audit |
| POS adapter seam | One class to replace for a real client POS |
| Standard kiosk API | The React UI's only entry point; cannot change a price |
| 30-second menu sync | With stale, offline and retry indicators |
| Server-side pricing | Three independent checks; a browser cannot set a total |
| Idempotent orders | Duplicate POST returns the original; UNIQUE on both sides |
| Durable retry queue | Survives `SIGKILL`; a paid order is never abandoned |
| Ops exceptions | Approved payment with no order reaches a human |
| VAT-inclusive money in integer minor units | ILS default; VAT extracted, never added |
| Role-gated staff console | Manager vs barista, with an audit trail |
| Staff sessions surviving restart | Version 3 logged everyone out on restart |
| Non-destructive V3 import | Read-only source, timestamped backup, idempotent |
| Bloom Rewards data | Preserved and imported; the customer-facing flow returns in Phase 2.8 |
| Kiosk UI on the new API | Shekels, VAT-inclusive, bakery and snacks, real modifier groups, dine-in surcharge, inactivity timeout, full Arabic parity |
| Sugar-free & light menu | Five items with no added sugar, plus stevia and date-syrup options on every coffee. Calories and allergens shown. |
| Unattended card-reader simulator | Full state machine: tap/insert prompts, approve, decline, timeout, cancel, and a terminal that stops answering |
| Gift cards and split payment | Validated and debited atomically; a declined card leg never consumes the balance |
| Cash at counter | Creates an unpaid order; only authenticated staff can mark cash received |
| Payment operator panel | Force any outcome live, for demonstrating declines and failures on purpose |

### Deliberately not built yet

| Feature | Phase |
|---|---|
| Upselling, promo-code entry, table numbers, Bloom Rewards customer flow | 2 |
| Printer adapter, 80 mm receipts, local device service, QR digital receipts | 4 |
| Config console, branding, multi-tenant isolation | 5 |
| Windows kiosk lockdown, provisioning, fleet console, offline policy | 6 |
| Security hardening, end-to-end tests, provider checklists | 7 |

### Blocked on things we do not have

| Blocker | Needs |
|---|---|
| Arab Bank / Bank of Palestine terminals | Vendor SDK, **unattended-mode certification**, test terminal and cards. The adapters exist and throw rather than pretending — see `server/adapters/payments/BankTerminalStubs.js` for the full blocked-on list. |
| Zebra receipt printer | Model, Windows driver, Arabic glyph confirmation |
| SMS / WhatsApp / email receipts | A contracted provider and a consent model |
| Real client POS | Endpoint docs, credentials, item/modifier ID export |

These stay explicit adapters with documented stubs. **Nothing simulated is
described as working.** No real card is ever charged by this software, and no
card number, CVV, PIN or track data enters or is stored by it.

---

### Removed in Phase 2, and when it comes back

Moving the UI onto the new API deliberately removed three Version 3 screens.
Say so plainly rather than let anyone discover it in a demo:

| Removed | Why | Back in |
|---|---|---|
| Kitchen and Admin screens at `?view=kitchen` | Staff controls sat inside the customer bundle with no authentication. They are now the authenticated Demo POS console. | Already replaced |
| QR digital receipt | Needs a receipt token on the new order model and a phone-reachable URL. | Phase 4 |
| Bloom Rewards join/lookup | Moving behind a loyalty adapter so a client's own programme can replace ours. **No data is lost** — balances import into `pos_loyalty_*`. | Phase 2.8 |

## Documentation

| Document | Covers |
|---|---|
| [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) | Phases, status, acceptance criteria, blockers |
| [`IMPLEMENTATION_LOG.md`](IMPLEMENTATION_LOG.md) | What changed, decisions, defects found, test output |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The POS-is-truth rule and how it is enforced |
| [`docs/API.md`](docs/API.md) · [`openapi.yaml`](openapi.yaml) | Endpoint reference and machine-readable spec |
| [`docs/DATABASE.md`](docs/DATABASE.md) | All three databases, migrations, read-only queries |
| [`docs/TESTING.md`](docs/TESTING.md) | How to run tests, what is covered, **what is not** |
| [`docs/WINDOWS_KIOSK_SETUP.md`](docs/WINDOWS_KIOSK_SETUP.md) | Windows setup; kiosk lockdown is Phase 6 |
| [`DATABASE.md`](DATABASE.md) · [`LOYALTY_API_GUIDE.md`](LOYALTY_API_GUIDE.md) | Version 3 reference, still accurate for that app |

---

# Version 3 app

Everything below documents the Version 3 application, which still runs
unchanged via `npm run dev`.

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
