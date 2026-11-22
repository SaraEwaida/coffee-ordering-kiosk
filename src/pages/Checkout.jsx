import React, { useState } from 'react';
import { Check, CreditCard, ShoppingBag, Wallet, Store, ArrowLeft, ArrowRight, Smartphone, Gift, Search, BadgeCheck } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import { displayName, formatPrice } from '../config.js';
import { api } from '../api.js';

export default function Checkout({t,lang,cart,onLanguage,onBack,onCart,cartCount,onPlace,placing,error}) {
  const [fulfillment,setFulfillment]=useState('takeaway');
  const [customerName,setCustomerName]=useState('');
  const [paymentMethod,setPaymentMethod]=useState('counter');
  const [loyaltyMode,setLoyaltyMode]=useState('none');
  const [code,setCode]=useState('');
  const [member,setMember]=useState(null);
  const [checking,setChecking]=useState(false);
  const [lookupError,setLookupError]=useState('');
  const [redeemPoints,setRedeemPoints]=useState(0);
  const subtotal=cart.reduce((s,i)=>s+i.unitPrice*i.quantity,0);
  const discount=redeemPoints===50?5:redeemPoints===100?10:0;
  const total=Math.max(0,Math.round((subtotal-discount)*100)/100);
  const canRedeem=n=>Boolean(member&&member.points>=n&&subtotal>=n/10);
  function chooseMode(mode){setLoyaltyMode(mode);setMember(null);setRedeemPoints(0);setLookupError('');}
  async function checkCard(){
    setChecking(true);setLookupError('');setMember(null);setRedeemPoints(0);
    try{const found=await api.loyalty(code.trim().replace(/[ -]/g,'').toUpperCase());setMember(found);setCode(found.code);}
    catch(e){setLookupError(e.message);}
    finally{setChecking(false);}
  }
  const canPlace=!placing&&cart.length>0&&(loyaltyMode!=='existing'||Boolean(member));
  return <div className="inner-screen"><TopBar {...{t,lang,onLanguage,onBack,onCart,cartCount}} section="CHECKOUT"/>
    <main className="page-width checkout-page"><div className="page-heading simple-heading"><div><div className="eyebrow">✳ CHECKOUT</div><h1>{t.details}</h1><p>{t.detailsSub}</p></div></div>
      <div className="checkout-grid"><div className="checkout-fields">
        <div className="field-group"><h3>{t.orderType}</h3><div className="fulfillment-row"><button onClick={()=>setFulfillment('takeaway')} className={`fulfillment-choice ${fulfillment==='takeaway'?'active':''}`}><ShoppingBag size={28}/><strong>{t.takeaway}</strong>{fulfillment==='takeaway'&&<Check size={20}/>}</button>
          <button onClick={()=>setFulfillment('dine_in')} className={`fulfillment-choice ${fulfillment==='dine_in'?'active':''}`}><Store size={28}/><strong>{t.dineIn}</strong>{fulfillment==='dine_in'&&<Check size={20}/>}</button></div></div>
        <div className="field-group"><label htmlFor="customerName">{t.name}</label><input id="customerName" type="text" maxLength={40} value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder={t.namePlaceholder} autoComplete="off"/></div>
        <div className="field-group"><h3>{t.payment}</h3><div className="payment-choices" role="group" aria-label={t.payment}>
          <button type="button" aria-pressed={paymentMethod==='counter'} className={`pay-choice ${paymentMethod==='counter'?'selected':''}`} onClick={()=>setPaymentMethod('counter')}><Wallet size={27}/><div><strong>{t.cash}</strong><p>{t.cashSub}</p></div>{paymentMethod==='counter'&&<Check size={21}/>}</button>
          <button type="button" aria-pressed={paymentMethod==='card_terminal'} className={`pay-choice ${paymentMethod==='card_terminal'?'selected':''}`} onClick={()=>setPaymentMethod('card_terminal')}><CreditCard size={27}/><div><strong>{t.cardTerminal}</strong><p>{t.cardTerminalSub}</p><span className="card-brands">VISA · Mastercard</span></div>{paymentMethod==='card_terminal'&&<Check size={21}/>}</button>
        </div></div>
        <section className="field-group rewards-checkout" aria-label={t.rewards}>
          <div className="rewards-section-title"><span className="rewards-icon"><Gift size={24}/></span><div><h3>{t.rewards}</h3><p>{t.rewardsSub}</p></div></div>
          <div className="rewards-choice-list">
            {[['none',t.noRewards],['join',t.joinRewards],['existing',t.haveCard]].map(([mode,label])=><button key={mode} className={`rewards-choice ${loyaltyMode===mode?'active':''}`} aria-pressed={loyaltyMode===mode} type="button" onClick={()=>chooseMode(mode)}><span className="rewards-choice-dot">{loyaltyMode===mode&&<Check size={13}/>}</span>{label}</button>)}
          </div>
          {loyaltyMode==='join'&&<div className="rewards-notice"><BadgeCheck size={20}/><div>{t.saveCard}<small>{t.earnAfterPayment}</small></div></div>}
          {loyaltyMode==='existing'&&<div className="rewards-member-entry">
            <label htmlFor="rewardCode">{t.cardCode}</label>
            <div className="code-input-row"><input id="rewardCode" value={code} maxLength={32} autoCapitalize="characters" autoComplete="off" placeholder="A1B2C3D4E5F6G7H8I9J0" onChange={e=>{setCode(e.target.value);setMember(null);setRedeemPoints(0);}}/><button type="button" className="outline-button" disabled={checking||!code.trim()} onClick={checkCard}><Search size={16}/>{checking?'…':t.checkPoints}</button></div>
            {lookupError&&<p className="rewards-error" role="alert">{lookupError}</p>}
            {member&&<div className="rewards-balance"><BadgeCheck size={22}/><div><strong>{member.points} {t.points}</strong><span>{t.balance}</span></div></div>}
            {member&&<div className="rewards-redeem"><h4>{t.redeemReward}</h4><div className="rewards-redemption-row">{[[0,t.noDiscount],[50,t.reward50],[100,t.reward100]].map(([value,label])=><button type="button" className={`reward-option ${redeemPoints===value?'active':''}`} key={value} disabled={value!==0&&!canRedeem(value)} onClick={()=>setRedeemPoints(value)}>{label}</button>)}</div></div>}
          </div>}
          <p className="rewards-fineprint">{t.rewardsExplain}</p>
        </section>
        <div className="phone-note"><Smartphone size={22}/><p>{t.phoneReceiptHint}</p></div>
      </div>
      <aside className="summary-card"><h2>{t.summary}</h2><div className="checkout-order-lines">{cart.map(i=><div key={i.key} className="summary-line"><span>{i.quantity} × {displayName(i.product,lang)}</span><strong>{formatPrice(i.unitPrice*i.quantity)}</strong></div>)}</div>
      <div className="summary-line"><span>{t.subtotal}</span><strong>{formatPrice(subtotal)}</strong></div>
      {discount>0&&<div className="summary-line rewards-discount"><span>{t.discount}</span><strong>−{formatPrice(discount)}</strong></div>}
      <div className="summary-total"><span>{t.total}</span><strong>{formatPrice(total)}</strong></div>
      {loyaltyMode!=='none'&&<p className="rewards-preview"><Gift size={17}/> {t.pendingPoints}: <strong>{Math.floor(total)}</strong> · {t.earnAfterPayment}</p>}
      {error&&<div className="error-box" role="alert">{t.orderError}<small>{error}</small></div>}
      <button className="primary-button full-button" disabled={!canPlace} onClick={()=>onPlace({customerName,fulfillment,paymentMethod,joinRewards:loyaltyMode==='join',loyaltyCode:loyaltyMode==='existing'?member?.code:null,redeemPoints})}>{placing?t.processing:t.placeOrder}<span className="button-arrow">{lang==='ar'?<ArrowLeft size={22}/>:<ArrowRight size={22}/>}</span></button>
      <p className="demo-hint">{t.cardDemoNotice}</p></aside></div>
    </main></div>;
}
