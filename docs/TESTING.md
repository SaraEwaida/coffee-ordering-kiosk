# Testing

```bash
npm test          # the whole suite
npm run test:watch
node --test --test-reporter=spec "server/tests/api.test.js"   # one file
```

Built on Node's own `node:test` — no test framework dependency. Tests drive the
**real** objects: real SQLite files in a temp directory, real migrations, real
transactions, real HTTP through `app.listen(0)`. Almost nothing is mocked, so a
passing test means the actual SQL and constraints work, not that a stub was
configured to agree.

## Current result

**271 tests, 271 passing, 0 failing** — about 18 seconds.

### Platform note

Verified on both: **Linux 168/168 (~10.6 s)** and **Windows 11 / Node 22,
168/168 (~7.4 s)**. That distinction matters: the
first Windows run failed 13 tests in `importV3.test.js`, all with `EPERM` on
directory cleanup, because a SQLite connection was left open. Linux allows
unlinking an open file and Windows does not, so the same code passed on one and
failed on the other — and in WAL mode the `-wal` and `-shm` siblings are locked
too. Test teardown now closes every tracked handle before removing a directory
and retries the removal, since Windows can take a moment to release a handle
after `close()`.

Worth knowing when reading a failure: all 13 assertions had **passed**. The
error was in teardown, after the test body. A green assertion with a red test is
usually a resource-cleanup problem, not a logic one.

| File | Tests | Covers |
|---|---|---|
| `money.test.js` | 22 | Integer discipline, VAT extraction, rounding, parsing, pro-rata |
| `pricing.test.js` | 27 | Modifier arithmetic, min/max groups, availability, limits, surcharge, promotions, VAT reconciliation |
| `orders.test.js` | 30 | Idempotency, numbering, price authority, payment safety, kitchen status, snapshots, gift cards, audit |
| `api.test.js` | 42 | Menu shape, auth, roles, price parsing, full order flow, error model, health, ops protection |
| `sync.test.js` | 20 | Menu versioning, quote invalidation, staleness, **overlays cannot override**, ID mapping |
| `resilience.test.js` | 14 | POS offline, retry/backoff, stranded payments, restart durability, metrics |
| `importV3.test.js` | 13 | Read-only guarantee, backups, fidelity, idempotency |
| `migrations.test.js` | 10 | Ordering, immutability, rollback, pragmas, schema separation |
| `payments.test.js` | 41 | Every payment outcome, gift-card split, cash, double tap, reload, restart, operator panel, bank stubs, no-card-data |
| `passwordPrompt.test.js` | 22 | The hidden terminal prompt: the question is shown, nothing echoes, and no key can corrupt a password |
| `kioskUi.test.js` | 30 | ILS formatting, language fallback, modifier selection rules, the exact payload the screens send |

## The tests that matter most

These exist because the failure they prevent costs real money or real trust.

**`an approved payment for the wrong amount is refused outright`** — a payment
of 19.00 was once attached to a 22.00 order and the order marked paid. The
amount check existed on `attachPayment` but not on the order-creation path. A
till discrepancy that would only surface at cash-up.

**`a stranded payment yields a staff-referral message, not "review your order"`** —
if a card is approved and the price changes in the next second, validation
rejects the order. Before the fix, the customer saw "please review your order"
and **no record of their payment existed anywhere**.

**`a paid submission is never marked failed, however many attempts fail`** —
an unpaid order may eventually be abandoned. One whose money has moved must not
be, because abandoning it means a customer paid for nothing.

**`a pending submission survives a full platform restart and then confirms`** —
closes both databases mid-flight, rebuilds the platform from the same files,
and asserts exactly one order appears. The real test of durability.

**`arrow keys and control characters are ignored, not inserted`** — an arrow
key sends `ESC [ A`. The ESC is filtered as a control character but `[` and `A`
are printable, so they were being inserted into the password. With no echo the
user could not see it, so they would set a password containing characters they
never typed and lock themselves out. F1 leaked the same way through `ESC O P`.

**`the question is written before any input arrives`** — the first version
wrote the prompt and then created a readline interface, which redrew the line
from its own empty prompt and wiped it. The script looked hung. Nothing caught
it because the interactive path had never been exercised: piped input takes a
different branch.

**`the terminal that stops answering is its own state, never auto-resolved`** —
a payment whose outcome is unknown creates no order, is not called a decline,
and reaches a human. Guessing either way costs money or trust.

**`a declined card leg leaves the gift balance untouched`** — the gift card is
debited only when the rest of the money is secured, so an abandoned or declined
payment never silently consumes a customer's balance.

**`a client cannot smuggle card data into a payment`** — posts a PAN and CVV in
the request body and asserts neither reaches the database.

**`real bank adapters throw rather than pretending to approve`** — a stub that
quietly returned "approved" would be the most dangerous thing in the repository.

**`the overlay table has no price or availability column, by design`** — asserts
a *structural* property. A kiosk overlay cannot override POS pricing because
there is nowhere to put the value, not because code remembers not to.

**`imported legacy history does not advance the live counter`** — the first new
order after a V3 import was numbered 901002 and a customer would have been told
to collect order 901002.

**`POS and kiosk schemas share no table names`** — guards the architectural
boundary. If someone later adds a POS table to the kiosk schema, this fails.

**`no monetary value is ever sent as a float`** — walks the whole menu response
and asserts every `*Minor` field is an integer.

**`a wrong password gives the same message as a wrong username`** — otherwise
valid usernames are discoverable.

## Verified by running it, not by test

Recorded manually against a live server on 2026-11-22:

| Scenario | Result |
|---|---|
| A — change Cappuccino price in the till → kiosk shows it | 1500 → 1850 after sync |
| B — mark Latte sold out → kiosk refuses | `item_unavailable`, "Caffè Latte is sold out." |
| C — dine-in order, 2 large oat lattes + croissant | Total 63.00 ILS, VAT 8.69, one order, correct modifiers |
| Duplicate POST | Same order number, `duplicate: true`, one row in the till |
| G — payment approved then till fails | 202, ops exception raised, auto-confirmed ~6 s after recovery, exactly one order, marked paid, exception cleared |
| SIGKILL mid-flight then restart | Order recovered and confirmed ~6 s after restart; one order; staff session survived |
| Unauthenticated price change | 401 |
| Barista attempting a price change | 403 |

## Not yet covered

Named honestly, because an untested area is not a finished one.

| Gap | Phase |
|---|---|
| **No browser/E2E tests.** No Playwright, no UI test. The Demo POS console was verified by API calls and syntax check, not by driving it. | 7 |
| **No React component or browser tests.** The UI's pure logic is tested (formatting, modifier rules, the payload it sends) but nothing renders a component or clicks a button. | 7 |
| **No responsive/visual checks** at 10" landscape, 10" portrait, 27" portrait. The CSS exists; nothing proves it does not overflow. | 7 |
| **No Arabic RTL rendering tests.** All 164 keys are asserted present and distinct from English; the RTL *layout* is not verified. | 7 |
| **The inactivity timeout is untested.** It needs a DOM to drive events. | 7 |
| **No concurrency test** for two kiosks submitting at the same instant. `BEGIN IMMEDIATE` plus the UNIQUE constraint should hold; it is not proven. | 7 |
| **No load or performance measurement.** The brief's targets (touch < 100 ms, handoff < 3 s) are **unmeasured**. | 6 |
| **No multi-tenant isolation tests** — one store is seeded. | 5 |
| **No printer or device-service tests** — none exists. | 4 |

## Conventions

- One behaviour per test; the name states the behaviour, not the method.
- `makeTestPlatform()` builds a full platform on a temp directory and cleans up.
- Workers are **off** in tests: retries are driven explicitly rather than
  racing a background interval, so there are no sleeps and no flakes.
- Assert the *consequence*, not the call. "Exactly one row exists" beats
  "the adapter was called once".
