# Bean & Bloom Kiosk — Development Plan

Status vocabulary, used strictly:

| Mark | Meaning |
|---|---|
| **Implemented + tested** | Code exists and an automated test or a recorded manual run proves it works. |
| **Implemented, untested** | Code exists; no test proves it. Not finished. |
| **Unverified** | Claimed somewhere but not confirmed by inspection. |
| **Not started** | No code. |
| **Blocked** | Needs a vendor SDK, hardware, or credentials we do not have. |

Nothing is marked tested without a test result recorded in `IMPLEMENTATION_LOG.md`.

---

## Phase 0 — Audit, run, baseline — **complete**

### What the audit found

The GitHub repository was **one version behind**. It held the earlier
JSON-file prototype (769 lines, single commit); Version 3 existed only as a
local zip and had never been pushed. Version 3 has now been committed, so the
remote matches the real code.

Version 3, verified by inspection and by running it:

| Area | Finding |
|---|---|
| Storage | Real SQLite via `node:sqlite`. Prices stored as **integer cents**. |
| Staff auth | scrypt-hashed PINs, `timingSafeEqual`, login throttling, `requireStaff`/`requireAdmin` on all staff routes. |
| Idempotency | `orders.request_key UNIQUE`; a repeat POST returns the original order. **Verified by running it.** |
| Loyalty | Points awarded only after staff verifies payment; `UNIQUE(order_id, kind)` prevents double-earn; reversal on eligible cancellation. |
| Receipts | QR digital receipts behind unguessable tokens; receipt payload excludes staff and internal IDs. |
| Migrations | V2 `ALTER TABLE` upgrade and a legacy JSON importer, both non-destructive. |
| Safety refusals | Payment reversal blocked; cancelling a paid order blocked. |

The previous commit on `main` had `PATCH /api/products/:id` and
`PATCH /api/orders/:id` **completely unauthenticated**. Version 3 fixes this.
Anyone still running the old prototype should stop doing so.

### Baseline test results (recorded, not assumed)

| Check | Result |
|---|---|
| `npm install` | 153 packages, 0 vulnerabilities |
| `npm run build` | Passes, 1599 modules, ~1.9 s |
| `node server/index.js` | Starts; `/api/health` returns `{"ok":true,"database":"sqlite"}` |
| `GET /api/orders` without token | **401** (correct) |
| Staff login | Returns a 43-char bearer token |
| `POST /api/orders` | Creates order 1001 |
| Repeat POST, same `requestKey` | Returns order 1001 again — no duplicate |
| Automated tests | **None existed.** No `test` script, no test files. |

### Weaknesses carried into the plan

1. **Staff sessions live in an in-memory `Map`** — every API restart logs out
   all staff. Must become durable.
2. **No VAT anywhere**, and the API converts cents to float dollars at its
   boundary (`dollars()`/`cents()`), reintroducing float money in transit.
3. **Drink options are an opaque JSON blob** (`options_json`) with no modifier
   IDs and no min/max rules — a real POS cannot consume this.
4. **Currency is USD**; the Palestine demo needs ILS with VAT-inclusive prices.
5. **Single database, single app** — no separation between "the shop's POS" and
   "the kiosk channel", which is the whole architecture this project needs.
6. **No automated tests at all.**

---

## Phase 1 — Demo POS, SQLite, standard API — **complete and tested**

Design decision: **two separate SQLite files.** `demo-pos.sqlite` stands in for
the client's POS; `kiosk.sqlite` holds only cache, kiosk-only presentation and
in-flight state. The separation is physical, so kiosk code *cannot* read POS
tables even by accident, and swapping `DemoPosAdapter` for a real client POS
adapter touches no route, service or component. `coffee-kiosk.sqlite` (V3) is
read as an import source and never written to.

| # | Item | Status |
|---|---|---|
| 1.1 | `shared/money.js` — integer minor units, VAT-inclusive extraction, exact pro-rata | Implemented + tested (22 tests) |
| 1.2 | Migration runner — forward-only, checksummed, immutable applied migrations | Implemented + tested |
| 1.3 | Demo POS schema — 19 tables: catalog, modifier groups with min/max, VAT-inclusive prices, gift cards, promos, orders, items, item modifiers, payments, users, sessions, audit, loyalty | Implemented + tested |
| 1.4 | Kiosk schema — 11 tables: menu cache, sync state, content overlays, per-store ID mappings, server-side quotes, durable submission queue, events, integration issues | Implemented + tested |
| 1.5 | Structured logging with secret redaction | Implemented + tested |
| 1.6 | Consistent error model with stable codes | Implemented + tested |
| 1.7 | Seed: 6 coffees + 4 pastries + 2 snacks, 6 modifier groups, VAT config, gift cards, promos | Implemented + tested |
| 1.8 | Non-destructive V3 import (products, orders, items, modifiers, payments, loyalty) | Implemented + tested (13 tests) |
| 1.9 | `PosAdapter` interface with typed contract and two distinct error types | Implemented + tested |
| 1.10 | `DemoPosAdapter` — menu, availability, quote, submit, payment, status, health, metrics | Implemented + tested |
| 1.11 | Kiosk standard API + 30 s menu sync with stale/offline indicators | Implemented + tested |
| 1.12 | Server-side quotes; browser totals never trusted (three independent checks) | Implemented + tested |
| 1.13 | Idempotent submission + durable retry queue surviving restart | Implemented + tested (14 tests) |
| 1.14 | Adapter health, error rate, latency tracking | Implemented + tested |
| 1.15 | Demo POS manager + kitchen console, authenticated and role-gated | Implemented; **API tested, UI not driven by a browser test** |
| 1.16 | Automated tests | **168 tests, 168 passing** |
| 1.17 | `docs/ARCHITECTURE.md`, `docs/API.md`, `openapi.yaml`, `docs/DATABASE.md`, `docs/TESTING.md`, `docs/WINDOWS_KIOSK_SETUP.md` | Implemented |

### Phase 1 acceptance criteria — all verified on a running server

- [x] Change Cappuccino price in Demo POS → kiosk shows it (1500 → 1850; `menuVersion` changed)
- [x] Mark Latte sold out → kiosk refuses to order it; stale cart revalidated and refused
- [x] Place kiosk order → appears **exactly once** in Demo POS and kitchen, correct modifiers and total (63.00 ILS, VAT 8.69)
- [x] Restart API → data persists
- [x] Repeat submission → no duplicate order
- [x] Overlay cannot change price or availability (enforced *structurally*: no such column exists)
- [x] Unmapped item detected and logged, not silently ordered

Beyond the stated criteria, also verified: `SIGKILL` mid-flight recovers and
confirms exactly one order; a staff session survives a restart; an underpayment
is refused; an approved payment that cannot become an order is recorded and
escalated rather than lost.

### Defects found by running the code and fixed in this phase

1. New orders numbered **901002**, continuing from the imported V3 band.
2. Imported V3 history appeared on the live kitchen screen.
3. **A payment of 19.00 was attached to a 22.00 order and marked paid.**
4. **An approved payment could be stranded with no record anywhere.**
5. A paying customer was told to "review your order" after their money moved.
6. `/api/ops/exceptions` exposed payment references with no authentication.
7. `.gitignore` negation order broke `.env.example`.
8. Unescaped interpolation in HTML attributes in the staff console.

Full detail in `IMPLEMENTATION_LOG.md`.

### Carried into Phase 2

| Item | Why it is not Phase 1 |
|---|---|
| **The kiosk React UI still calls the V3 API** | Rewiring the UI is Phase 2. Both apps run side by side: V3 on 3001, the platform on 4001. Nothing working was removed. |
| Loyalty adapter interface | Tables exist and V3 balances import into them; fronting them with an adapter is Phase 2 item 8. |
| No browser/E2E test | Phase 7 builds the UI test layer. |

## Phase 2 — Customer ordering screens — *partly complete*

The kiosk UI now talks to the Phase 1 API. Prices are shekels, VAT-inclusive,
and the bakery and snacks appear, because the catalog comes from the POS rather
than a hardcoded file.

| # | Item | Status |
|---|---|---|
| 2.1 | Branded welcome screen with language selector | Implemented + tested |
| 2.2 | Dine-in / takeaway, configurable per store | Implemented + tested |
| 2.3 | Catalog with POS categories, photos, calories, allergens | Implemented + tested |
| 2.4 | Required and optional modifiers with min/max validation | Implemented + tested |
| 2.5 | Cart with quantity, remove, customization summaries | Implemented + tested |
| 2.6 | POS-backed upselling rules | **Not started** |
| 2.7 | Promotion / loyalty code entry UI | **Not started** (API exists and is tested) |
| 2.8 | Bloom Rewards behind a loyalty adapter | **Not started** — see regression note below |
| 2.9 | Dine-in surcharge as a distinct line | Implemented + tested |
| 2.10 | VAT-inclusive pricing, VAT shown not added | Implemented + tested |
| 2.11 | Table tent number for dine-in | **Not started** (schema and API support it) |
| 2.12 | Inactivity timeout with warning | Implemented, **not browser-tested** |
| 2.13 | Confirmation with POS order number | Implemented + tested; **QR receipt missing** |
| 2.14 | Arabic/English parity, RTL, ILS formatting | 164/164 keys, **layout not browser-verified** |
| 2.15 | Responsive 10" landscape / 10" portrait / 27" portrait | CSS written, **not verified on hardware** |
| 2.16 | Understandable errors and recovery paths | Implemented + tested |

### Deliberate regressions, to be restored

Moving the UI onto the new API removed three Version 3 features. None is lost
work — each is superseded or scheduled — but none should be described as
present today.

| Removed | Why | Restored in |
|---|---|---|
| `Kitchen.jsx`, `Admin.jsx`, `StaffGate.jsx` | These put staff controls inside the customer bundle, reachable at `?view=kitchen`. The brief requires staff screens to be a separate authenticated application, which the Demo POS console now is. | Already replaced, and better |
| `Receipt.jsx` — QR digital receipt | Needs a receipt token on the new order model and a phone-reachable URL. | Phase 4 |
| `RewardsCard.jsx`, `RewardsLookup.jsx` — Bloom Rewards entry | Rewards are being moved behind a loyalty adapter so a client's own programme can replace ours. The **data is preserved** in `pos_loyalty_*` and imports from V3. | Phase 2.8 |

### Phase 2 acceptance — partly met

- [x] A customer can complete a 2–3 item order in both languages
- [x] Totals match the POS quote exactly
- [x] Bakery and snacks orderable, reaching the barista with modifiers
- [ ] No UI overflow on 10" landscape, 10" portrait, 27" portrait — **unverified without hardware or a browser test**

---

## Phase 3 — Payment simulator, gift cards, recovery — **complete and tested**

| # | Item | Status |
|---|---|---|
| 3.1 | `PaymentAdapter` contract and deterministic `SimulatorPaymentAdapter` with the full state machine | Implemented + tested |
| 3.2 | Realistic tap / insert / swipe prompts, bilingual, no card data in the browser | Implemented; **not browser-tested** |
| 3.3 | Authenticated demo operator panel to force any outcome | Implemented + tested |
| 3.4 | Card brands shown as **simulated**, no fictional authorization codes | Implemented + tested |
| 3.5 | Cash at counter: unpaid POS order, only staff can mark it received | Implemented + tested |
| 3.6 | Gift cards: validate, redeem atomically, split payment, rollback on failure | Implemented + tested |
| 3.7 | Payment outcome and reference persisted and attached to the POS order | Implemented + tested |
| 3.8 | Declines, cancels, timeouts, double taps, reloads, restarts without double charge | Implemented + tested |
| 3.9 | Approved-then-POS-failure: durable, retried, escalated | Implemented + tested (Phase 1 path) |
| 3.10 | Arab Bank / Bank of Palestine stubs, clearly not implemented | Implemented + tested |

### The state machine

```
created ──▶ waiting_for_card ──▶ processing ──▶ approved
                   │                   ├──────▶ declined
                   │                   ├──────▶ failed
                   ├──▶ timed_out      └──────▶ unknown  ← needs a human
                   └──▶ cancelled
```

`unknown` is the reason this is a state machine and not a boolean. A terminal
can stop answering after the card was presented but before the outcome is
known. Calling that a decline risks serving an unpaid order; calling it an
approval gives coffee away. It is its own state, it is **never auto-resolved**,
and it goes to the operator exception list with a message telling the customer
to speak to staff *before paying again*.

Two further rules the tests enforce:

- **Cancellation is refused once processing starts.** At that point the
  acquirer may already hold the authorisation, so letting a customer "cancel"
  would be a lie.
- **A gift card is not debited until the money is actually taken.** A customer
  who walks away at the card prompt is never left out of pocket, and a declined
  card leg leaves the balance untouched.

### Phase 3 acceptance — met

- [x] Approve, decline, cancel, timeout each behave correctly and distinctly
- [x] Gift-card split payment reconciles to one correct POS order
- [x] Cash creates an unpaid order; only authenticated staff can settle it
- [x] POS failure after approval is durable, retried and escalated
- [x] Recovery after restart, with exactly one order
- [x] Duplicate submission prevented at both the payment and the order layer

---

## Phases 4–7 — not started

Scope is fixed by the project brief; no code yet. Listed so status stays honest.

| Phase | Summary | Status |
|---|---|---|
| 4 | Local device service, printer adapter, 80 mm receipts, QR digital receipts | Not started |
| 5 | Config console, branding, multi-tenant isolation, rebrand without code edits | Not started |
| 6 | Windows kiosk deployment, provisioning, fleet health, offline policy | Not started |
| 7 | Security hardening, full test suite, provider integration checklists | Not started |

### Known blockers requiring external resources

| Blocker | Needed before it can be built |
|---|---|
| Arab Bank / Bank of Palestine card terminals | Vendor SDK docs, unattended-mode certification, test terminal |
| Zebra receipt printer | Exact model, Windows driver, confirmation of Arabic glyph support |
| SMS / WhatsApp / email receipts | A contracted provider and a guest consent model |
| Real client POS integration | Endpoint docs, credentials, item/modifier ID export |
| Cloud hosting / TLS | Hosting decision and domain |

These stay explicit adapters with documented stubs. They are **not** simulated
and then described as working.
