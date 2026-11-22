import React,{useState} from 'react';
import {Gift,ArrowRight,Search} from 'lucide-react';
import TopBar from '../components/TopBar.jsx';
import {api} from '../api.js';
export default function RewardsLookup({t,lang,onLanguage,onBack}){
  const [code,setCode]=useState('');const [member,setMember]=useState(null);const [error,setError]=useState('');const [loading,setLoading]=useState(false);
  async function lookup(e){e.preventDefault();setLoading(true);setError('');setMember(null);
    try{const x=await api.loyalty(code.replace(/[ -]/g,'').toUpperCase());setMember(x);setCode(x.code)}catch(err){setError(err.message)}finally{setLoading(false)}
  }
  return <div className="inner-screen"><TopBar t={t} lang={lang} onLanguage={onLanguage} onBack={onBack} section="BLOOM REWARDS"/>
    <main className="rewards-lookup-page"><div className="rewards-lookup-icon"><Gift size={44}/></div><div className="eyebrow">✳ BEAN & BLOOM</div>
      <h1>{t.rewardsLookup}</h1><p>{t.rewardsSub}</p>
      <form onSubmit={lookup} className="rewards-lookup-form"><label htmlFor="lookupCard">{t.cardCode}</label><input id="lookupCard" value={code} maxLength={32} onChange={e=>{setCode(e.target.value);setMember(null)}} required autoComplete="off" autoCapitalize="characters" placeholder="Your private rewards code"/>
        <button disabled={loading} className="primary-button"><Search size={20}/>{t.findCard}</button></form>
      {error&&<p role="alert" className="rewards-error">{error}</p>}
      {member&&<div className="rewards-lookup-result"><strong>{member.points} {t.points}</strong><p>{t.balance}</p><a className="primary-button" href={`/rewards/${member.code}`} target="_blank" rel="noopener noreferrer">{t.joinedCard} <ArrowRight size={18}/></a></div>}
      <small>{t.rewardsExplain}</small>
    </main>
  </div>;
}
