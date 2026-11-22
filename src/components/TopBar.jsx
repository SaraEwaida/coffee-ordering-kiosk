import React from 'react';
import { ArrowLeft, ArrowRight, Coffee, ShoppingBag, Globe2, Home } from 'lucide-react';
import { FALLBACK_BRAND } from '../config.js';

export default function TopBar({
  t, lang, onLanguage, onBack, onHome, onCart, cartCount = 0, section = '',
  staff = false, storeName,
}) {
  // The store name comes from the POS via /api/kiosk/config, so rebranding
  // for a new client is configuration rather than a code edit.
  const brand = storeName || FALLBACK_BRAND;
  const BackIcon = lang === 'ar' ? ArrowRight : ArrowLeft;
  return <header className="topbar">
    <div className="topbar-side">
      {onBack ? <button className="round-button" onClick={onBack} aria-label={t.back}><BackIcon size={24}/></button> :
        onHome ? <button className="round-button" onClick={onHome} aria-label={t.home}><Home size={23}/></button> : <span className="brand-mark"><Coffee size={24}/></span>}
      <span className="brand-name">{brand}<small>{section || 'SPECIALTY COFFEE'}</small></span>
    </div>
    <div className="topbar-side right-controls">
      <button className="language-button" onClick={onLanguage}><Globe2 size={20}/>{lang === 'en' ? 'العربية' : 'English'}</button>
      {!staff && onCart && <button className="cart-button" onClick={onCart} aria-label={t.cart}>
        <ShoppingBag size={22}/><span className="cart-label">{t.cart}</span>{cartCount>0 && <span className="count-bubble">{cartCount}</span>}
      </button>}
    </div>
  </header>;
}
