import React, { useEffect, useRef, useState } from 'react';
import Welcome from './pages/Welcome.jsx';
import Menu from './pages/Menu.jsx';
import CustomizeDrink from './pages/CustomizeDrink.jsx';
import Cart from './pages/Cart.jsx';
import Checkout from './pages/Checkout.jsx';
import Confirmation from './pages/Confirmation.jsx';
import Kitchen from './pages/Kitchen.jsx';
import Admin from './pages/Admin.jsx';
import Receipt from './pages/Receipt.jsx';
import RewardsCard from './pages/RewardsCard.jsx';
import RewardsLookup from './pages/RewardsLookup.jsx';
import StaffGate from './pages/StaffGate.jsx';
import { api } from './api.js';
import { dictionary } from '../shared/i18n.js';
import { unitPrice } from '../shared/catalog.js';

function safeStoredCart() {
  try { const v=JSON.parse(localStorage.getItem('coffee-cart-v1') || '[]');return Array.isArray(v)?v:[]; }
  catch { return []; }
}
export default function App() {
  const [lang,setLang]=useState(()=>localStorage.getItem('coffee-lang')==='ar'?'ar':'en');
  const [page,setPage]=useState('welcome');
  const [products,setProducts]=useState([]);const [loadError,setLoadError]=useState('');
  const [selected,setSelected]=useState(null);const [cart,setCart]=useState(safeStoredCart);
  const orderRequestRef=useRef(null);
  const [order,setOrder]=useState(null);const [placing,setPlacing]=useState(false);const [orderError,setOrderError]=useState('');
  const [staffView]=useState(()=>new URLSearchParams(window.location.search).get('view'));
  const t=dictionary[lang];
  useEffect(()=>{document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';localStorage.setItem('coffee-lang',lang)},[lang]);
  useEffect(()=>{localStorage.setItem('coffee-cart-v1',JSON.stringify(cart))},[cart]);
  async function loadProducts() {try{const list=await api.products();setProducts(list);setLoadError('')}catch(e){setLoadError(e.message)}}
  useEffect(()=>{loadProducts()},[]);
  const cartCount=cart.reduce((s,i)=>s+i.quantity,0);
  const switchLang=()=>setLang(v=>v==='en'?'ar':'en');
  function go(p){setPage(p);window.scrollTo(0,0)}
  function choose(product){setSelected(product);go('customize')}
  function add(product,options,quantity){
    orderRequestRef.current=null;
    const key=`${product.id}:${JSON.stringify(options)}`;
    const price=unitPrice(product,options);
    setCart(old=>{
      const existing=old.find(i=>i.key===key);
      if(existing)return old.map(i=>i.key===key?{...i,quantity:Math.min(i.quantity+quantity,20)}:i);
      return [...old,{key,product,options,quantity,unitPrice:price}];
    });
    go('cart');
  }
  function updateQty(key,n){orderRequestRef.current=null;setCart(old=>old.map(i=>i.key===key?{...i,quantity:n}:i))}
  function remove(key){orderRequestRef.current=null;setCart(old=>old.filter(i=>i.key!==key))}
  async function place({customerName,fulfillment,paymentMethod,loyaltyCode,joinRewards,redeemPoints}){
    if (!cart.length || placing) return;
    setPlacing(true);setOrderError('');
    if(!orderRequestRef.current)orderRequestRef.current=crypto.randomUUID();
    try {
      const result=await api.placeOrder({customerName,fulfillment,paymentMethod,loyaltyCode,joinRewards,redeemPoints,requestKey:orderRequestRef.current,items:cart.map(i=>({productId:i.product.id,options:i.options,quantity:i.quantity}))});
      setOrder(result);orderRequestRef.current=null;setCart([]);go('success');
    } catch(e){setOrderError(e.message)}finally{setPlacing(false)}
  }
  const common={t,lang,onLanguage:switchLang};
  const receiptToken=window.location.pathname.match(/^\/receipt\/([\w-]+)\/?$/)?.[1];
  if (receiptToken) return <Receipt token={receiptToken}/>;
  const cardCode=window.location.pathname.match(/^\/rewards\/([A-Fa-f0-9]{20})\/?$/)?.[1];
  if(cardCode)return <RewardsCard code={cardCode}/>;
  if (staffView==='kitchen') return <StaffGate section="Kitchen display">{(token,onAuthError)=><Kitchen {...common} token={token} onAuthError={onAuthError}/>}</StaffGate>;
  if (staffView==='admin') return <StaffGate section="Admin dashboard">{(token,onAuthError)=><Admin {...common} token={token} onAuthError={onAuthError} products={products} onReloadProducts={loadProducts}/>}</StaffGate>;
  if (page==='welcome')return <Welcome {...common} onStart={()=>go('menu')} onRewards={()=>go('rewards')}/>;
  if (page==='rewards')return <RewardsLookup {...common} onBack={()=>go('welcome')}/>;
  if (page==='menu')return <Menu {...common} products={products} error={loadError} onRetry={loadProducts} onBack={()=>go('welcome')} onCart={()=>go('cart')} cartCount={cartCount} onChoose={choose}/>;
  if (page==='customize'&&selected)return <CustomizeDrink {...common} product={selected} onBack={()=>go('menu')} onCart={()=>go('cart')} cartCount={cartCount} onAdd={add}/>;
  if (page==='cart')return <Cart {...common} cart={cart} onBack={()=>go('menu')} onCart={()=>{}} cartCount={cartCount} onCheckout={()=>{setOrderError('');go('checkout')}} onChangeQty={updateQty} onRemove={remove}/>;
  if (page==='checkout')return <Checkout {...common} cart={cart} onBack={()=>go('cart')} onCart={()=>go('cart')} cartCount={cartCount} onPlace={place} placing={placing} error={orderError}/>;
  if (page==='success'&&order)return <Confirmation {...common} order={order} onNew={()=>{setOrder(null);loadProducts();go('welcome')}}/>;
  return <Welcome {...common} onStart={()=>go('menu')} onRewards={()=>go('rewards')}/>;
}
