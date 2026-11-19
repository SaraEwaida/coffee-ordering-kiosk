export const brand = 'BEAN & BLOOM'; // Change to your shop name.
export const currency = 'USD'; // Demo currency; change before opening for customers.
export const formatPrice = value => new Intl.NumberFormat('en-US', { style:'currency', currency }).format(value || 0);
export const displayName = (product, lang) => lang === 'ar' ? (product.nameAr || product.name) : product.name;
export const optionsText = (options, lang) => {
  const names = {
    size: {small:['Small','صغير'],medium:['Medium','وسط'],large:['Large','كبير']},
    milk:{regular:['Regular milk','حليب عادي'],oat:['Oat milk','حليب شوفان'],almond:['Almond milk','حليب لوز'],none:['No milk','بدون حليب']},
    syrup:{none:['No syrup','بدون نكهة'],vanilla:['Vanilla','فانيلا'],caramel:['Caramel','كراميل']},
  };
  const at=lang==='ar'?1:0;
  return [names.size[options.size]?.[at], names.milk[options.milk]?.[at], names.syrup[options.syrup]?.[at],
    `${lang==='ar'?'سكر':'Sugar'}: ${options.sugar}`, options.extraShot ? (lang==='ar'?'شوت إضافي':'Extra shot') : null].filter(Boolean).join(' · ');
};
