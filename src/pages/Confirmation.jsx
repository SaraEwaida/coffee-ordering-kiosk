import React, { useEffect, useState } from 'react';
import { Check, ArrowRight, ArrowLeft, Smartphone, Copy, Share2, CreditCard, Wallet } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Gift } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import { api } from '../api.js';
import { formatPrice } from '../config.js';
export default function Confirmation({t,lang,order,onLanguage,onNew}) {
  const Arrow=lang==='ar'?ArrowLeft:ArrowRight;
  const [receiptOrigin,setReceiptOrigin]=useState(window.location.origin);
  const [copied,setCopied]=useState(false);
  useEffect(()=>{api.config().then(c=>setReceiptOrigin(c.receiptOrigin)).catch(()=>{});},[]);
  const url=`${receiptOrigin.replace(/\/$/,'')}/receipt/${encodeURIComponent(order.receiptToken)}`;
  async function copy(){try{await navigator.clipboard.writeText(url);setCopied(true);}catch{window.prompt('Copy your receipt URL:',url);}}
  async function share(){if(navigator.share){try{await navigator.share({title:`Coffee receipt #${order.number}`,url});}catch{}}else await copy();}
  return <div className="inner-screen success-screen"><TopBar t={t} lang={lang} onLanguage={onLanguage} section="ORDER CONFIRMED"/>
    <main className="success-content"><div className="success-circle"><Check size={64} strokeWidth={3}/></div><div className="eyebrow">✳ BEAN & BLOOM</div><h1>{t.success}</h1><p>{order.paymentMethod==='card_terminal'?t.successCardSub:t.successSub}</p>
      <div className="order-number-card"><span>{t.number}</span><strong>#{order.number}</strong><small>{formatPrice(order.total)} · {order.items.reduce((s,i)=>s+i.quantity,0)} {t.cups}</small></div>
      <section className="digital-receipt-card"><div><Smartphone size={22}/><h2>{t.digitalReceipt}</h2></div><p>{t.scanReceipt}</p>
        <div className="qr-frame"><QRCodeSVG value={url} size={152} level="M" marginSize={2}/></div>
        <div className="receipt-actions"><button className="outline-button" onClick={copy}><Copy size={17}/>{copied?t.copied:t.copyLink}</button><button className="outline-button" onClick={share}><Share2 size={17}/>{t.shareLink}</button></div>
        <small>{t.sameWifiNote}</small>
      </section>
      {order.loyaltyCode&&<section className="digital-receipt-card rewards-confirmation"><div><Gift size={22}/><h2>{t.joinedCard}</h2></div><p>{t.saveCard}</p>
        <div className="qr-frame"><QRCodeSVG value={`${receiptOrigin.replace(/\/$/,'')}/rewards/${order.loyaltyCode}`} size={152} marginSize={2}/></div>
        <p className="rewards-code-line" dir="ltr">{order.loyaltyCode.match(/.{1,5}/g)?.join(' ')}</p>
        <p>{t.pendingPoints}: <strong>{order.loyalty?.earnedPoints||Math.floor(order.total)}</strong></p>
        <small>{t.earnAfterPayment} {t.rewardsExplain}</small></section>}
      <button onClick={onNew} className="primary-button">{t.newOrder}<span className="button-arrow"><Arrow size={23}/></span></button>
    </main>
  </div>;
}
