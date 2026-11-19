/** Sample menu and prices. Change these values for your actual shop. */
export const initialProducts = [
  { id: 'espresso', name: 'Espresso', nameAr: 'إسبريسو', description: 'Rich, smooth and full-bodied.', descriptionAr: 'قهوة غنية بنكهة قوية.', category: 'hot', price: 2.5, image: '/images/espresso.webp', available: true, popular: false },
  { id: 'cappuccino', name: 'Cappuccino', nameAr: 'كابتشينو', description: 'Double espresso and fluffy milk foam.', descriptionAr: 'إسبريسو مع رغوة حليب كثيفة.', category: 'hot', price: 4.25, image: '/images/cappuccino.webp', available: true, popular: true },
  { id: 'latte', name: 'Caffè Latte', nameAr: 'كافيه لاتيه', description: 'Velvety steamed milk and espresso.', descriptionAr: 'إسبريسو مع الحليب المبخر.', category: 'hot', price: 4.5, image: '/images/latte.webp', available: true, popular: true },
  { id: 'iced-latte', name: 'Iced Latte', nameAr: 'آيس لاتيه', description: 'Chilled espresso and creamy milk.', descriptionAr: 'إسبريسو بارد مع الحليب والثلج.', category: 'iced', price: 4.75, image: '/images/iced-latte.webp', available: true, popular: true },
  { id: 'mocha', name: 'Chocolate Mocha', nameAr: 'موكا بالشوكولاتة', description: 'Chocolate, espresso and whipped cream.', descriptionAr: 'شوكولاتة وإسبريسو وكريمة.', category: 'hot', price: 5.25, image: '/images/mocha.webp', available: true, popular: false },
  { id: 'cold-brew', name: 'Cold Brew', nameAr: 'كولد برو', description: 'Slow-steeped coffee served over ice.', descriptionAr: 'قهوة منقوعة ببطء وتقدم باردة.', category: 'iced', price: 4.25, image: '/images/cold-brew.webp', available: true, popular: false },
];

export const sizes = [
  { id: 'small', name: 'Small', ar: 'صغير', extra: 0 },
  { id: 'medium', name: 'Medium', ar: 'وسط', extra: 0.75 },
  { id: 'large', name: 'Large', ar: 'كبير', extra: 1.5 },
];
export const milks = [
  { id: 'regular', name: 'Regular', ar: 'عادي', extra: 0 },
  { id: 'oat', name: 'Oat milk', ar: 'حليب شوفان', extra: 0.65 },
  { id: 'almond', name: 'Almond milk', ar: 'حليب لوز', extra: 0.65 },
  { id: 'none', name: 'No milk', ar: 'بدون حليب', extra: 0 },
];
export const syrups = [
  { id: 'none', name: 'No syrup', ar: 'بدون شراب', extra: 0 },
  { id: 'vanilla', name: 'Vanilla', ar: 'فانيلا', extra: 0.6 },
  { id: 'caramel', name: 'Caramel', ar: 'كراميل', extra: 0.6 },
];

export function validOptions(input = {}) {
  const options = {
    size: String(input.size || 'medium'),
    milk: String(input.milk || 'regular'),
    syrup: String(input.syrup || 'none'),
    sugar: Number(input.sugar ?? 0),
    extraShot: Boolean(input.extraShot),
  };
  if (!sizes.some((o) => o.id === options.size)) throw new Error('Invalid cup size');
  if (!milks.some((o) => o.id === options.milk)) throw new Error('Invalid milk choice');
  if (!syrups.some((o) => o.id === options.syrup)) throw new Error('Invalid syrup choice');
  if (![0,1,2,3].includes(options.sugar)) throw new Error('Invalid sugar selection');
  return options;
}
export const unitPrice = (product, options) => {
  const o = validOptions(options);
  return Math.round((Number(product.price) + sizes.find(s=>s.id===o.size).extra + milks.find(s=>s.id===o.milk).extra + syrups.find(s=>s.id===o.syrup).extra + (o.extraShot ? 1 : 0)) * 100) / 100;
};
