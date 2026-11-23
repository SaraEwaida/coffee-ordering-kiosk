# API reference

Two namespaces on one server (default port **4001**):

| Prefix | Audience | Auth |
|---|---|---|
| `/api/kiosk/*` | Customer kiosk UI | None. Read-only over the catalog. |
| `/demo-pos/api/*` | Shop staff at the till | Bearer token, role-gated |
| `/demo-pos/` | Staff console (static page) | Signs in via the API above |
| `/api/ops/*` | Operator diagnostics | Bearer token, **manager** role |

A machine-readable spec is in [`openapi.yaml`](../openapi.yaml).

## Conventions

**Money.** Every monetary field ends in `Minor` and is an **integer** count of
minor currency units (agorot for ILS). `2650` is 26.50 ILS. Prices are
VAT-inclusive; `vatIncludedMinor` is the VAT *contained in* the total, not an
addition to it. There are no float money fields anywhere, and a test enforces it.

**Errors.** One shape, always:

```json
{ "error": { "code": "item_unavailable", "message": "Caffè Latte is sold out.",
             "details": { "posProductId": "PRD-1003" },
             "requestId": "3f8c…" } }
```

`code` is stable and safe to switch on. `message` is safe to show a customer.
Internal detail is logged, never returned.

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed request or JSON |
| `validation_failed` | 422 | A field is wrong; `details.field` says which |
| `unauthorized` | 401 | Missing or expired token |
| `forbidden` | 403 | Signed in, wrong role |
| `not_found` | 404 | No such thing |
| `conflict` | 409 | Quote already used or expired |
| `menu_changed` | 409 | Price or availability moved since the quote |
| `quote_mismatch` | 409 | Recomputed total disagreed |
| `item_unavailable` | 409 | Sold out |
| `modifier_min_not_met` / `modifier_max_exceeded` | 409 | Modifier group rules |
| `mapping_missing` | 409 | No POS mapping for an item — an integration fault |
| `payment_amount_mismatch` | 409 | Payment does not equal the order total |
| `payment_taken_order_failed` | 409 | **Money moved but no order exists.** Send the customer to staff with `details.reference`. |
| `payment_not_cancellable` | 409 | The card is being processed; cancellation is refused |
| `payment_needs_staff` | 409 | The terminal stopped answering. A human must confirm. |
| `gift_card_empty` / `gift_card_invalid` | 409 / 404 | Gift card has no balance, or was not recognised |
| `adapter_not_implemented` | 503 | A real bank terminal adapter was called. `details.blockedOn` lists what is needed. |
| `rate_limited` | 429 | Too many attempts |
| `pos_unavailable` | 503 | Till unreachable; retryable |
| `internal_error` | 500 | Unexpected; detail is in the logs only |

---

## Kiosk API

### `GET /api/kiosk/config`
Store settings the UI needs: currency, locale, dine-in toggle, surcharge
label/value for display, inactivity timeout, sync interval.

### `GET /api/kiosk/menu`
The menu to render. **200** when a cached menu exists, **503** when there has
never been a successful sync (show a "cannot reach the till" screen, not an
empty menu).

```json
{
  "available": true,
  "currency": "ILS",
  "menuVersion": "91b2f8eb942fb65e",
  "categories": [{ "id": "CAT-HOT", "nameEn": "Hot coffee", "nameAr": "قهوة ساخنة" }],
  "products": [{
    "posProductId": "PRD-1003", "sku": "COF-LAT-01",
    "nameEn": "Caffè Latte", "nameAr": "كافيه لاتيه",
    "priceMinor": 1600, "taxRateBp": 1600, "available": true,
    "descriptionEn": "…", "imageUrl": "/images/latte.webp",
    "allergensEn": null, "calories": null,
    "modifierGroups": [{
      "groupId": "GRP-SIZE", "nameEn": "Cup size", "nameAr": "حجم الكوب",
      "minSelect": 1, "maxSelect": 1, "required": true,
      "modifiers": [{ "modifierId": "MOD-SIZE-M", "nameEn": "Medium",
                      "priceDeltaMinor": 300, "available": true }]
    }]
  }],
  "sync": { "syncedAt": "…", "ageSeconds": 5, "stale": false,
            "healthy": true, "consecutiveFailures": 0, "intervalSeconds": 30 }
}
```

`sync.stale` is true past 120 s. **Show a stale badge** — never present old
prices as current. `priceMinor` and `available` come from the POS and cannot be
overridden; `descriptionEn`, `imageUrl`, `allergens*` and `calories` may come
from a kiosk overlay.

### `POST /api/kiosk/menu/sync`
Force a sync. Useful in a demo to make a price change land immediately.

### `POST /api/kiosk/quotes`
Price a cart. The response total is the only one that may be charged.

```json
{ "kioskId": "kiosk-01",
  "cart": { "fulfillment": "dine_in", "tableNumber": null, "promotionCode": null,
            "lines": [{ "posProductId": "PRD-1003", "quantity": 2,
                        "modifierIds": ["MOD-SIZE-L","MOD-MILK-OAT","MOD-SUG-1"],
                        "notes": "" }] } }
```

**201**:

```json
{ "quoteId": "fc47af31-…", "expiresAt": "…",
  "quote": { "currency": "ILS", "itemsSubtotalMinor": 5300,
             "discountMinor": 0, "surchargeMinor": 200,
             "surchargeLabelEn": "Dine-in service", "surchargeLabelAr": "خدمة الجلوس",
             "totalMinor": 5500, "vatIncludedMinor": 759,
             "taxNoteEn": "All prices include VAT.",
             "lines": [{ "unitPriceMinor": 2650, "lineTotalMinor": 5300,
                         "discountShareMinor": 0, "vatIncludedMinor": 731,
                         "modifiers": [ … ] }] } }
```

`posProductId` accepts a POS ID or a mapped kiosk-local key (`"latte"`). An
unmapped reference returns `mapping_missing` and is logged as an integration
issue — it is never guessed.

### `GET /api/kiosk/quotes/:id`
Re-read a quote and its status (`open`, `consumed`, `expired`, `invalidated`).

### `POST /api/kiosk/orders`
Submit an order. **Idempotent on `clientRequestId`** — generate one stable ID
per checkout attempt and reuse it for every retry.

```json
{ "clientRequestId": "kiosk01-1795342620-a7f3", "quoteId": "fc47af31-…",
  "kioskId": "kiosk-01", "notes": "",
  "payment": { "method": "card_simulated", "status": "approved",
               "amountMinor": 5500, "reference": "SIM-…" } }
```

`payment` is optional. If present and `approved`, `amountMinor` **must** equal
the order total exactly or the order is refused outright.

| Status | Body `status` | Meaning |
|---|---|---|
| **201** | `confirmed` | The POS has the order. `posOrderNumber` is the customer's number. |
| **202** | `pending` | Saved and queued; the till has not confirmed. **Do not show success.** |
| 409 | — | Refused: see `error.code` |

A 202 with `paymentAccepted: true` carries a customer-facing `message` saying
their payment went through and to speak to staff. Show that, verbatim.

### `GET /api/kiosk/orders/by-request/:clientRequestId`
Poll a submission after a 202. Returns `confirmed`, `pending` or `failed`, plus
`attempts`, `nextAttemptAt` and the order when it exists.

### `GET /api/kiosk/orders/:posOrderId/status`
Order and kitchen status, for an order-ready display.

### `GET /api/kiosk/promotions/:code` · `GET /api/kiosk/gift-cards/:code`
Validate via the adapter. **404** when invalid. Gift-card responses mask the
code to its last four characters.

### `POST /api/kiosk/payments`
Start paying for a quote.

```json
{ "quoteId": "fc47af31-…", "clientRequestId": "kiosk01-1795342620-a7f3",
  "kioskId": "kiosk-01", "method": "card_simulated",
  "giftCardCode": "DEMO-GIFT-1200" }
```

**There is no amount in this request, and there cannot be.** The server reads
the total from the stored quote. An `amountMinor` sent by a client is ignored,
and a test asserts it.

**201**:

```json
{ "paymentId": "…", "state": "waiting_for_card", "method": "card_simulated",
  "amountMinor": 1900, "currency": "ILS",
  "giftCardCode": "••••1200", "giftAppliedMinor": 1200, "cardAmountMinor": 700,
  "promptEn": "Tap, insert or swipe your card",
  "promptAr": "قرّب بطاقتك أو أدخلها أو مرّرها",
  "cancellable": true, "terminal": false, "needsStaff": false, "simulated": true }
```

Show `promptEn`/`promptAr` verbatim. The gift-card code comes back masked — it
is a bearer credential.

A second POST with the same `clientRequestId` returns the payment already in
flight. A double tap cannot open two payments.

### `GET /api/kiosk/payments/:id`
Poll. Also the moment an approval becomes a POS order, so the response carries
`order` once it exists.

| `state` | What the screen should do |
|---|---|
| `waiting_for_card` | Show the tap prompt. Cancel is offered. |
| `processing` | Show a spinner. **Cancel is refused** — the acquirer may already hold the authorisation. |
| `approved` | Show success and the order number from `order.posOrderNumber`. |
| `declined` | Say the card was declined and that **no money was taken**. Offer retry. |
| `timed_out` | No card was presented. Offer retry. |
| `cancelled` | Returned to the cart. |
| `failed` | Reader problem. Offer retry. |
| `unknown` | **Stop.** Send the customer to a member of staff with `reference`, and tell them not to pay again yet. |

### `POST /api/kiosk/payments/:id/cancel`
**409 `payment_not_cancellable`** once processing has begun, and
**409 `payment_needs_staff`** when the state is `unknown`.

### `POST /api/kiosk/payments/cash`
Creates the POS order marked **unpaid**. Nothing in the kiosk can mark cash
received; a member of staff records it through
`POST /demo-pos/api/orders/:id/payments`.

### `GET /api/kiosk/health`
**200** healthy, **503** when the POS is unreachable or ops exceptions exist.
Reports adapter reachability, error rate, latency, menu age and queue depth.

### `POST /api/kiosk/kiosks/:kioskId/heartbeat`
Liveness for the fleet view.

---

## Demo POS API

All routes except `/health` need `Authorization: Bearer <token>`.

| Route | Method | Role |
|---|---|---|
| `/auth/login` | POST | — (rate limited: 8 per 10 min) |
| `/auth/logout`, `/auth/me` | POST, GET | any |
| `/auth/password` | PATCH | any — change your own, current password required |
| `/users`, `/users/:username/password` | GET, PATCH | **manager** — reset another account |
| `/menu`, `/products`, `/config` | GET | any |
| `/orders`, `/orders/:id`, `/kitchen/queue` | GET | any |
| `/gift-cards/:code` | GET | any (rate limited) |
| `/orders/:id/kitchen-status` | PATCH | manager, barista |
| `/orders/:id/payments` | POST | manager, barista |
| `/products/:id`, `/modifiers/:id`, `/config` | PATCH | **manager** |
| `/audit` | GET | **manager** |
| `/demo/faults` | POST | **manager**, refused when `NODE_ENV=production` |
| `/demo/payments` | GET | **manager** — payments needing attention, adapter status |
| `/demo/payments/default-outcome` | POST | **manager** — what the next payment will do |
| `/demo/payments/:id/force` | POST | **manager** — force an outcome on a live payment |
| `/demo/payments/:id/events` | GET | **manager** — full state history for a dispute |
| `/health` | GET | — |

### `POST /demo-pos/api/auth/login`
```json
{ "username": "manager", "password": "…" }
```
→ `{ "accessToken": "…", "expiresAt": "…", "user": { "username": "manager", "role": "manager" } }`

A wrong username and a wrong password return the **same** message, so usernames
cannot be enumerated. Sessions are stored in SQLite and survive a restart.

### `PATCH /demo-pos/api/auth/password`
```json
{ "currentPassword": "…", "newPassword": "…" }
```
The current password is required even though the caller is signed in: a token
left open on an unattended till must not be enough to lock the owner out.

**Every session for that account is destroyed, including the caller's.** The UI
must sign the user out and ask them to sign in again. Minimum 10 characters,
not digits-only, and not the same as the current one.

### `PATCH /demo-pos/api/users/:username/password`
Manager only. Resets another account without knowing its old password, for
someone who has forgotten theirs. Their sessions end immediately; the manager's
own session is unaffected.

When nobody can sign in at all, the recovery path is the CLI:
`npm run pos:password -- manager`.

### `PATCH /demo-pos/api/products/:id`
```json
{ "price": "18.50", "available": true }
```
`price` is a **decimal string**, parsed exactly server-side. `priceMinor` (an
integer) is also accepted. A float `priceMinor` is rejected. The kiosk sees the
change within 30 s, or immediately via `POST /api/kiosk/menu/sync`.

### `PATCH /demo-pos/api/orders/:id/kitchen-status`
`{ "kitchenStatus": "queued" | "preparing" | "ready" | "served" | "cancelled" }`

Cancelling a **paid** order is refused (`refund_required`) — money must not
disappear via a status flip.

### `POST /demo-pos/api/orders/:id/payments`
Records money a member of staff has actually seen. Nothing in the customer
kiosk can mark an order paid. An approved amount must equal the order total;
replaying the same `reference` returns `duplicate: true` without double-counting.

### `POST /demo-pos/api/demo/faults`
`{ "offline": false, "failOnSubmit": false, "latencyMs": 0 }`

Development only. Makes the till *look* unreachable so recovery behaviour can
be shown live. **Does not simulate a card payment.** Refused in production.

---

## Operator

### `GET /api/ops/exceptions`
Everything needing a human: submissions where payment was accepted but no POS
order exists, plus integration issues (missing or dangling ID mappings, paid
orders the POS refused).

Requires a **manager** token. It lists payment references and failure detail
for orders where a customer's money moved, so it is deliberately not reachable
from the kiosk or by a barista account.

## Digital receipts

A confirmed order carries `receiptToken` and `receiptUrl`. The token is 32
random bytes (base64url, 43 chars) and expires after 72 hours.

The token is stored in `kiosk.sqlite` (`kiosk_receipts`), **not** in
`pos_orders`. A real client POS will not give us a column for our QR tokens,
so the kiosk owns the link and the POS owns the order.

### `GET /api/receipts/:token`

```http
GET /api/receipts/8_T4RKMMxBldxWeKQjTji7zqAy3PebnMABsiHNG9Rb4

200 OK
{
  "receipt": {
    "posOrderNumber": "1001",
    "currency": "ILS",
    "fulfillment": "dine_in",
    "kitchenStatus": "queued",
    "paymentStatus": "unpaid",
    "itemsSubtotalMinor": 5100,
    "surchargeMinor": 200,
    "totalMinor": 5300,
    "vatIncludedMinor": 731,
    "items": [ { "nameEn": "Latte", "quantity": 2, "lineTotalMinor": 3600, "modifiers": [...] } ]
  }
}
```

Unknown, malformed and expired tokens all return the same `404` — a guessed
token learns nothing from the difference.

Order status is re-read from the POS at view time, so a receipt opened later
shows current kitchen and payment status rather than a snapshot.

### `GET /receipt/:token`

The same receipt as a self-contained HTML page: no JavaScript, no React
bundle, mobile viewport, `noindex`. This is what the QR code points at,
because the reader is a phone camera.

`?lang=en` (default) or `?lang=ar`. The page renders in ONE language — the
one the customer chose at the kiosk, which the kiosk appends to the QR URL.
A receipt is read by one person who has already picked a language; showing
both halves the legible content. `?lang=ar` sets `dir="rtl"`, while the
order number and money amounts stay `direction:ltr` so they cannot read
backwards. An unrecognised `lang` falls back to English rather than
erroring.

### Reachable origin

`receiptUrl` is built from `PUBLIC_RECEIPT_ORIGIN` when set, otherwise from
the machine's LAN IPv4 address. It is never `localhost`: a QR pointing at
localhost scans correctly and then fails on the customer's phone. When no
reachable address can be determined the URL is `null` and the kiosk shows no
QR code rather than a dead one.

Set `PUBLIC_RECEIPT_ORIGIN` for any deployment behind a hostname or TLS.

### Not covered

- Receipts are bearer URLs over plain HTTP on a LAN in the PoC. A real
  deployment needs TLS.
- No rate limiting on `/receipt/:token` yet; brute-forcing a 32-byte token is
  not feasible, but the endpoint should still be throttled before production.
- Expired rows are removed by `receipts.purgeExpired()`, which is not yet on
  a schedule.
