import React, { useEffect, useState } from 'react';
import { Clock3, RefreshCcw, Wallet, Check, Coffee } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import { api } from '../api.js';
import { formatPrice, optionsText } from '../config.js';
export default function Kitchen({t,lang,onLanguage}) {
  const [orders,setOrders]=useState([]);const [busy,setBusy]=useState('');const [error,setError]=useState('');
  async function reload(silent=false){try{const data=await api.orders();setOrders(data);setError('')}catch(e){if(!silent)setError(e.message)}}
  useEffect(()=>{reload();const timer=setInterval(()=>reload(true),4000);return()=>clearInterval(timer)},[]);
  async function update(id,patch){try{setBusy(id);await api.updateOrder(id,patch);await reload()}catch(e){setError(e.message)}finally{setBusy('')}}
  const groups=[{id:'new',title:t.pending},{id:'preparing',title:t.preparing},{id:'ready',title:t.ready},{id:'completed',title:t.completed}];
  const actions={new:{status:'preparing',text:t.make},preparing:{status:'ready',text:t.markReady},ready:{status:'completed',text:t.finish}};
  return <div className="inner-screen staff-page"><TopBar t={t} lang={lang} onLanguage={onLanguage} onHome={()=>window.location.href='/'} section="KITCHEN" staff/>
    <main className="page-width"><div className="staff-heading"><div><div className="eyebrow">✳ OPERATIONS</div><h1>{t.kitchen}</h1><p>{t.today}</p></div><button className="outline-button" onClick={()=>reload()}><RefreshCcw size={18}/>{t.refresh}</button></div>
    {error&&<div className="error-box">{error}</div>}
    <div className="kanban-board">{groups.map(g=><section className="kanban-col" key={g.id}><div className="kanban-head"><h2>{g.title}</h2><span>{orders.filter(o=>o.status===g.id).length}</span></div>
      {orders.filter(o=>o.status===g.id).map(o=><div className="kitchen-order" key={o.id}>
        <div className="kitchen-order-head"><strong>#{o.number}</strong><span><Clock3 size={14}/> {new Date(o.createdAt).toLocaleTimeString(lang==='ar'?'ar':'en-US',{hour:'2-digit',minute:'2-digit'})}</span></div>
        <p className="order-meta">{o.customerName||'Guest'} · {o.fulfillment==='takeaway'?t.takeaway:t.dineIn}</p>
        <div className="kitchen-items">{o.items.map((i,n)=><div key={n}><strong>{i.quantity}× {lang==='ar'?i.nameAr:i.name}</strong><small>{optionsText(i.options,lang)}</small></div>)}</div>
        <div className="kitchen-total"><strong>{formatPrice(o.total)}</strong><span className={o.paid?'paid-label':'unpaid-label'}>{o.paid?t.paid:t.paymentPending}</span></div>
        {!o.paid&&<button className="secondary-small-button" disabled={busy===o.id} onClick={()=>update(o.id,{paid:true})}><Wallet size={16}/>{t.markPaid}</button>}
        {actions[o.status]&&<button className="primary-button order-action" disabled={busy===o.id} onClick={()=>update(o.id,{status:actions[o.status].status})}>{actions[o.status].text}</button>}
      </div>)}
      {!orders.some(o=>o.status===g.id)&&<p className="kanban-empty">{t.noOrders}</p>}
    </section>)}</div>
    <p className="staff-disclaimer">Demo staff screen without authentication. Keep on a trusted local network only. Staff should mark payment as received only after collecting it.</p>
    </main>
  </div>;
}
