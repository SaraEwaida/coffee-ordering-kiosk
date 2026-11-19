import React from 'react';
import { ArrowUpRight, ArrowUpLeft } from 'lucide-react';
import { displayName, formatPrice } from '../config.js';
export default function ProductCard({product,lang,t,onClick}) {
  const Icon=lang==='ar'?ArrowUpLeft:ArrowUpRight;
  return <button type="button" className={`product-card ${!product.available?'product-unavailable':''}`} disabled={!product.available} onClick={()=>onClick(product)}>
    <div className="product-photo"><img src={product.image} alt={displayName(product,lang)} loading="lazy"/>
      {product.popular && <span className="photo-label">✦ {t.popular}</span>}
      {!product.available && <span className="soldout-photo">{t.unavailable}</span>}
    </div>
    <div className="product-body">
      <div><h3>{displayName(product,lang)}</h3><p>{lang==='ar'?product.descriptionAr:product.description}</p></div>
      <div className="product-foot"><strong>{formatPrice(product.price)}</strong><span className="small-arrow"><Icon size={21}/></span></div>
    </div>
  </button>;
}
