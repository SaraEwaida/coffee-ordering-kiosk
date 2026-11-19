import React, { useState } from 'react';
import { Check, Coffee, ShoppingBag, Wallet, Store, ArrowLeft, ArrowRight } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import { displayName, formatPrice } from '../config.js';
export default function Checkout({t,lang,cart,onLanguage,onBack,onCart,cartCount,onPlace,placing,error}) {
  const [fulfillment,setFulfillment]=useState('takeaway');
  const [customerName,setCustomerName]=useState('');
  const total=cart.reduce((s,i)=>s+i.unitPrice*i.quantity,0);
  return <div className="inner-screen"><TopBar {...{t,lang,onLanguage,onBack,onCart,cartCount}} section="CHECKOUT"/>
    <main className="page-width checkout-page"><div className="page-heading simple-heading"><div><div className="eyebrow">✳ CHECKOUT</div><h1>{t.details}</h1><p>{t.detailsSub}</p></div></div>
      <div className="checkout-grid"><div className="checkout-fields">
        <div className="field-group"><h3>{t.orderType}</h3><div className="fulfillment-row"><button onClick={()=>setFulfillment('takeaway')} className={`fulfillment-choice ${fulfillment==='takeaway'?'active':''}`}><ShoppingBag size={28}/><strong>{t.takeaway}</strong>{fulfillment==='takeaway'&&<Check size={20}/>}</button>
          <button onClick={()=>setFulfillment('dine_in')} className={`fulfillment-choice ${fulfillment==='dine_in'?'active':''}`}><Store size={28}/><strong>{t.dineIn}</strong>{fulfillment==='dine_in'&&<Check size={20}/>}</button></div></div>
        <div className="field-group"><label htmlFor="customerName">{t.name}</label><input id="customerName" type="text" maxLength={40} value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder={t.namePlaceholder} autoComplete="off"/></div>
        <div className="field-group"><h3>{t.payment}</h3><div className="pay-choice"><Wallet size={28}/><div><strong>{t.cash}</strong><p>{t.cashSub}</p></div><Check size={21}/></div></div>
      </div>
      <aside className="summary-card"><h2>{t.summary}</h2><div className="checkout-order-lines">{cart.map(i=><div key={i.key} className="summary-line"><span>{i.quantity} × {displayName(i.product,lang)}</span><strong>{formatPrice(i.unitPrice*i.quantity)}</strong></div>)}</div>
      <div className="summary-total"><span>{t.total}</span><strong>{formatPrice(total)}</strong></div>
      {error&&<div className="error-box" role="alert">{t.orderError}<small>{error}</small></div>}
      <button className="primary-button full-button" disabled={placing} onClick={()=>onPlace({customerName,fulfillment})}>{placing?t.processing:t.placeOrder}<span className="button-arrow">{lang==='ar'?<ArrowLeft size={22}/>:<ArrowRight size={22}/>}</span></button>
      <p className="demo-hint">{t.demo}</p></aside></div>
    </main></div>;
}
