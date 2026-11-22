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

**168 tests, 168 passing, 0 failing** — about 11 seconds.

### Platform note

The suite is verified on **Linux and Windows**. That distinction matters: the
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
| `api.test.js` | 32 | Menu shape, auth, roles, price parsing, full order flow, error model, health, ops protection |
| `sync.test.js` | 20 | Menu versioning, quote invalidation, staleness, **overlays cannot override**, ID mapping |
| `resilience.test.js` | 14 | POS offline, retry/backoff, stranded payments, restart durability, metrics |
| `importV3.test.js` | 13 | Read-only guarantee, backups, fidelity, idempotency |
| `migrations.test.js` | 10 | Ordering, immutability, rollback, pragmas, schema separation |

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
| **No React component tests.** The kiosk UI still talks to the V3 API. | 2 |
| **No responsive/visual checks** at 10" landscape, 10" portrait, 27" portrait. | 2, 7 |
| **No Arabic RTL rendering tests.** Arabic strings are asserted present; layout is not verified. | 2, 7 |
| **No payment state-machine tests** — there is no simulator yet. | 3 |
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
