import React,{useEffect,useState} from 'react';
import {Coffee,Gift,Copy,Check,RefreshCw} from 'lucide-react';
import {QRCodeSVG} from 'qrcode.react';
import {api} from '../api.js';
import {dictionary} from '../../shared/i18n.js';
export default function RewardsCard({code}){
  const [lang,setLang]=useState('en');const [account,setAccount]=useState(null);const [error,setError]=useState('');const [copied,setCopied]=useState(false);
  const t=dictionary[lang];
  async function refresh(){try{setAccount(await api.loyalty(code));setError('')}catch(e){setError(e.message)}}
  useEffect(()=>{refresh();const timer=setInterval(refresh,30000);return()=>clearInterval(timer)},[code]);
  useEffect(()=>{document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr'},[lang]);
  async function copy(){try{await navigator.clipboard.writeText(code);setCopied(true)}catch{window.prompt(t.cardCode,code)}}
  return <main className="rewards-wallet-page"><div className="rewards-wallet-wrap">
    <header className="rewards-wallet-header"><Coffee size={27}/><strong>BEAN & BLOOM</strong><button className="outline-button" onClick={()=>setLang(x=>x==='en'?'ar':'en')}>{lang==='en'?'العربية':'English'}</button></header>
    <div className="rewards-wallet-card"><div className="eyebrow">✳ BEAN & BLOOM</div><Gift size={43}/><h1>BLOOM REWARDS</h1><p>{t.rewardsBalance}</p><strong className="wallet-points">{account?account.points:'—'} <span>{t.points}</span></strong>
      <div className="wallet-code"><small>{t.cardCode}</small><strong dir="ltr">{code.match(/.{1,5}/g)?.join(' ')}</strong></div>
    </div>
    <div className="rewards-wallet-qr"><h2>{t.joinedCard}</h2><p>{t.saveCard}</p><div className="qr-frame"><QRCodeSVG value={window.location.href} size={190} level="M" marginSize={2}/></div>
      <div className="receipt-actions"><button className="outline-button" onClick={copy}>{copied?<Check size={16}/>:<Copy size={16}/>} {copied?t.copied:t.copyLink}</button><button className="outline-button" onClick={refresh}><RefreshCw size={16}/>{t.refresh}</button></div>
      <small>{t.earnAfterPayment}</small>{error&&<p className="rewards-error" role="alert">{error}</p>}</div>
    <p className="wallet-privacy">{t.rewardsExplain} {t.sameWifiNote}</p>
  </div></main>;
}
