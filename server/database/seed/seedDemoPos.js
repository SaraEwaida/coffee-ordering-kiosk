import { withTransaction } from '../connection.js';

/**
 * Demo POS seed data.
 *
 * Product and modifier IDs here deliberately look like a real till's IDs
 * ("PRD-1003", "MOD-MILK-OAT") and NOT like the kiosk's old keys ("latte",
 * "oat"). That is on purpose: a client's POS will never use our identifiers, so
 * the kiosk has to go through `kiosk_item_mappings` to reach them. Seeding
 * POS-shaped IDs means the mapping layer is exercised from day one instead of
 * appearing to work because both sides happened to agree.
 *
 * Prices are in agorot (ILS minor units) and are VAT-INCLUSIVE at 16%.
 */

const CATEGORIES = [
  { id: 'CAT-HOT', nameEn: 'Hot coffee', nameAr: 'قهوة ساخنة', order: 10 },
  { id: 'CAT-ICED', nameEn: 'Iced coffee', nameAr: 'قهوة باردة', order: 20 },
  // Sits between the drinks and the pastries: a sugar-free range is a
  // selling point, not an afterthought, so it is not buried at the end.
  { id: 'CAT-HEALTHY', nameEn: 'Sugar-free & light', nameAr: 'بدون سكر وخفيف', order: 25 },
  { id: 'CAT-PASTRY', nameEn: 'Pastries', nameAr: 'معجنات', order: 30 },
  { id: 'CAT-SNACK', nameEn: 'Snacks', nameAr: 'وجبات خفيفة', order: 40 },
];

const PRODUCTS = [
  // --- the six coffees carried over from Version 3, repriced in shekels ---
  { id: 'PRD-1001', sku: 'COF-ESP-01', category: 'CAT-HOT', nameEn: 'Espresso', nameAr: 'إسبريسو',
    descEn: 'Rich, smooth and full-bodied.', descAr: 'قهوة غنية بنكهة قوية.',
    priceMinor: 900, image: '/images/espresso.webp', order: 10, legacyKey: 'espresso' },
  { id: 'PRD-1002', sku: 'COF-CAP-01', category: 'CAT-HOT', nameEn: 'Cappuccino', nameAr: 'كابتشينو',
    descEn: 'Double espresso and fluffy milk foam.', descAr: 'إسبريسو مع رغوة حليب كثيفة.',
    priceMinor: 1500, image: '/images/cappuccino.webp', order: 20, legacyKey: 'cappuccino' },
  { id: 'PRD-1003', sku: 'COF-LAT-01', category: 'CAT-HOT', nameEn: 'Caffè Latte', nameAr: 'كافيه لاتيه',
    descEn: 'Velvety steamed milk and espresso.', descAr: 'إسبريسو مع الحليب المبخر.',
    priceMinor: 1600, image: '/images/latte.webp', order: 30, legacyKey: 'latte' },
  { id: 'PRD-1004', sku: 'COF-ICL-01', category: 'CAT-ICED', nameEn: 'Iced Latte', nameAr: 'آيس لاتيه',
    descEn: 'Chilled espresso and creamy milk.', descAr: 'إسبريسو بارد مع الحليب والثلج.',
    priceMinor: 1700, image: '/images/iced-latte.webp', order: 40, legacyKey: 'iced-latte' },
  { id: 'PRD-1005', sku: 'COF-MOC-01', category: 'CAT-HOT', nameEn: 'Chocolate Mocha', nameAr: 'موكا بالشوكولاتة',
    descEn: 'Chocolate, espresso and whipped cream.', descAr: 'شوكولاتة وإسبريسو وكريمة.',
    priceMinor: 1900, image: '/images/mocha.webp', order: 50, legacyKey: 'mocha' },
  { id: 'PRD-1006', sku: 'COF-CDB-01', category: 'CAT-ICED', nameEn: 'Cold Brew', nameAr: 'كولد برو',
    descEn: 'Slow-steeped coffee served over ice.', descAr: 'قهوة منقوعة ببطء وتقدم باردة.',
    priceMinor: 1500, image: '/images/cold-brew.webp', order: 60, legacyKey: 'cold-brew' },

  // --- food, required by Phase 1 so the upsell and category rules have something to work with ---
  { id: 'PRD-2001', sku: 'PAS-CRO-01', category: 'CAT-PASTRY', nameEn: 'Butter Croissant', nameAr: 'كرواسان بالزبدة',
    descEn: 'Baked each morning, flaky and light.', descAr: 'يُخبز كل صباح، هش وطري.',
    priceMinor: 800, image: '', order: 10, legacyKey: null },
  { id: 'PRD-2002', sku: 'PAS-MAN-01', category: 'CAT-PASTRY', nameEn: "Za'atar Manakish", nameAr: 'مناقيش زعتر',
    descEn: 'Stone-baked dough with za’atar and olive oil.', descAr: 'عجينة بالزعتر وزيت الزيتون.',
    priceMinor: 700, image: '', order: 20, legacyKey: null },
  { id: 'PRD-2003', sku: 'PAS-MUF-01', category: 'CAT-PASTRY', nameEn: 'Chocolate Muffin', nameAr: 'مافن شوكولاتة',
    descEn: 'Dark chocolate chunks, soft centre.', descAr: 'قطع شوكولاتة داكنة وقلب طري.',
    priceMinor: 1000, image: '', order: 30, legacyKey: null },
  { id: 'PRD-2004', sku: 'PAS-SAM-01', category: 'CAT-PASTRY', nameEn: 'Cheese Sambousek', nameAr: 'سمبوسك جبنة',
    descEn: 'Warm pastry filled with white cheese.', descAr: 'معجنات دافئة محشوة بالجبنة البيضاء.',
    priceMinor: 900, image: '', order: 40, legacyKey: null },
  { id: 'PRD-3001', sku: 'SNK-DAT-01', category: 'CAT-SNACK', nameEn: 'Date Cookies', nameAr: 'كعك بالعجوة',
    descEn: 'Two semolina cookies filled with dates.', descAr: 'قطعتان من كعك السميد بالعجوة.',
    priceMinor: 600, image: '', order: 10, legacyKey: null },
  { id: 'PRD-3002', sku: 'SNK-NUT-01', category: 'CAT-SNACK', nameEn: 'Mixed Nuts', nameAr: 'مكسرات مشكلة',
    descEn: 'Lightly salted almonds, cashews and pistachios.', descAr: 'لوز وكاجو وفستق بملح خفيف.',
    priceMinor: 1200, image: '', order: 20, legacyKey: null },

  // --- sugar-free and light ---
  // Nothing here has added sugar. Sweetness comes from dates or fruit, which
  // is what makes the claim on the category honest rather than marketing.
  { id: 'PRD-4001', sku: 'SF-AVO-01', category: 'CAT-HEALTHY', nameEn: 'Avocado & Za\u2019atar Toast', nameAr: 'توست أفوكادو وزعتر',
    descEn: 'Smashed avocado, za\u2019atar and olive oil on sourdough.', descAr: 'أفوكادو مهروس مع الزعتر وزيت الزيتون على خبز العجين المخمر.',
    priceMinor: 2200, image: '/images/food/avocado-toast.svg', order: 10, legacyKey: null },
  { id: 'PRD-4002', sku: 'SF-YOG-01', category: 'CAT-HEALTHY', nameEn: 'Greek Yogurt & Walnuts', nameAr: 'لبنة يونانية بالجوز',
    descEn: 'Thick yogurt with walnuts. No added sugar.', descAr: 'لبن يوناني كثيف مع الجوز. بدون سكر مضاف.',
    priceMinor: 1600, image: '/images/food/yogurt.svg', order: 20, legacyKey: null },
  { id: 'PRD-4003', sku: 'SF-BAL-01', category: 'CAT-HEALTHY', nameEn: 'Date & Oat Energy Balls', nameAr: 'كرات التمر والشوفان',
    descEn: 'Three balls of dates, oats and almonds. Sweetened only by the dates.', descAr: 'ثلاث كرات من التمر والشوفان واللوز. محلاة بالتمر فقط.',
    priceMinor: 900, image: '/images/food/energy-balls.svg', order: 30, legacyKey: null },
  { id: 'PRD-4004', sku: 'SF-CAK-01', category: 'CAT-HEALTHY', nameEn: 'Sugar-Free Almond Cake', nameAr: 'كيك اللوز بدون سكر',
    descEn: 'Ground almond cake, no added sugar.', descAr: 'كيك دقيق اللوز بدون سكر مضاف.',
    priceMinor: 1400, image: '/images/food/almond-cake.svg', order: 40, legacyKey: null },
  { id: 'PRD-4005', sku: 'SF-LEM-01', category: 'CAT-HEALTHY', nameEn: 'Fresh Mint Lemonade', nameAr: 'ليموناضة بالنعناع',
    descEn: 'Pressed lemon and fresh mint. Unsweetened by default.', descAr: 'ليمون معصور ونعناع طازج. بدون تحلية.',
    priceMinor: 1200, image: '/images/food/lemonade.svg', order: 50, legacyKey: null },
];

const GROUPS = [
  { id: 'GRP-SIZE', nameEn: 'Cup size', nameAr: 'حجم الكوب', min: 1, max: 1, order: 10, modifiers: [
    { id: 'MOD-SIZE-S', nameEn: 'Small', nameAr: 'صغير', delta: 0, order: 10 },
    { id: 'MOD-SIZE-M', nameEn: 'Medium', nameAr: 'وسط', delta: 300, order: 20 },
    { id: 'MOD-SIZE-L', nameEn: 'Large', nameAr: 'كبير', delta: 600, order: 30 },
  ] },
  { id: 'GRP-MILK', nameEn: 'Milk', nameAr: 'الحليب', min: 1, max: 1, order: 20, modifiers: [
    { id: 'MOD-MILK-REG', nameEn: 'Regular milk', nameAr: 'حليب عادي', delta: 0, order: 10 },
    { id: 'MOD-MILK-OAT', nameEn: 'Oat milk', nameAr: 'حليب شوفان', delta: 250, order: 20 },
    { id: 'MOD-MILK-ALM', nameEn: 'Almond milk', nameAr: 'حليب لوز', delta: 250, order: 30 },
    { id: 'MOD-MILK-NONE', nameEn: 'No milk', nameAr: 'بدون حليب', delta: 0, order: 40 },
  ] },
  // max 2 with min 0: choosing nothing means no syrup, so no "None" row is
  // needed. Cleaner than V3's explicit 'none' option.
  { id: 'GRP-SYRUP', nameEn: 'Flavour syrup', nameAr: 'نكهة الشراب', min: 0, max: 2, order: 30, modifiers: [
    { id: 'MOD-SYR-VAN', nameEn: 'Vanilla', nameAr: 'فانيلا', delta: 200, order: 10 },
    { id: 'MOD-SYR-CAR', nameEn: 'Caramel', nameAr: 'كراميل', delta: 200, order: 20 },
    { id: 'MOD-SYR-HAZ', nameEn: 'Hazelnut', nameAr: 'بندق', delta: 200, order: 30 },
  ] },
  { id: 'GRP-SUGAR', nameEn: 'Sugar', nameAr: 'السكر', min: 1, max: 1, order: 40, modifiers: [
    { id: 'MOD-SUG-0', nameEn: 'No sugar', nameAr: 'بدون سكر', delta: 0, order: 10 },
    { id: 'MOD-SUG-1', nameEn: '1 spoon', nameAr: 'ملعقة واحدة', delta: 0, order: 20 },
    { id: 'MOD-SUG-2', nameEn: '2 spoons', nameAr: 'ملعقتان', delta: 0, order: 30 },
    { id: 'MOD-SUG-3', nameEn: '3 spoons', nameAr: 'ثلاث ملاعق', delta: 0, order: 40 },
    // Alternatives to sugar, in the same single-choice group: choosing one of
    // these IS choosing no sugar, so the two can never be selected together.
    { id: 'MOD-SUG-STEVIA', nameEn: 'Stevia (sugar-free)', nameAr: 'ستيفيا (بدون سكر)', delta: 0, order: 50 },
    { id: 'MOD-SUG-DATE', nameEn: 'Date syrup', nameAr: 'دبس التمر', delta: 150, order: 60 },
  ] },
  { id: 'GRP-EXTRA', nameEn: 'Extras', nameAr: 'إضافات', min: 0, max: 3, order: 50, modifiers: [
    { id: 'MOD-EXT-SHOT', nameEn: 'Extra espresso shot', nameAr: 'شوت إسبريسو إضافي', delta: 350, order: 10 },
    { id: 'MOD-EXT-CREAM', nameEn: 'Whipped cream', nameAr: 'كريمة مخفوقة', delta: 200, order: 20 },
    { id: 'MOD-EXT-CINN', nameEn: 'Cinnamon', nameAr: 'قرفة', delta: 0, order: 30 },
  ] },
  { id: 'GRP-WARM', nameEn: 'Served warm', nameAr: 'التقديم دافئاً', min: 0, max: 1, order: 10, modifiers: [
    { id: 'MOD-WARM-YES', nameEn: 'Warm it up', nameAr: 'سخنها', delta: 0, order: 10 },
  ] },
];

/** Which groups attach to which product, and whether the group is required there. */
const ATTACHMENTS = {
  // Espresso has no milk group at all — proves groups are per-product, not global.
  'PRD-1001': [['GRP-SIZE', 1], ['GRP-SUGAR', 1], ['GRP-EXTRA', 0]],
  'PRD-1002': [['GRP-SIZE', 1], ['GRP-MILK', 1], ['GRP-SYRUP', 0], ['GRP-SUGAR', 1], ['GRP-EXTRA', 0]],
  'PRD-1003': [['GRP-SIZE', 1], ['GRP-MILK', 1], ['GRP-SYRUP', 0], ['GRP-SUGAR', 1], ['GRP-EXTRA', 0]],
  'PRD-1004': [['GRP-SIZE', 1], ['GRP-MILK', 1], ['GRP-SYRUP', 0], ['GRP-SUGAR', 1], ['GRP-EXTRA', 0]],
  'PRD-1005': [['GRP-SIZE', 1], ['GRP-MILK', 1], ['GRP-SYRUP', 0], ['GRP-SUGAR', 1], ['GRP-EXTRA', 0]],
  'PRD-1006': [['GRP-SIZE', 1], ['GRP-MILK', 1], ['GRP-SYRUP', 0], ['GRP-SUGAR', 1], ['GRP-EXTRA', 0]],
  'PRD-2001': [['GRP-WARM', 0]],
  'PRD-2002': [['GRP-WARM', 0]],
  'PRD-2003': [['GRP-WARM', 0]],
  'PRD-2004': [['GRP-WARM', 0]],
  'PRD-3001': [],
  'PRD-3002': [],
  // Light food takes the warm option; the lemonade is a drink, so it gets a
  // size and a sweetener choice but obviously no milk.
  'PRD-4001': [['GRP-WARM', 0]],
  'PRD-4002': [],
  'PRD-4003': [],
  'PRD-4004': [['GRP-WARM', 0]],
  'PRD-4005': [['GRP-SIZE', 1], ['GRP-SUGAR', 1]],
};

const PROMOTIONS = [
  { id: 'PRM-0001', code: 'WELCOME10', kind: 'percent', value: 1000, minSubtotalMinor: 0 },
  { id: 'PRM-0002', code: 'BLOOM5', kind: 'fixed', value: 500, minSubtotalMinor: 2000 },
];

// Demo gift cards. Balances are chosen so one card covers an order outright,
// one covers part of it (to exercise split payment in Phase 3), and one is empty.
const GIFT_CARDS = [
  { id: 'GC-0001', code: 'DEMO-GIFT-5000', balanceMinor: 5000 },
  { id: 'GC-0002', code: 'DEMO-GIFT-1200', balanceMinor: 1200 },
  { id: 'GC-0003', code: 'DEMO-GIFT-0000', balanceMinor: 0 },
];

const CONFIG = {
  store_id: 'store-demo',
  store_name_en: 'Bean & Bloom',
  store_name_ar: 'بين آند بلوم',
  currency: 'ILS',
  default_tax_rate_bp: '1600',
  dine_in_surcharge_kind: 'fixed',
  dine_in_surcharge_value: '200',
  dine_in_surcharge_label_en: 'Dine-in service',
  dine_in_surcharge_label_ar: 'خدمة الجلوس',
};

/**
 * Idempotent seed: safe to run on every boot. Uses INSERT OR IGNORE so a
 * manager's price change is never overwritten by a restart — the seed
 * establishes rows that do not exist and then leaves them alone.
 */
export function seedDemoPos(db, { logger } = {}) {
  const alreadySeeded = db.prepare('SELECT COUNT(*) AS n FROM pos_products').get().n > 0;

  withTransaction(db, () => {
    for (const [key, value] of Object.entries(CONFIG)) {
      db.prepare('INSERT OR IGNORE INTO pos_store_config (key, value) VALUES (?, ?)').run(key, value);
    }
    for (const category of CATEGORIES) {
      db.prepare('INSERT OR IGNORE INTO pos_categories (id, name_en, name_ar, display_order) VALUES (?,?,?,?)')
        .run(category.id, category.nameEn, category.nameAr, category.order);
    }
    const taxRate = Number(CONFIG.default_tax_rate_bp);
    for (const product of PRODUCTS) {
      db.prepare(
        `INSERT OR IGNORE INTO pos_products
           (id, sku, category_id, name_en, name_ar, description_en, description_ar,
            price_minor, tax_rate_bp, available, display_order, image_hint)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
      ).run(product.id, product.sku, product.category, product.nameEn, product.nameAr,
        product.descEn, product.descAr, product.priceMinor, taxRate, product.order, product.image);
    }
    for (const group of GROUPS) {
      db.prepare(
        'INSERT OR IGNORE INTO pos_modifier_groups (id, name_en, name_ar, min_select, max_select, display_order) VALUES (?,?,?,?,?,?)',
      ).run(group.id, group.nameEn, group.nameAr, group.min, group.max, group.order);
      for (const modifier of group.modifiers) {
        db.prepare(
          'INSERT OR IGNORE INTO pos_modifiers (id, group_id, name_en, name_ar, price_delta_minor, available, display_order) VALUES (?,?,?,?,?,1,?)',
        ).run(modifier.id, group.id, modifier.nameEn, modifier.nameAr, modifier.delta, modifier.order);
      }
    }
    for (const [productId, groups] of Object.entries(ATTACHMENTS)) {
      groups.forEach(([groupId, required], index) => {
        db.prepare(
          'INSERT OR IGNORE INTO pos_product_modifier_groups (product_id, group_id, required, display_order) VALUES (?,?,?,?)',
        ).run(productId, groupId, required, (index + 1) * 10);
      });
    }
    for (const promotion of PROMOTIONS) {
      db.prepare(
        'INSERT OR IGNORE INTO pos_promotions (id, code, kind, value, min_subtotal_minor) VALUES (?,?,?,?,?)',
      ).run(promotion.id, promotion.code, promotion.kind, promotion.value, promotion.minSubtotalMinor);
    }
    for (const card of GIFT_CARDS) {
      db.prepare(
        'INSERT OR IGNORE INTO pos_gift_cards (id, code, balance_minor, currency) VALUES (?,?,?,?)',
      ).run(card.id, card.code, card.balanceMinor, CONFIG.currency);
      db.prepare(
        `INSERT OR IGNORE INTO pos_gift_card_ledger (id, gift_card_id, delta_minor, balance_after_minor, kind)
         VALUES (?,?,?,?,'issue')`,
      ).run(`${card.id}-ISSUE`, card.id, card.balanceMinor, card.balanceMinor);
    }
  });

  if (!alreadySeeded) logger?.info?.('demopos.seeded', { products: PRODUCTS.length, groups: GROUPS.length });
  return { seeded: !alreadySeeded, products: PRODUCTS.length };
}

/** Legacy key -> POS product ID, used to build kiosk_item_mappings. */
export function legacyProductKeyMap() {
  return PRODUCTS.filter((p) => p.legacyKey).map((p) => ({ legacyKey: p.legacyKey, posProductId: p.id }));
}

/**
 * Legacy V3 option values -> POS modifier IDs. V3 stored options as a JSON blob
 * ({size:'medium', milk:'oat', ...}); this is how those become real modifier IDs.
 */
export function legacyOptionModifierMap() {
  return {
    size: { small: 'MOD-SIZE-S', medium: 'MOD-SIZE-M', large: 'MOD-SIZE-L' },
    milk: { regular: 'MOD-MILK-REG', oat: 'MOD-MILK-OAT', almond: 'MOD-MILK-ALM', none: 'MOD-MILK-NONE' },
    syrup: { none: null, vanilla: 'MOD-SYR-VAN', caramel: 'MOD-SYR-CAR' },
    sugar: { 0: 'MOD-SUG-0', 1: 'MOD-SUG-1', 2: 'MOD-SUG-2', 3: 'MOD-SUG-3' },
    extraShot: { true: 'MOD-EXT-SHOT', false: null },
  };
}

export { PRODUCTS, GROUPS, CATEGORIES, CONFIG, GIFT_CARDS, PROMOTIONS };
