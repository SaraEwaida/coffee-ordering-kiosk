import React from 'react';
import { ArrowUpRight, ArrowUpLeft } from 'lucide-react';
import { productName, productDescription, formatMinor } from '../config.js';

/**
 * A product tile.
 *
 * Price and availability come straight from the POS snapshot. The photo,
 * description, allergens and calories may have come from a kiosk content
 * overlay, which can enrich presentation but can never change a price or
 * resurrect a sold-out item.
 */
export default function ProductCard({ product, lang, t, currency, onClick }) {
  const Icon = lang === 'ar' ? ArrowUpLeft : ArrowUpRight;
  const name = productName(product, lang);
  const description = productDescription(product, lang);
  const allergens = lang === 'ar' ? product.allergensAr : product.allergensEn;

  return (
    <button
      type="button"
      className={`product-card ${!product.available ? 'product-unavailable' : ''}`}
      disabled={!product.available}
      onClick={() => onClick(product)}
    >
      <div className="product-photo">
        {product.imageUrl
          ? <img src={product.imageUrl} alt={name} loading="lazy" />
          : <span className="product-photo-fallback" aria-hidden="true">{initials(name)}</span>}
        {!product.available && <span className="soldout-photo">{t.unavailable}</span>}
      </div>
      <div className="product-body">
        <div>
          <h3>{name}</h3>
          {description && <p>{description}</p>}
          {(product.calories != null || allergens) && (
            <p className="product-meta">
              {product.calories != null && <span>{product.calories} {t.calories}</span>}
              {product.calories != null && allergens && <span aria-hidden="true"> · </span>}
              {allergens && <span>{t.allergens}: {allergens}</span>}
            </p>
          )}
        </div>
        <div className="product-foot">
          <strong>{formatMinor(product.priceMinor, currency, lang)}</strong>
          <span className="small-arrow"><Icon size={21} /></span>
        </div>
      </div>
    </button>
  );
}

/** Food items have no photo yet, so show a readable monogram instead of a gap. */
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}
