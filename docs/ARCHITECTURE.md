# Architecture

## The rule everything else follows

**The coffee shop's POS is the source of truth.** Menu, item IDs, modifiers,
availability, prices, taxes, order records and order status all belong to it.
The kiosk is a new *ordering channel*, not a replacement POS.

Everything below exists to make that rule enforceable rather than aspirational.

```
  ┌──────────────────────────┐
  │   Customer kiosk (React) │  10" touchscreen, Edge kiosk mode
  └────────────┬─────────────┘
               │  HTTP, /api/kiosk/*   ← the ONLY thing the UI may call
  ┌────────────▼─────────────┐
  │  Standard internal API   │  routes/kiosk.js
  │  ────────────────────────│
  │  CheckoutService         │  quotes, idempotent submission, retry queue
  │  MenuSyncService         │  30 s poll, cache, staleness, ID mapping
  │  KioskStore ─────────────┼──► kiosk.sqlite   (cache, overlays, queue)
  └────────────┬─────────────┘
               │  PosAdapter interface  ← the integration seam
  ┌────────────▼─────────────┐
  │     DemoPosAdapter       │  adapters/pos/DemoPosAdapter.js
  └────────────┬─────────────┘
               │
  ┌────────────▼─────────────┐
  │   Demo POS (the till)    │  demo-pos/store.js, demo-pos/pricing.js
  │   DemoPosStore ──────────┼──► demo-pos.sqlite  (catalog, orders, money)
  │   Staff console          │  /demo-pos/  — authenticated, role-gated
  └──────────────────────────┘
```

## Two databases, on purpose

`demo-pos.sqlite` and `kiosk.sqlite` are separate files.

This is the architecture, not a filing preference. Because they are separate
connections to separate files, kiosk code **cannot** read a POS table even by
mistake — there is no join to accidentally write, no table name to reach for.
Every menu read and order write has to travel through `PosAdapter`.

The payoff is that integrating a real client POS means writing one class. No
route, service, schema or React component changes. The test
`POS and kiosk schemas share no table names` keeps the boundary honest.

| Database | Holds | Authoritative? |
|---|---|---|
| `demo-pos.sqlite` | Catalog, modifiers, prices, VAT, orders, payments, gift cards, staff, audit | **Yes** — stands in for the client's POS |
| `kiosk.sqlite` | Menu cache, kiosk-only photos/descriptions, ID mappings, server-side quotes, submission queue, kiosk events | **No** — cache and in-flight state only |
| `coffee-kiosk.sqlite` | Version 3 data | Read-only import source; never written |

## The POS adapter seam

`server/adapters/pos/PosAdapter.js` defines the contract:

| Method | Purpose |
|---|---|
| `getMenu()` | Full catalog with modifier groups |
| `getAvailability()` | Cheap price/stock delta for frequent polling |
| `calculateQuote(request)` | **The authoritative total.** The POS prices carts, not the kiosk. |
| `validateCouponOrLoyalty(input)` | Promotion / gift-card validation |
| `submitOrder(request)` | Create an order; **must** be idempotent on `clientRequestId` |
| `attachPayment(input)` | Attach a payment outcome; idempotent per reference |
| `getOrderStatus(id)` | Current status |
| `health()` | Reachability and latency |

Two error types, kept strictly apart because they mean opposite things:

- **`PosRejectedError`** — the POS answered and said no (sold out, bad modifier,
  total mismatch). Retrying cannot help. Not counted as an integration failure:
  a shop selling out of oat milk is not a broken connection.
- **`PosIntegrationError`** — the POS could not be reached or answered unusably.
  Retryable, counted against the error rate, drives the offline indicator.

## How a price cannot be set by the browser

A self-service terminal is a public machine, so the total is checked three
times by three different mechanisms:

1. **Quotes live server-side.** `POST /api/kiosk/quotes` asks the POS to price
   the cart, stores the result in `kiosk_quotes`, and returns only an opaque ID.
   The browser never holds a figure that anything trusts.
2. **Re-priced at checkout.** `POST /api/kiosk/orders` re-reads the stored
   quote, re-prices it through the POS, and refuses on any difference — plus
   refuses an expired quote, a consumed quote, or one priced against a
   superseded `menuVersion`.
3. **The POS refuses a mismatch itself.** `expectedTotalMinor` travels with the
   submission and `DemoPosStore.createOrder` re-prices *inside the transaction*
   that writes the order, closing the window where a manager's price change
   could land between quote and insert.

An approved payment must also equal the order total exactly, on both the
create path and the later `attachPayment` path.

## How an order is never lost or duplicated

The kiosk generates a `clientRequestId` before submitting. Then:

- `kiosk_order_submissions.client_request_id` is **UNIQUE**, and the row is
  written **before** the POS is called. A crash between write and confirm leaves
  a pending row the queue retries.
- `pos_orders.client_request_id` is **UNIQUE** too, so the POS deduplicates
  independently. Both sides hold the line.
- A duplicate `POST` finds the original row and returns the original order with
  `duplicate: true`.
- Unreachable POS → `202 Accepted`, `status: "pending"`, and exponential backoff
  capped at 60 s. The UI must not tell a customer "done" on a 202.
- **A submission whose payment was approved is never abandoned**, however many
  attempts fail. It stays retryable and appears in
  `GET /api/ops/exceptions` until a human resolves it.
- If a payment was approved but the cart cannot even be priced, the payment is
  still recorded durably as a stranded payment and the customer is told their
  money moved and to see staff — never "please review your order".

## Money

`shared/money.js` is the only place arithmetic on money happens.

- Every amount is an **integer count of minor units** (agorot for ILS, fils for
  JOD). `assertMinor` throws on a float, so a drifting value fails loudly
  instead of quietly.
- Prices are **VAT-inclusive**. VAT is *extracted* from the gross
  (`gross × rate ÷ (1 + rate)`), never added on top. `netOfGross(g) + vat(g) === g`
  is tested across a range of values.
- A basket discount is attributed back to lines with `distributeProRata`, which
  guarantees the parts sum to the total exactly, so the reported VAT always
  reconciles with the charged total.
- Prices typed by a manager are parsed with `parseMajorToMinor`, never
  `parseFloat`: `"15.05"` must become 1505 agorot, not 1504.

## What is deliberately not built yet

| Area | State |
|---|---|
| Payment simulator state machine | Phase 3. The adapter accepts a payment outcome; nothing generates one yet. |
| Real bank terminals (Arab Bank, Bank of Palestine) | Blocked: needs vendor SDK, unattended certification, test hardware. |
| Printer / device service | Phase 4. No printer code exists; claiming otherwise would be false. |
| Loyalty adapter | Tables exist (`pos_loyalty_*`) and V3 data imports into them. The adapter interface is Phase 2. |
| Config console, multi-tenant | Phase 5. One store is seeded; the schema has `store_id` throughout. |
| Windows kiosk deployment, fleet | Phase 6. |

## Known limitations in what *is* built

- **Rate limiting is per-process and in-memory.** Correct for one kiosk; a
  multi-instance deployment needs a shared store.
- **The Demo POS runs in-process**, so adapter calls are synchronous SQLite
  reads wrapped in promises. A real adapter does HTTP. The interface is async
  precisely so that swap changes no callers.
- **`node:sqlite` is flagged experimental** by Node and prints a warning. It is
  built in, which is why V3 chose it; a future Node release could change it.
- **Staff console is English only.** The bilingual requirement is for the
  customer kiosk; the till is a staff tool.
