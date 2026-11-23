# Implementation log

## 2026-11-22 — Phase 0 and Phase 1

### Environment note

This work was done in a cloud Linux workspace, not in the VS Code project on
the Windows machine. There was no bridge to
`C:\Users\User\Desktop\coffee-ordering-kiosk`, so the GitHub repository was
cloned and the work committed to a branch. Nothing on the Windows machine was
touched. Node 22.23.5, npm 10.9.9.

---

## Phase 0 — audit and baseline

### Finding: the repository was a version behind

`main` held the earlier JSON-file prototype — one commit, 769 lines. Version 3
existed only as `coffee-ordering-kiosk-v3-bloom-rewards.zip` locally and had
never been pushed. Sara supplied the zip; its contents were verified and
committed as `0c5603e`, so the remote now matches the real code.

An initial audit message described the missing features in a way that implied
they had never been built. That was wrong and was corrected: they were built,
just unpushed. Version 3 is a solid foundation — real SQLite, integer cents,
scrypt-hashed staff PINs with `timingSafeEqual`, idempotency via
`orders.request_key UNIQUE`, points awarded only after staff verify payment,
`UNIQUE(order_id, kind)` against double-earning, reversal on cancellation, and
refusals in the right places (payment reversal blocked, cancelling a paid order
blocked).

The previous commit on `main` had `PATCH /api/products/:id` and
`PATCH /api/orders/:id` **completely unauthenticated**. Version 3 fixes this.

### Baseline, measured

| Check | Result |
|---|---|
| `npm install` | 153 packages, 0 vulnerabilities |
| `npm run build` | Passes, 1599 modules, ~1.9 s |
| `node server/index.js` | Starts; health returns `{"ok":true,"database":"sqlite"}` |
| `GET /api/orders` without a token | 401 |
| Staff login | 43-character bearer token |
| `POST /api/orders` | Created order 1001 |
| Same `requestKey` again | Returned order 1001 — no duplicate |
| Automated tests | **None existed** |

### Weaknesses carried forward

1. Staff sessions in an in-memory `Map` — every restart logged out all staff.
2. No VAT, and `dollars()`/`cents()` put float money back on the wire.
3. Drink options an opaque JSON blob with no modifier IDs or min/max rules.
4. USD, where the Palestine demo needs VAT-inclusive ILS.
5. One database, one app — no POS/kiosk separation.
6. No tests.

---

## Phase 1 — Demo POS, adapter, standard API

### Key decision: two separate SQLite files

`demo-pos.sqlite` stands in for the client's till; `kiosk.sqlite` holds cache
and in-flight state only. Because they are separate files on separate
connections, kiosk code *cannot* read a POS table even by accident — there is
no join to write and no table name to reach for. Integrating a real client POS
means writing one adapter class and changing no route, service or component.
The test `POS and kiosk schemas share no table names` keeps it honest.

`coffee-kiosk.sqlite` is opened read-only and never written.

### Files added

| Area | Files |
|---|---|
| Money | `shared/money.js` |
| Database | `server/database/{connection,migrate,importV3}.js`, `migrations/demo-pos/{001_init,002_loyalty}.sql`, `migrations/kiosk/001_init.sql`, `seed/seedDemoPos.js` |
| Demo POS | `server/demo-pos/{store,pricing,auth}.js`, `server/demo-pos/public/index.html` |
| Adapter | `server/adapters/pos/{PosAdapter,DemoPosAdapter}.js` |
| Kiosk services | `server/services/{kioskStore,menuSync,checkout}.js` |
| HTTP | `server/routes/{kiosk,demoPos}.js`, `server/middleware/{errors,rateLimit}.js`, `server/{app,main}.js` |
| Support | `server/lib/{logger,errors,passwords}.js` |
| Tests | 8 files under `server/tests/` |
| Scripts | `scripts/{backup-databases,migrate}.js` |
| Docs | `docs/{ARCHITECTURE,API,DATABASE,TESTING,WINDOWS_KIOSK_SETUP}.md`, `openapi.yaml` |

Roughly 4,500 lines of implementation plus tests.

`server/db` was renamed `server/database` so it would not read confusingly
beside Version 3's `server/db.js`, which still exists and still runs.

### Defects found by running the code, and fixed

These were all found by actually exercising the system, not by reading it.

**1. New orders continued from the imported history band.** The import shifts V3
sequences into a `9xxxxx` band to avoid collision, but `MAX(sequence)+1` then
picked that up and the first new kiosk order was numbered **901002** — a
customer would have been told to collect order 901002. The live counter now
excludes the legacy band (`WHERE sequence < 900000`).

**2. Imported history appeared in the live kitchen queue.** An order closed
months ago showed up on the barista's screen. `listKitchenQueue` now excludes
`channel = 'legacy_v3'`.

**3. A payment of 19.00 was attached to a 22.00 order and marked paid.** The
amount check existed on `attachPayment` but not on the order-creation path, so
a payment arriving *with* the order bypassed it. This is a till discrepancy that
would only surface at cash-up. `createOrder` now validates that an approved
payment equals the order total exactly, and refuses the whole order otherwise.

**4. An approved payment could be stranded with no record at all.** If a card
was approved and the price changed in the next second, pre-flight validation
threw and nothing was written — the customer's money had moved and the system
held no trace. Now, whenever a payment is approved, every rejection path first
writes a durable submission row, records a `paid_order_not_created` integration
issue, and logs a `payment.stranded` event.

**5. The customer-facing message for that case said "please review your
order".** Telling someone to re-pick items after taking their money is the wrong
answer. They now get: *"Your payment went through, but we could not send your
order to the till. Please show a member of staff this reference…"* with the
payment reference, under code `payment_taken_order_failed`.

**6. `/api/ops/exceptions` was unauthenticated** and listed payment references.
Found while writing the API docs. Now behind manager authentication, with tests
asserting 401 for no token, 403 for a barista, 200 for a manager.

**7. `sort -u` on `.gitignore` broke the `!.env.example` negation** by moving it
above the `.env.*` pattern it exempts, which would have stopped anyone getting
the env template. Rewritten by hand with the ordering requirement commented.

**8. Unescaped interpolation in HTML attributes** in the Demo POS console, plus
a `querySelector` built by raw string concatenation. Low risk since the IDs are
system-generated, but closed with `escapeHtml` in attribute position and
`CSS.escape` for the selector.

### Test results

```
Linux    npm test  →  168 tests, 168 pass, 0 fail  (~10.6 s)
Windows  npm.cmd test → 168 tests, 168 pass, 0 fail  (~7.4 s)
```

The first Windows run failed 13 tests in `importV3.test.js`, all `EPERM` on
directory cleanup. The cause was a test-only defect: `freshPosDb()` left a
SQLite connection open, and Windows refuses to unlink a file with a live
handle, with the WAL `-wal`/`-shm` siblings locked too. Every assertion in
those 13 tests had passed; only teardown failed. Fixed by tracking and closing
every handle before removal, with retries for the moment Windows takes to
release one. The suite had until then only ever been run on Linux, which is
why a platform-specific defect reached the target machine.

| File | Tests |
|---|---|
| `orders.test.js` | 30 |
| `api.test.js` | 32 |
| `pricing.test.js` | 27 |
| `money.test.js` | 22 |
| `sync.test.js` | 20 |
| `resilience.test.js` | 14 |
| `importV3.test.js` | 13 |
| `migrations.test.js` | 10 |

Tests use real SQLite files in temp directories, real migrations, real
transactions and real HTTP. Background workers are off so retries are driven
explicitly — no sleeps, no flakes.

### Acceptance scenarios, verified live

Recorded from a running server, not inferred.

| Scenario | Result |
|---|---|
| **A** Change Cappuccino price in the till → kiosk shows it | 1500 → 1850 after sync; `menuVersion` changed |
| **B** Mark Latte sold out → kiosk refuses | `item_unavailable`, "Caffè Latte is sold out."; stale cart revalidated and refused with `menu_changed` |
| **C** Dine-in: 2 large oat lattes + vanilla, plus a warm croissant | Subtotal 61.00, surcharge 2.00, total **63.00 ILS**, VAT inside **8.69**; one order in the till and in the kitchen with all four modifiers |
| Duplicate POST, same `clientRequestId` | Same order number, `duplicate: true`, exactly one row |
| Reusing a consumed quote | 409 `conflict` |
| **G** Payment approved, then till fails | 202 `pending`, ops exception with the payment reference, auto-confirmed ~6 s after recovery, exactly one order marked paid, exception cleared |
| `SIGKILL` mid-flight, then restart | Order recovered and confirmed ~6 s after restart; exactly one order; **staff session survived** |
| Underpaying an order | Refused, `payment_amount_mismatch`, no order created |
| Unauthenticated price change | 401 |
| Barista attempting a price change | 403 |

### Regression checks

Version 3 is unaffected: it still starts, serves 6 products, returns 401 on
staff routes without a token. `npm run build` still passes. `npm run db:migrate`
and `npm run db:backup` both work.

### Outstanding risks

| Risk | Note |
|---|---|
| **The kiosk React UI still talks to the V3 API.** | Phase 2 rewires it. Both apps run side by side meanwhile — V3 on 3001, the platform on 4001. |
| **No browser or E2E test.** | The Demo POS console was verified by API calls and a syntax check, not by driving a browser. |
| **Performance targets are unmeasured.** | Touch < 100 ms and handoff < 3 s are stated goals, not results. |
| **`node:sqlite` is flagged experimental.** | Built in, which is why V3 chose it; a future Node release could change it. |
| **Rate limiting is per-process, in memory.** | Fine for one kiosk; a multi-instance deployment needs a shared store. |
| **No HTTPS.** | The platform binds `0.0.0.0` over plain HTTP. Local trusted network only. |
| **Dev passwords exist when the env vars are unset.** | Warned loudly on every boot; the app refuses to start in production without them. |

### Not done, and not claimed

No payment simulator state machine (Phase 3), no printer or device service
(Phase 4), no config console or multi-tenant work (Phase 5), no Windows kiosk
deployment or fleet console (Phase 6). Real bank terminal adapters remain
blocked on vendor SDKs, unattended-mode certification and test hardware.

### Git

Branch `phase1-demo-pos-architecture`, two commits:

1. `0c5603e` — Version 3 committed from the zip, so the remote matches reality.
2. Phase 1 — this work.

**Nothing pushed.** Awaiting review.


---

## 2026-11-22 — Phase 2 (partial): kiosk UI on the new API

### Why this was needed

After Phase 1 the customer screen was unchanged: still Version 3, still
dollars, still six drinks and no food. Everything built in Phase 1 was
invisible from the kiosk. This phase connects them.

### What changed

| Area | Files |
|---|---|
| Data layer | `src/api.js` rewritten for `/api/kiosk/*`; `src/config.js` now formats integer minor units and takes currency from the server |
| Shell | `src/App.jsx` rewritten: menu polling, cart in POS IDs and modifier IDs, server-quoted totals, idempotent submission |
| Screens | `Menu.jsx` (POS categories), `CustomizeDrink.jsx` (real modifier groups), `Cart.jsx` and new `QuoteSummary.jsx` (server totals), `Checkout.jsx`, `Confirmation.jsx` |
| New | `src/lib/modifiers.js` (pure selection rules), `src/components/IdleWarning.jsx` |
| Config | `vite.config.js` proxies `/api/kiosk` to 4001 ahead of `/api` to 3001 |
| Strings | `shared/i18n.js` — 164 keys, full English/Arabic parity, none identical between languages |

### Decisions worth recording

**Currency is no longer a constant.** `src/config.js` had
`export const currency = 'USD'`. It now comes from `/api/kiosk/config`, which
gets it from the POS, so rebranding for a client is configuration.

**Version 3 prices were not converted.** V3 holds dollar amounts; the new
catalog is priced fresh in shekels. Converting would have meant inventing an
exchange rate and rewriting what customers actually paid.

**Modifier rules moved out of the component** into `src/lib/modifiers.js`.
Node cannot import `.jsx`, which forced the question — and pure rules belong
outside a component anyway. They are now directly tested.

**Three Version 3 screens were removed deliberately**, each recorded in
`DEVELOPMENT_PLAN.md` with the phase that restores it. The staff screens are
already replaced by something better; the QR receipt and the rewards flow are
scheduled, and no rewards data is lost.

### Test results

```
194 tests, 194 passing, 0 failing  (~11 s)
```

26 new tests in `kioskUi.test.js` cover ILS formatting (including that no
dollar sign can appear and that Arabic uses Latin digits), language fallback,
every modifier selection and toggle rule, and the exact payload the screens
build — asserting that the default selection satisfies the POS for *every*
product in the catalog, so no item can be unorderable out of the box.

### Verified by running it

Full journey through the Vite proxy, exactly as the browser does it:

```
Large oat latte + vanilla sugar: 24.50
2x Za'atar Manakish (warm):      14.00
subtotal: 38.50 | dine-in: 2.00
TOTAL:    40.50 ILS  (VAT inside: 5.59)
order: confirmed | number: 1001

Barista queue:
  #1001 | 40.50 ILS | dine_in
     1x Caffè Latte — Oat milk, Large, 1 spoon
     2x Za'atar Manakish — Warm it up
```

### Outstanding risks

| Risk | Note |
|---|---|
| **Nothing in the UI has been opened in a browser.** | There is no browser in this environment. Pure logic is tested; rendering, RTL layout, the idle overlay and touch targets are not. |
| **Responsive layouts are unverified.** | CSS for 10" landscape, 10" portrait and 27" portrait exists; nothing proves it does not overflow. |
| **No upselling, promo entry, table numbers or rewards UI.** | Phase 2 items 6, 7, 8 and 11, all still open. |
| **Food items have no photographs.** | A monogram placeholder is shown. Real photos would need to be supplied. |


---

## 2026-11-22 — Phase 3: payment simulator, gift cards, recovery

### Why a state machine and not a flag

The brief is explicit that "Visa at counter" as a radio button demonstrates
nothing. A real unattended terminal makes the customer wait, can decline, can
time out, and can stop answering halfway. A client will not trust a kiosk with
their money until they have watched each of those paths behave.

The state that justifies the whole design is `unknown`: the terminal stopped
answering after the card was presented but before the outcome was known.
Treating it as a decline risks serving an unpaid order; treating it as an
approval gives coffee away. It is its own state, never auto-resolved, and it
reaches a human.

### Files added

| Area | Files |
|---|---|
| Contract | `server/adapters/payments/PaymentAdapter.js` |
| Simulator | `server/adapters/payments/SimulatorPaymentAdapter.js` |
| Bank stubs | `server/adapters/payments/BankTerminalStubs.js` |
| Orchestration | `server/services/payments.js` |
| Schema | `server/database/migrations/kiosk/002_payments.sql` |
| UI | `src/pages/Payment.jsx` |
| Staff console | Payments tab in `server/demo-pos/public/index.html` |
| Tests | `server/tests/payments.test.js` (41 tests) |

### Decisions worth recording

**Progress is time-driven and stored, not held in a timer.** The state advances
when its due time passes, checked on read. There is no in-memory timer to lose,
so a payment survives a browser reload, a kiosk restart and a power cut.

**The amount is never in the payment request.** The client names a quote; the
server reads its total. A test posts `amountMinor: 1` and asserts it is ignored.

**A gift card is debited at settlement, not at start.** A customer who walks
away at the card prompt is never out of pocket, and a declined card leg leaves
the balance untouched — both tested.

**Cancellation is refused once processing begins**, because the acquirer may
already hold the authorisation.

**The bank adapters throw.** A stub that quietly returned `approved` would be
the most dangerous code in the repository: it would make an unpaid order look
paid. They raise an error carrying a ten-point `blockedOn` list — SDK,
unattended certification, test hardware, PCI scope, timeout semantics,
reconciliation — which is also the question list for the banks.

### Defects found by running it

**1. A single poll only advanced one step.** If the kiosk polled slowly, or the
browser was backgrounded, the payment lagged behind reality. Fixed with a
bounded catch-up loop.

**2. The catch-up could not actually catch up.** Each step rebased its next due
time on `now`, so it always landed in the future and the machine crawled
forward one step per request. Now each step advances from the time it was
*due*, so one poll after a long gap lands where elapsed time says it should.

**3. A fully-covered gift card reported `waiting_for_card`** though there was no
terminal leg. Gift-card payments now start `approved` with their own prompt.

**4. `PaymentRejectedError` was not translated in the Demo POS routes**, so a
refusal like "that payment has already finished" surfaced as a 500 "something
went wrong" — which tells an operator nothing and looks like a crash.

### Test results

```
235 tests, 235 passing, 0 failing  (~15 s)
```

41 new, covering: every outcome; that a decline, timeout or failure creates no
order; that `unknown` creates no order and reaches the operator list; cancel
allowed then refused; double tap; reload; repeated polling of an approved
payment; gift-card split reconciling to one correct order; the gift balance
untouched on decline; cash creating an unpaid order only staff can settle; a
PAN posted in the request body never reaching the database; restart durability
with exactly one order; and the bank stubs refusing rather than approving.

### Outstanding risks

| Risk | Note |
|---|---|
| **The payment screen has not been opened in a browser.** | Prompts, the reader animation and the RTL layout are untested. |
| **No real terminal has ever been attached.** | Everything about real card handling remains a design, not an implementation. |
| **Refund and void are not implemented.** | The simulator has a `voided` state but nothing drives it. A real refund needs acquirer confirmation and is not simulated. |
| **Receipts are still Phase 4.** | A payment produces an order number and nothing printable. |

## QR digital receipts restored (regression fix)

The Phase 1-3 rewrite moved the kiosk onto a new API and left the V3 digital
receipt behind. `qrcode.react` was still a dependency and the V3 code still
sat in `server/index.js`, but the flow actually being run had no receipt
token, no receipt route and no QR on the confirmation screen. Caught by the
user, not by me — I did not flag it when replacing the confirmation page.

### Changed

- `server/database/migrations/kiosk/003_receipts.sql` — `kiosk_receipts`,
  unique on `pos_order_id`.
- `server/services/receipts.js` — issue/resolve/purge, LAN origin discovery.
- `server/routes/receipts.js` — `/api/receipts/:token` and `/receipt/:token`.
- `server/services/checkout.js` — issues a token on confirmation; guarded so
  receipt failure can never fail an order.
- `server/app.js` — wiring, `receipts` exported from the platform.
- `src/pages/Confirmation.jsx`, `src/styles.css`, `shared/i18n.js` — QR.
- `server/tests/receipts.test.js` — 19 tests.

### Decisions

- **Token on the kiosk side, not in `pos_orders`.** A real client POS will not
  store our QR tokens. Putting the column there would bake in an assumption
  that breaks at the first real integration. A test asserts the POS table has
  no receipt column.
- **Content re-read from the POS at view time**, not frozen at issue. A
  receipt opened twenty minutes later shows current kitchen status.
- **No payment reference on the receipt payload.** It is a bearer URL.
- **Origin is never localhost.** A QR pointing at localhost scans fine and
  then fails on the phone — the one failure mode that looks like success in a
  demo. No reachable address means no QR rather than a dead one.

### Bug found while testing

The idempotent-replay branch of `submitOrder` returned early without a
receipt token, so a double-tap or browser reload dropped the customer's QR
code. Found by a test, not by reading. Fixed; covered by
"a retried submission does not mint a second token".

### Verified

- 290 tests pass (19 new), 0 fail. `npm run build` clean.
- End-to-end against a running server: 2-item dine-in order, token issued,
  JSON and HTML both served, VAT extracted correctly (₪7.31 of ₪53.00 =
  16/116), unknown token 404s.

### Not verified

- Nothing rendered in a browser. The QR has not been scanned with a real
  phone, and the confirmation-screen layout at 10-inch landscape is unchecked.
- Arabic RTL on the receipt page is written but unseen.
