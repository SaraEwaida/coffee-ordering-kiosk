import React, { useState } from 'react';
import { Coffee, Snowflake, LayoutGrid, ArrowRight, ArrowLeft } from 'lucide-react';
import ProductCard from '../components/ProductCard.jsx';
import TopBar from '../components/TopBar.jsx';
export default function Menu({t,lang,products,onLanguage,onBack,onCart,cartCount,onChoose,error,onRetry}) {
  const [category,setCategory]=useState('all');
  const categories=[{id:'all',name:t.all,icon:LayoutGrid},{id:'hot',name:t.hot,icon:Coffee},{id:'iced',name:t.iced,icon:Snowflake}];
  const listed=products.filter(p=>category==='all'||p.category===category);
  return <div className="inner-screen"><TopBar {...{t,lang,onLanguage,onBack,onCart,cartCount}} section="COFFEE MENU"/>
    <main className="page-width menu-page">
      <div className="page-heading"><div><div className="eyebrow">✳ {t.menu}</div><h1>{t.menuTitle}</h1><p>{t.menuSub}</p></div><div className="heading-art">☕</div></div>
      <div className="category-tabs" role="tablist" aria-label="Coffee categories">{categories.map(c=>{const Icon=c.icon;return <button key={c.id} className={category===c.id?'active':''} onClick={()=>setCategory(c.id)} role="tab" aria-selected={category===c.id}><Icon size={20}/>{c.name}</button>})}</div>
      {error ? <div className="error-card"><p>{t.loadError}</p><small>{error}</small><button className="outline-button" onClick={onRetry}>{t.retry}</button></div>:
        !products.length ? <p className="empty-loading">{t.loading}</p>:
        <div className="products-grid">{listed.map(p=><ProductCard key={p.id} product={p} lang={lang} t={t} onClick={onChoose}/>)}</div>}
    </main>
  </div>;
}
