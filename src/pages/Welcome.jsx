import React from 'react';
import { ArrowRight, ArrowLeft, Coffee, Sparkles } from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
export default function Welcome({t,lang,onLanguage,onStart}) {
  const Arrow=lang==='ar'?ArrowLeft:ArrowRight;
  return <div className="welcome-screen">
    <TopBar t={t} lang={lang} onLanguage={onLanguage}/>
    <main className="welcome-main">
      <div className="welcome-copy">
        <div className="eyebrow"><Sparkles size={18}/>{t.welcomeEyebrow}</div>
        <h1>{t.welcomeTitle}</h1>
        <p>{t.welcomeSubtitle}</p>
        <button className="primary-button hero-button" onClick={onStart}>{t.orderNow}<span className="button-arrow"><Arrow size={26}/></span></button>
        <div className="mini-note"><span className="note-dot"/>{t.scan}</div>
      </div>
      <div className="hero-visual" aria-label="Latte coffee photograph">
        <div className="hero-ring ring-one"/><div className="hero-ring ring-two"/>
        <div className="hero-photo-wrap"><img src="/images/latte.webp" alt="Fresh latte with latte art"/></div>
        <div className="hero-sticker top-sticker"><Coffee size={23}/><span>100%<small>GOOD COFFEE</small></span></div>
        <div className="hero-sticker bottom-sticker"><span className="stars">★★★★★</span><small>BREWED WITH LOVE</small></div>
      </div>
    </main>
    <div className="welcome-footer">FRESHLY GROUND <span>✳</span> DAILY BREWED <span>✳</span> MADE FOR YOU</div>
  </div>;
}
