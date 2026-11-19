import React from 'react';
import { ArrowRight, ArrowLeft, ShoppingBag, Trash2 } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import Stepper from '../components/Stepper.jsx';
import { displayName, formatPrice, optionsText } from '../config.js';
export default function Cart({t,lang,cart,onLanguage,onBack,onCart,cartCount,onCheckout,onChangeQty,onRemove}) {
  const total=cart.reduce((s,item)=>s+item.unitPrice*item.quantity,0);
  return <div className="inner-screen"><TopBar {...{t,lang,onLanguage,onBack,onCart,cartCount}} section="YOUR CART"/>
    <main className="page-width cart-page"><div className="page-heading simple-heading"><div><div className="eyebrow">✳ {t.summary}</div><h1>{t.cart}</h1></div></div>
      {!cart.length ? <div className="empty-state"><ShoppingBag size={56}/><h2>{t.emptyCart}</h2><p>{t.emptyCartSub}</p><button className="primary-button" onClick={onBack}>{t.keepShopping}</button></div>:
      <div className="checkout-grid"><div className="cart-items">{cart.map(item=><div className="cart-item" key={item.key}>
        <img src={item.product.image} alt=""/><div className="cart-item-info"><h3>{displayName(item.product,lang)}</h3><p>{optionsText(item.options,lang)}</p><button className="link-button" onClick={()=>onRemove(item.key)}><Trash2 size={15}/>{t.remove}</button></div>
        <div className="cart-item-end"><strong>{formatPrice(item.unitPrice*item.quantity)}</strong><Stepper compact value={item.quantity} min={1} onChange={v=>onChangeQty(item.key,v)}/></div>
      </div>)}</div>
      <aside className="summary-card"><h2>{t.summary}</h2><div className="summary-line"><span>{t.subtotal}</span><strong>{formatPrice(total)}</strong></div><div className="summary-total"><span>{t.total}</span><strong>{formatPrice(total)}</strong></div>
        <button className="primary-button full-button" onClick={onCheckout}>{t.checkout}<span className="button-arrow">{lang==='ar'?<ArrowLeft size={22}/>:<ArrowRight size={22}/>}</span></button>
        <p className="demo-hint">{t.demo}</p>
      </aside></div>}
    </main>
  </div>;
}
