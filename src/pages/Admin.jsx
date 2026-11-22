import React, { useEffect, useState } from 'react';
import { BarChart3, Coffee, ClipboardList, RefreshCcw, Check } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import { api } from '../api.js';
import { Gift } from 'lucide-react';
import { displayName, formatPrice } from '../config.js';
export default function Admin({t,lang,products,onLanguage,onReloadProducts,token,onAuthError}) {
  const [loyalty,setLoyalty]=useState({customers:0,outstandingPoints:0,issuedPoints:0,recent:[]});const [summary,setSummary]=useState({orders:0,open:0,paidRevenue:0});const [events,setEvents]=useState([]);const [drafts,setDrafts]=useState({});const [busy,setBusy]=useState('');const [error,setError]=useState('');
  async function refresh(){try{setSummary(await api.summary(token));setEvents(await api.events(token));setLoyalty(await api.loyaltyOverview(token));await onReloadProducts();setError('')}catch(e){if(/login required/i.test(e.message))onAuthError();else setError(e.message)}}
  useEffect(()=>{refresh()},[]);
  async function edit(product,data){try{setBusy(product.id);await api.updateProduct(product.id,data,token);await refresh()}catch(e){if(/login required/i.test(e.message))onAuthError();else setError(e.message)}finally{setBusy('')}}
  const metrics=[{label:t.totalOrders,value:summary.orders,icon:ClipboardList},{label:t.activeOrders,value:summary.open,icon:Coffee},{label:t.revenue,value:formatPrice(summary.paidRevenue),icon:BarChart3}];
  return <div className="inner-screen staff-page"><TopBar t={t} lang={lang} onLanguage={onLanguage} onHome={()=>window.location.href='/'} section="ADMIN" staff/>
    <main className="page-width"><div className="staff-heading"><div><div className="eyebrow">✳ MANAGEMENT</div><h1>{t.admin}</h1><p>{t.settings}</p></div><button className="outline-button" onClick={refresh}><RefreshCcw size={18}/>{t.refresh}</button></div>
    {error&&<div className="error-box">{error}</div>}
    <div className="metric-grid">{metrics.map(m=>{const Icon=m.icon;return <div className="metric-card" key={m.label}><span><Icon size={24}/></span><strong>{m.value}</strong><p>{m.label}</p></div>})}</div>
    <div className="section-title"><h2>{t.products}</h2><span>{products.length}</span></div>
    <div className="admin-products">{products.map(p=><div className="admin-product" key={p.id}><img src={p.image} alt=""/><div className="admin-prod-name"><strong>{displayName(p,lang)}</strong><small>{p.id}</small></div>
      <div className="price-edit"><label htmlFor={`price-${p.id}`}>{t.total} (USD)</label><input id={`price-${p.id}`} type="number" min="0" max="999" step="0.05" inputMode="decimal" value={drafts[p.id]??String(p.price)} onChange={e=>setDrafts(old=>({...old,[p.id]:e.target.value}))}/></div>
      <button className="outline-button admin-save" disabled={busy===p.id || drafts[p.id]===undefined || drafts[p.id]==='' || Number(drafts[p.id])<0} onClick={()=>{edit(p,{price:Number(drafts[p.id])});setDrafts(d=>({...d,[p.id]:undefined}))}}><Check size={18}/>{t.save}</button>
      <button className={`availability-button ${p.available?'available':''}`} disabled={busy===p.id} onClick={()=>edit(p,{available:!p.available})}>{p.available?t.available:t.soldOut}</button></div>)}</div>
    <section className="staff-activity"><div className="section-title"><Gift size={24}/><h2>{t.loyaltyOverview}</h2></div>
      <div className="loyalty-admin-metrics"><div><strong>{loyalty.customers}</strong><span>{t.members}</span></div><div><strong>{loyalty.outstandingPoints}</strong><span>{t.outstanding}</span></div><div><strong>{loyalty.issuedPoints}</strong><span>{t.issuedPoints}</span></div></div>
      <h3>{t.recentPoints}</h3>{loyalty.recent?.length?loyalty.recent.map(x=><div className="activity-row" key={x.id}><span><strong>{x.kind}</strong> · {x.points>0?'+':''}{x.points} {t.points} · #{x.orderNumber} · {x.code}</span><small>{new Date(x.createdAt).toLocaleString()}</small></div>):<p>{t.noOrders}</p>}
    </section>
    <section className="staff-activity"><h2>{t.staffActivity}</h2><p>{t.staffActivitySub}</p>{events.length?events.map(e=><div className="activity-row" key={e.id}><span><strong>{e.actorName}</strong> · {e.eventType.replaceAll('.', ' ')} · {e.entityType} {e.entityId.slice(0,8)}</span><small>{new Date(e.createdAt).toLocaleString()}</small></div>):<p>{t.noOrders}</p>}</section>
    <p className="staff-disclaimer">Orders, products, payments and staff actions are saved to server/data/coffee-kiosk.sqlite. This is a local demonstration. Before internet deployment, add HTTPS, proper user management, tested backups, and a payment-provider integration.</p>
    </main>
  </div>;
}
