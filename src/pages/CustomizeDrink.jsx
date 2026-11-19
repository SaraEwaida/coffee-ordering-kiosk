import React, { useState, useEffect } from 'react';
import { Check, Plus } from 'lucide-react';
import { sizes, milks, syrups, unitPrice } from '../../shared/catalog.js';
import { displayName, formatPrice } from '../config.js';
import TopBar from '../components/TopBar.jsx';
import Stepper from '../components/Stepper.jsx';
function ChoiceRow({title,choices,selected,onChoose,lang,priceExtra=true}) {
  return <section className="custom-section"><h3>{title}</h3><div className="choice-row">{choices.map(c=><button key={c.id} type="button" onClick={()=>onChoose(c.id)} className={`choice-button ${selected===c.id?'selected':''}`}>
    <span>{lang==='ar'?c.ar:c.name}{c.extra>0&&priceExtra&&<small>+{formatPrice(c.extra)}</small>}</span>{selected===c.id&&<Check size={19}/>}</button>)}</div></section>;
}
export default function CustomizeDrink({t,lang,product,onLanguage,onBack,onCart,cartCount,onAdd}) {
  const [size,setSize]=useState('medium'); const [milk,setMilk]=useState('regular'); const [syrup,setSyrup]=useState('none');
  const [sugar,setSugar]=useState(0);const [extraShot,setExtraShot]=useState(false);const [quantity,setQuantity]=useState(1);
  useEffect(()=>{setSize('medium');setMilk('regular');setSyrup('none');setSugar(0);setExtraShot(false);setQuantity(1)},[product.id]);
  const options={size,milk,syrup,sugar,extraShot};
  const total=unitPrice(product,options)*quantity;
  return <div className="inner-screen"><TopBar {...{t,lang,onLanguage,onBack,onCart,cartCount}} section="CUSTOMIZE"/>
    <main className="page-width customize-page">
      <div className="custom-left"><div className="large-product-photo"><img src={product.image} alt={displayName(product,lang)}/><span className="product-photo-caption">{product.category==='iced'?'ICE COLD':'FRESH & HOT'}</span></div>
        <div className="custom-product-intro"><div className="eyebrow">✳ {t.yourDrink}</div><h1>{displayName(product,lang)}</h1><p>{lang==='ar'?product.descriptionAr:product.description}</p></div>
      </div>
      <div className="custom-right"><h2>{t.customize}</h2>
        <ChoiceRow title={t.size} choices={sizes} selected={size} onChoose={setSize} lang={lang}/>
        <ChoiceRow title={t.milk} choices={milks} selected={milk} onChoose={setMilk} lang={lang}/>
        <ChoiceRow title={t.syrup} choices={syrups} selected={syrup} onChoose={setSyrup} lang={lang}/>
        <div className="custom-option-line"><div><h3>{t.sugar}</h3><p>0 – 3</p></div><Stepper value={sugar} onChange={setSugar} max={3}/></div>
        <button className={`extra-shot-toggle ${extraShot?'checked':''}`} onClick={()=>setExtraShot(!extraShot)}><div className="check-square">{extraShot&&<Check size={18}/>}</div><span>{t.extraShot}</span><strong>+{formatPrice(1)}</strong></button>
        <div className="order-quantity-row"><span>{t.quantity}</span><Stepper value={quantity} onChange={setQuantity} min={1}/></div>
        <button className="primary-button add-button" onClick={()=>onAdd(product,options,quantity)}><span><Plus size={21}/>{t.addToCart}</span><strong>{formatPrice(total)}</strong></button>
      </div>
    </main>
  </div>;
}
