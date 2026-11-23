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
 *
 * The page renders in ONE language — whichever the customer chose at the
 * kiosk, passed as `?lang=`. A receipt is read by one person who already
 * picked a language; showing both at once halves the legible content and
 * makes an Arabic reader hunt past English for their own total.
 */
export function receiptRoutes({ receipts, logger }) {
  const router = Router();

  router.get('/api/receipts/:token', async (req, res) => {
    const receipt = await receipts.resolve(req.params.token);
    if (!receipt) return res.status(404).json({ error: { code: 'receipt_not_found', message: 'Receipt not found.' } });
    res.json({ receipt });
  });

  router.get('/receipt/:token', async (req, res) => {
    const lang = req.query.lang === 'ar' ? 'ar' : 'en';
    let receipt = null;
    try {
      receipt = await receipts.resolve(req.params.token);
    } catch (error) {
      logger?.error?.({ err: error }, 'receipt render failed');
      return res.status(500).type('html').send(errorPage('error', lang));
    }
    if (!receipt) return res.status(404).type('html').send(errorPage('not_found', lang));
    res.type('html').send(renderReceipt(receipt, lang));
  });

  return router;
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Arabic uses Latin digits deliberately, matching the kiosk: Palestinian
 * price tags and till receipts overwhelmingly use them, and Arabic-Indic
 * digits on a receipt invite misreading a total.
 */
function money(amountMinor, currency, lang) {
  if (!Number.isFinite(amountMinor)) return '';
  let scale = 100;
  try { scale = minorUnitsPer(currency); } catch { /* unknown code: assume 2dp */ }
  const decimals = String(scale).length - 1;
  const locale = lang === 'ar' ? 'ar-PS-u-nu-latn' : 'en-GB';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }).format(amountMinor / scale);
  } catch {
    return `${(amountMinor / scale).toFixed(decimals)} ${currency}`;
  }
}

const T = {
  en: {
    receipt: 'Digital receipt', order: 'Order', total: 'Total', items: 'Items',
    surcharge: 'Dine-in service', discount: 'Discount',
    dineIn: 'Dine in', takeaway: 'Takeaway', table: 'Table',
    vat: (amount) => `Includes VAT ${amount}`,
    expires: (date) => `This link expires on ${date}`,
    unavailable: 'This receipt link is not valid, or it has expired.',
    failed: 'Something went wrong loading this receipt.',
    payment: {
      paid: 'Paid', unpaid: 'Pay at counter', authorized: 'Authorised',
      refunded: 'Refunded', voided: 'Voided',
    },
    kitchen: {
      queued: 'In the queue', preparing: 'Being prepared', ready: 'Ready for collection',
      served: 'Collected', cancelled: 'Cancelled',
    },
  },
  ar: {
    receipt: 'إيصال رقمي', order: 'رقم الطلب', total: 'المجموع', items: 'الأصناف',
    surcharge: 'خدمة الجلوس', discount: 'الخصم',
    dineIn: 'تناول هنا', takeaway: 'سفري', table: 'طاولة',
    vat: (amount) => `شامل ضريبة القيمة المضافة ${amount}`,
    expires: (date) => `تنتهي صلاحية هذا الرابط في ${date}`,
    unavailable: 'هذا الرابط غير صالح أو انتهت صلاحيته.',
    failed: 'حدث خطأ أثناء تحميل الإيصال.',
    payment: {
      paid: 'مدفوع', unpaid: 'الدفع عند الكاشير', authorized: 'تم التفويض',
      refunded: 'مسترجع', voided: 'ملغي',
    },
    kitchen: {
      queued: 'في الانتظار', preparing: 'قيد التحضير', ready: 'جاهز للاستلام',
      served: 'تم الاستلام', cancelled: 'ملغي',
    },
  },
};

const pick = (lang, en, ar) => (lang === 'ar' ? (ar || en) : (en || ar));

function renderReceipt(r, lang) {
  const t = T[lang];
  const rtl = lang === 'ar';
  const cur = r.currency;
  const amount = (value) => money(value, cur, lang);
  const store = pick(lang, r.storeNameEn, r.storeNameAr) || 'Bean & Bloom';

  const lines = r.items.map((item) => {
    const mods = item.modifiers.map((m) => escapeHtml(pick(lang, m.nameEn, m.nameAr))).join(' · ');
    return `<tr>
      <td class="qty">${item.quantity}&times;</td>
      <td class="name">${escapeHtml(pick(lang, item.nameEn, item.nameAr))}
        ${mods ? `<div class="mods">${mods}</div>` : ''}</td>
      <td class="amt">${amount(item.lineTotalMinor)}</td>
    </tr>`;
  }).join('');

  const row = (label, value) =>
    `<tr><td colspan="2">${label}</td><td class="amt">${amount(value)}</td></tr>`;

  const dateLocale = rtl ? 'ar-PS-u-nu-latn' : 'en-GB';
  const fmtDate = (iso) =>
    new Intl.DateTimeFormat(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const fmtTime = (iso) =>
    new Intl.DateTimeFormat(dateLocale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  return `<!doctype html>
<html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(t.order)} ${escapeHtml(r.posOrderNumber)} — ${escapeHtml(store)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px 14px 40px; background:#f4efe8;
         font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans Arabic","Noto Naskh Arabic",sans-serif;
         color:#2e2217; }
  .sheet { max-width:430px; margin:0 auto; background:#fff; border-radius:14px;
           box-shadow:0 2px 14px rgba(70,50,30,.13); padding:22px 20px 26px; }
  h1 { font-size:19px; margin:0 0 2px; letter-spacing:.02em; }
  .sub { color:#7b6a58; font-size:13px; margin:0 0 16px; }
  .order { background:#f8f4ee; border-radius:10px; padding:12px 14px; margin-bottom:16px; }
  .order .num { font-size:30px; font-weight:700; letter-spacing:.02em; line-height:1.1;
                direction:ltr; unicode-bidi:embed; }
  .order .lbl { font-size:12px; letter-spacing:.09em; color:#7b6a58; text-transform:uppercase; }
  .badges { display:flex; flex-wrap:wrap; gap:7px; margin-top:11px; }
  .badge { font-size:12.5px; padding:4px 10px; border-radius:999px; background:#e8e0d5; color:#4a3a27; }
  .badge.paid { background:#d9ebdb; color:#20502c; }
  .badge.unpaid { background:#fae6c9; color:#6d4710; }
  table { width:100%; border-collapse:collapse; margin:4px 0 0; }
  td { padding:8px 0; vertical-align:top; border-bottom:1px solid #efe8de; }
  .qty { width:38px; color:#7b6a58; font-variant-numeric:tabular-nums; direction:ltr;
         text-align:${rtl ? 'right' : 'left'}; }
  .amt { text-align:${rtl ? 'left' : 'right'}; white-space:nowrap;
         font-variant-numeric:tabular-nums; width:92px; direction:ltr; }
  .mods { color:#8a7664; font-size:13px; margin-top:2px; }
  .totals td { border:none; padding:5px 0; color:#5c4c3a; }
  .totals .grand td { border-top:2px solid #2e2217; padding-top:10px; font-size:19px;
                      font-weight:700; color:#2e2217; }
  .vat { color:#8a7664; font-size:12.5px; margin-top:9px; }
  footer { text-align:center; color:#8a7664; font-size:12px; margin-top:18px; line-height:1.8; }
  @media print { body { background:#fff; padding:0; } .sheet { box-shadow:none; max-width:none; } }
</style>
</head>
<body>
<div class="sheet">
  <h1>${escapeHtml(store)}</h1>
  <p class="sub">${escapeHtml(t.receipt)}</p>

  <div class="order">
    <div class="lbl">${escapeHtml(t.order)}</div>
    <div class="num">${escapeHtml(r.posOrderNumber)}</div>
    <div class="badges">
      <span class="badge ${r.paymentStatus === 'paid' ? 'paid' : r.paymentStatus === 'unpaid' ? 'unpaid' : ''}">${escapeHtml(t.payment[r.paymentStatus] ?? r.paymentStatus)}</span>
      <span class="badge">${escapeHtml(t.kitchen[r.kitchenStatus] ?? r.kitchenStatus)}</span>
      <span class="badge">${escapeHtml(r.fulfillment === 'dine_in' ? t.dineIn : t.takeaway)}</span>
      ${r.tableNumber ? `<span class="badge">${escapeHtml(t.table)} ${escapeHtml(r.tableNumber)}</span>` : ''}
    </div>
  </div>

  <table>${lines}</table>

  <table class="totals">
    ${r.surchargeMinor || r.discountMinor ? row(escapeHtml(t.items), r.itemsSubtotalMinor) : ''}
    ${r.surchargeMinor ? row(escapeHtml(t.surcharge), r.surchargeMinor) : ''}
    ${r.discountMinor ? row(escapeHtml(t.discount), -r.discountMinor) : ''}
    <tr class="grand"><td colspan="2">${escapeHtml(t.total)}</td><td class="amt">${amount(r.totalMinor)}</td></tr>
  </table>

  ${r.vatIncludedMinor ? `<p class="vat">${escapeHtml(t.vat(amount(r.vatIncludedMinor)))}</p>` : ''}

  <footer>
    ${escapeHtml(fmtTime(r.issuedAt))}<br>
    ${escapeHtml(t.expires(fmtDate(r.expiresAt)))}
  </footer>
</div>
</body>
</html>`;
}

function errorPage(kind, lang = 'en') {
  const t = T[lang];
  const message = kind === 'not_found' ? t.unavailable : t.failed;
  const rtl = lang === 'ar';
  return `<!doctype html><html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(t.receipt)}</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#f4efe8;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,"Noto Sans Arabic",sans-serif;color:#2e2217;padding:24px}
div{max-width:360px;text-align:center;background:#fff;padding:30px 24px;border-radius:14px;box-shadow:0 2px 14px rgba(70,50,30,.13)}</style></head>
<body><div><p>${escapeHtml(message)}</p></div></body></html>`;
}
