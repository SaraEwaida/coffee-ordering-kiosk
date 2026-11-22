import React, { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Coffee, Wallet, CreditCard } from 'lucide-react';
import { api } from '../api.js';
import { formatPrice, optionsText } from '../config.js';
import { dictionary } from '../../shared/i18n.js';
export default function Receipt({token}) {
  const [lang,setLang]=useState('en');
  const [receipt,setReceipt]=useState(null);
  const [error,setError]=useState('');
  const t=dictionary[lang];
  useEffect(()=>{
    let mounted=true;
    const load=()=>api.receipt(token).then(x=>{if(mounted){setReceipt(x);setError('');}}).catch(e=>{if(mounted)setError(e.message)});
    load();const timer=setInterval(load,10000);
    return()=>{mounted=false;clearInterval(timer)};
  },[token]);
  useEffect(()=>{document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';},[lang]);
  return <main className="receipt-screen"><div className="receipt-sheet">
    <div className="receipt-brand"><Coffee size={29}/><strong>BEAN & BLOOM</strong><button className="outline-button" onClick={()=>setLang(x=>x==='en'?'ar':'en')}>{lang==='en'?'العربية':'English'}</button></div>
    {error?<div className="error-box" role="alert">{error}</div>:!receipt?<p>{t.loading}</p>:<>
      <div className="receipt-status"><CheckCircle2 size={40}/><h1>{t.digitalReceipt}</h1><p>#{receipt.number} · {new Date(receipt.createdAt).toLocaleString(lang==='en'?'en-US':'ar')}</p></div>
      <div className="receipt-info-row"><span>{t.orderType}</span><strong>{receipt.fulfillment==='takeaway'?t.takeaway:t.dineIn}</strong></div>
      <div className="receipt-info-row"><span>{t.payment}</span><strong>{receipt.paymentMethod==='card_terminal'?t.cardTerminal:t.cash}</strong></div>
      <div className="receipt-info-row"><span>{t.paymentStatusLabel}</span><strong>{receipt.paymentStatus==='paid'?t.paid:t.paymentPending}</strong></div>
      <div className="receipt-info-row"><span>{t.orderStatusLabel}</span><strong>{t[receipt.status==='new'?'pending':receipt.status]}</strong></div>
      <h3>{t.summary}</h3>
      {receipt.items.map((item,i)=><div className="receipt-line" key={i}><div><strong>{item.quantity} × {lang==='ar'?item.nameAr:item.name}</strong><small>{optionsText(item.options,lang)}</small></div><strong>{formatPrice(item.lineTotal)}</strong></div>)}
      {receipt.loyalty?.joined&&<div className="receipt-info-row"><span>{t.rewards}</span><strong>{receipt.loyalty.earnedPoints} {t.points} {receipt.paymentStatus==='pending'?'(pending)':''}</strong></div>}
      {receipt.loyalty?.redeemedPoints>0&&<div className="receipt-info-row"><span>{t.discount}</span><strong>−{formatPrice(receipt.loyalty.discount)}</strong></div>}
      <div className="receipt-total"><span>{t.total}</span><strong>{formatPrice(receipt.total)}</strong></div>
      <p className="receipt-footnote">{t.receiptSaved}</p>
    </>}
  </div></main>;
}
