import React from 'react';
import { Check, Coffee, ArrowRight, ArrowLeft } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import { formatPrice } from '../config.js';
export default function Confirmation({t,lang,order,onLanguage,onNew}) {
  const Arrow=lang==='ar'?ArrowLeft:ArrowRight;
  return <div className="inner-screen success-screen"><TopBar t={t} lang={lang} onLanguage={onLanguage} section="ORDER CONFIRMED"/>
    <main className="success-content"><div className="success-circle"><Check size={64} strokeWidth={3}/></div><div className="eyebrow">✳ BEAN & BLOOM</div><h1>{t.success}</h1><p>{t.successSub}</p>
      <div className="order-number-card"><span>{t.number}</span><strong>#{order.number}</strong><small>{formatPrice(order.total)} · {order.items.reduce((s,i)=>s+i.quantity,0)} {t.cups}</small></div>
      <button onClick={onNew} className="primary-button">{t.newOrder}<span className="button-arrow"><Arrow size={23}/></span></button>
    </main>
  </div>;
}
