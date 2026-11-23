import { Router } from 'express';
import { minorUnitsPer } from '../../shared/money.js';

/**
 * Digital receipts, served two ways.
 *
 * `/api/receipts/:token` returns JSON for anything programmatic.
 * `/receipt/:token` returns a self-contained HTML page, because the reader is
 * a customer's phone camera following a QR code. Server-rendered and
 * JavaScript-free means it works on an old handset, on a captive shop wifi,
 * and without the kiosk's React bundle being reachable at all.
 */
export function receiptRoutes({ receipts, logger }) {
  const router = Router();

  router.get('/api/receipts/:token', async (req, res) => {
    const receipt = await receipts.resolve(req.params.token);
    if (!receipt) return res.status(404).json({ error: { code: 'receipt_not_found', message: 'Receipt not found.' } });
    res.json({ receipt });
  });

  router.get('/receipt/:token', async (req, res) => {
    let receipt = null;
    try {
      receipt = await receipts.resolve(req.params.token);
    } catch (error) {
      logger?.error?.({ err: error }, 'receipt render failed');
      return res.status(500).type('html').send(errorPage('ar_en_error'));
    }
    if (!receipt) return res.status(404).type('html').send(errorPage('not_found'));
    res.type('html').send(renderReceipt(receipt));
  });

  return router;
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function money(amountMinor, currency) {
  if (!Number.isFinite(amountMinor)) return '';
  let scale = 100;
  try { scale = minorUnitsPer(currency); } catch { /* unknown code: assume 2dp */ }
  const decimals = String(scale).length - 1;
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }).format(amountMinor / scale);
  } catch {
    return `${(amountMinor / scale).toFixed(decimals)} ${currency}`;
  }
}

const PAYMENT_LABEL = {
  paid: ['Paid', 'مدفوع'],
  unpaid: ['Pay at counter', 'الدفع عند الكاشير'],
  authorized: ['Authorised', 'تم التفويض'],
  refunded: ['Refunded', 'مسترجع'],
  voided: ['Voided', 'ملغي'],
};

const KITCHEN_LABEL = {
  queued: ['In the queue', 'في الانتظار'],
  preparing: ['Being prepared', 'قيد التحضير'],
  ready: ['Ready for collection', 'جاهز للاستلام'],
  served: ['Collected', 'تم الاستلام'],
  cancelled: ['Cancelled', 'ملغي'],
};

/**
 * Both languages appear on one page rather than behind a toggle: the customer
 * already chose a language at the kiosk, but the person they hand the phone to
 * — a cashier, a colleague — may not read it.
 */
function renderReceipt(r) {
  const cur = r.currency;
  const pay = PAYMENT_LABEL[r.paymentStatus] ?? [r.paymentStatus, r.paymentStatus];
  const kitchen = KITCHEN_LABEL[r.kitchenStatus] ?? [r.kitchenStatus, r.kitchenStatus];
  const store = r.storeNameEn || 'Bean & Bloom';

  const lines = r.items.map((item) => {
    const mods = item.modifiers.map((m) => escapeHtml(m.nameEn)).join(' · ');
    return `<tr>
      <td class="qty">${item.quantity}&times;</td>
      <td class="name">${escapeHtml(item.nameEn)}
        ${item.nameAr ? `<div class="ar">${escapeHtml(item.nameAr)}</div>` : ''}
        ${mods ? `<div class="mods">${mods}</div>` : ''}</td>
      <td class="amt">${money(item.lineTotalMinor, cur)}</td>
    </tr>`;
  }).join('');

  const totalRow = (labelEn, labelAr, amount, cls = '') =>
    `<tr class="${cls}"><td colspan="2">${labelEn} <span class="ar-inline">${labelAr}</span></td><td class="amt">${money(amount, cur)}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Receipt ${escapeHtml(r.posOrderNumber)} — ${escapeHtml(store)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px 14px 40px; background:#f4efe8;
         font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans Arabic",sans-serif;
         color:#2e2217; }
  .sheet { max-width:430px; margin:0 auto; background:#fff; border-radius:14px;
           box-shadow:0 2px 14px rgba(70,50,30,.13); padding:22px 20px 26px; }
  h1 { font-size:19px; margin:0 0 2px; letter-spacing:.02em; }
  .sub { color:#7b6a58; font-size:13px; margin:0 0 16px; }
  .order { background:#f8f4ee; border-radius:10px; padding:12px 14px; margin-bottom:16px; }
  .order .num { font-size:30px; font-weight:700; letter-spacing:.02em; line-height:1.1; }
  .order .lbl { font-size:12px; text-transform:uppercase; letter-spacing:.09em; color:#7b6a58; }
  .badges { display:flex; flex-wrap:wrap; gap:7px; margin-top:11px; }
  .badge { font-size:12.5px; padding:4px 10px; border-radius:999px; background:#e8e0d5; color:#4a3a27; }
  .badge.paid { background:#d9ebdb; color:#20502c; }
  .badge.unpaid { background:#fae6c9; color:#6d4710; }
  table { width:100%; border-collapse:collapse; margin:4px 0 0; }
  td { padding:8px 0; vertical-align:top; border-bottom:1px solid #efe8de; }
  .qty { width:34px; color:#7b6a58; font-variant-numeric:tabular-nums; }
  .amt { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; width:88px; }
  .ar { direction:rtl; color:#6b5a48; font-size:14px; }
  .mods { color:#8a7664; font-size:13px; margin-top:2px; }
  .totals td { border:none; padding:5px 0; color:#5c4c3a; }
  .totals .grand td { border-top:2px solid #2e2217; padding-top:10px; font-size:19px; font-weight:700; color:#2e2217; }
  .ar-inline { direction:rtl; color:#8a7664; font-size:13px; }
  .vat { color:#8a7664; font-size:12.5px; margin-top:9px; }
  footer { text-align:center; color:#8a7664; font-size:12px; margin-top:18px; line-height:1.7; }
  @media print { body { background:#fff; padding:0; } .sheet { box-shadow:none; max-width:none; } }
</style>
</head>
<body>
<div class="sheet">
  <h1>${escapeHtml(store)}</h1>
  <p class="sub">${r.storeNameAr ? `<span dir="rtl">${escapeHtml(r.storeNameAr)}</span> · ` : ''}Digital receipt · إيصال رقمي</p>

  <div class="order">
    <div class="lbl">Order · رقم الطلب</div>
    <div class="num">${escapeHtml(r.posOrderNumber)}</div>
    <div class="badges">
      <span class="badge ${r.paymentStatus === 'paid' ? 'paid' : r.paymentStatus === 'unpaid' ? 'unpaid' : ''}">${pay[0]} · ${pay[1]}</span>
      <span class="badge">${kitchen[0]} · ${kitchen[1]}</span>
      <span class="badge">${r.fulfillment === 'dine_in' ? 'Dine in · تناول هنا' : 'Takeaway · سفري'}</span>
      ${r.tableNumber ? `<span class="badge">Table ${escapeHtml(r.tableNumber)} · طاولة</span>` : ''}
    </div>
  </div>

  <table>${lines}</table>

  <table class="totals">
    ${r.surchargeMinor || r.discountMinor ? totalRow('Items', 'الأصناف', r.itemsSubtotalMinor) : ''}
    ${r.surchargeMinor ? totalRow('Dine-in service', 'خدمة الجلوس', r.surchargeMinor) : ''}
    ${r.discountMinor ? totalRow('Discount', 'الخصم', -r.discountMinor) : ''}
    <tr class="grand"><td colspan="2">Total <span class="ar-inline">المجموع</span></td><td class="amt">${money(r.totalMinor, cur)}</td></tr>
  </table>

  ${r.vatIncludedMinor ? `<p class="vat">Includes VAT ${money(r.vatIncludedMinor, cur)} · شامل ضريبة القيمة المضافة</p>` : ''}

  <footer>
    ${escapeHtml(new Date(r.issuedAt).toUTCString())}<br>
    This link expires on ${escapeHtml(new Date(r.expiresAt).toDateString())}<br>
    <span dir="rtl">تنتهي صلاحية هذا الرابط قريباً</span>
  </footer>
</div>
</body>
</html>`;
}

function errorPage(kind) {
  const [en, ar] = kind === 'not_found'
    ? ['This receipt link is not valid, or it has expired.', 'هذا الرابط غير صالح أو انتهت صلاحيته.']
    : ['Something went wrong loading this receipt.', 'حدث خطأ أثناء تحميل الإيصال.'];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Receipt unavailable</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#f4efe8;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,"Noto Sans Arabic",sans-serif;color:#2e2217;padding:24px}
div{max-width:360px;text-align:center;background:#fff;padding:30px 24px;border-radius:14px;box-shadow:0 2px 14px rgba(70,50,30,.13)}
p.ar{direction:rtl;color:#6b5a48;margin:10px 0 0}</style></head>
<body><div><p>${en}</p><p class="ar">${ar}</p></div></body></html>`;
}
