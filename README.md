# Coffee Ordering Kiosk ☕

A **touch-friendly self-service coffee ordering prototype** for a **Windows 10-inch landscape touchscreen**, built with React + Vite + Express. It includes six locally stored AI-generated coffee photos, a customer ordering flow, a barista screen, and a basic admin dashboard.

![Coffee menu example](public/images/latte.webp)

## Pages included

1. Welcome screen — English / Arabic switcher
2. Coffee menu — 6 photo products, Hot / Iced categories, availability
3. Customize — cup size, milk, syrup, sugar, extra shot, quantity, real-time price
4. Cart — editable quantities, remove, totals
5. Checkout — takeaway / dine-in, optional name, **pay at counter only**
6. Confirmation — order number and pickup instructions
7. Kitchen screen — new → preparing → ready → completed; staff can manually record counter payment
8. Admin screen — order totals, paid sales, edit menu prices and availability

## Start on Windows (VS Code 1.147)

Install **Node.js 22 or newer** and Git for Windows.

Option A: double-click `RUN_ON_WINDOWS.bat`.

Option B: open the project folder in VS Code, then **Terminal → New Terminal** (choose Git Bash):

```bash
npm install
npm run dev
```

Open in a browser:

- **Customer kiosk**: http://localhost:5173
- **Kitchen**: http://localhost:5173/?view=kitchen
- **Admin**: http://localhost:5173/?view=admin

The API is available at `http://localhost:3001/api/health`, and Vite proxies `/api/*` to it.

### Test the flow

Start Order → choose Latte → choose size and milk → Add to cart → Checkout → Pay at counter → Place order. Take note of the order number. Open the Kitchen URL in another browser tab to mark preparing, ready, completed, and payment received. Refresh the Admin URL to see the order statistics.

### Fullscreen kiosk

For development, use Microsoft Edge and press **F11**. For deployment, configure Windows kiosk mode and browser/device management separately. Because the screen's resolution is not yet known, this UI uses responsive layout rules and larger touch targets.

## Project structure

```text
coffee-ordering-kiosk/
├── public/images/          Six locally bundled coffee photos (.webp)
├── shared/catalog.js       Seed menu, customization choices, pricing
├── shared/i18n.js          English and Arabic strings
├── src/
│   ├── components/         Reusable controls
│   ├── pages/              Eight fully coded screens
│   ├── api.js              API calls
│   ├── App.jsx             Navigation and cart state
│   ├── config.js           Brand/currency formatting
│   ├── main.jsx            React entry
│   └── styles.css          Responsive touchscreen styles
├── server/
│   ├── index.js            Express REST endpoints
│   └── data/               Menu and order JSON files (ignored by Git)
├── index.html
├── vite.config.js
├── package.json
└── RUN_ON_WINDOWS.bat
```

## Settings

- Shop name: `src/config.js` → `brand`
- Currency: `src/config.js` → `currency` (sample USD only)
- Starting coffee products and demo prices: `shared/catalog.js`
- Generated photos: `public/images/`

The server generates `server/data/products.json` on first run. **After the first run, edit prices in the Admin screen** (changes persist to that JSON file); editing initial prices in `shared/catalog.js` alone will not replace saved prices.

## Backend

Built with Express using file-backed JSON for **prototype use only**. Customer orders are validated and priced by the server, rather than trusting totals calculated by the browser. The API routes include:

```text
GET   /api/health
GET   /api/products
GET   /api/orders
GET   /api/summary
POST  /api/orders
PATCH /api/orders/:id
PATCH /api/products/:id
```

Use `npm run build` to build the site and `npm start` to run the API + built site together at `http://localhost:3001`.

## Security / launch checklist

**This is a functional demo, not payment-ready or deployment-ready.** It has no staff authentication, authorization, transaction processing, device/receipt printer integration, tax calculation, inventory, or secure production database. Admin and kitchen routes are publicly accessible to anyone who can reach the server. Do **not** expose this prototype to the public internet or collect sensitive customer/payment information with it. Only staff who have actually received money should mark an order paid. Add these safeguards before real use.

## Push to GitHub with Git Bash

Your repository: https://github.com/SaraEwaida/coffee-ordering-kiosk

**Recommended if the repository already exists**: clone it first, then copy this project’s files into the cloned folder. This preserves any remote README or commit history.

```bash
# Go to your preferred parent folder; replace this example path:
cd "/c/Users/YOUR_WINDOWS_USERNAME/Documents"
git clone https://github.com/SaraEwaida/coffee-ordering-kiosk.git
cd coffee-ordering-kiosk

# Copy/extract the downloaded project's CONTENTS into this folder (do not copy over .git).
# Then run:
git status
git add .
git commit -m "Build complete coffee kiosk prototype with product photos"
git push -u origin main
```

If your existing remote default branch is not `main`, check `git branch -a` and push the actual branch. If Git asks you to log in, use Git Credential Manager or GitHub authentication; GitHub account passwords are not used for command-line pushes.

## Photos

The six coffee photographs are generated specifically for this project and bundled as local WebP files, so they load even if the kiosk has no internet connection. The UI font may fall back to a system font when offline.
