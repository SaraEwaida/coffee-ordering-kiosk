import React, { useEffect, useMemo, useState } from 'react';
import Welcome from './pages/Welcome.jsx';
import Menu from './pages/Menu.jsx';
import CustomizeDrink from './pages/CustomizeDrink.jsx';
import Cart from './pages/Cart.jsx';
import Checkout from './pages/Checkout.jsx';
import Confirmation from './pages/Confirmation.jsx';
import Kitchen from './pages/Kitchen.jsx';
import Admin from './pages/Admin.jsx';
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
    const key=`${product.id}:${JSON.stringify(options)}`;
    const price=unitPrice(product,options);
    setCart(old=>{
      const existing=old.find(i=>i.key===key);
      if(existing)return old.map(i=>i.key===key?{...i,quantity:Math.min(i.quantity+quantity,20)}:i);
      return [...old,{key,product,options,quantity,unitPrice:price}];
    });
    go('cart');
  }
  function updateQty(key,n){setCart(old=>old.map(i=>i.key===key?{...i,quantity:n}:i))}
  function remove(key){setCart(old=>old.filter(i=>i.key!==key))}
  async function place({customerName,fulfillment}){
    if (!cart.length || placing) return;
    setPlacing(true);setOrderError('');
    try {
      const result=await api.placeOrder({customerName,fulfillment,items:cart.map(i=>({productId:i.product.id,options:i.options,quantity:i.quantity}))});
      setOrder(result);setCart([]);go('success');
    } catch(e){setOrderError(e.message)}finally{setPlacing(false)}
  }
  const common={t,lang,onLanguage:switchLang};
  if (staffView==='kitchen') return <Kitchen {...common}/>;
  if (staffView==='admin') return <Admin {...common} products={products} onReloadProducts={loadProducts}/>;
  if (page==='welcome')return <Welcome {...common} onStart={()=>go('menu')}/>;
  if (page==='menu')return <Menu {...common} products={products} error={loadError} onRetry={loadProducts} onBack={()=>go('welcome')} onCart={()=>go('cart')} cartCount={cartCount} onChoose={choose}/>;
  if (page==='customize'&&selected)return <CustomizeDrink {...common} product={selected} onBack={()=>go('menu')} onCart={()=>go('cart')} cartCount={cartCount} onAdd={add}/>;
  if (page==='cart')return <Cart {...common} cart={cart} onBack={()=>go('menu')} onCart={()=>{}} cartCount={cartCount} onCheckout={()=>{setOrderError('');go('checkout')}} onChangeQty={updateQty} onRemove={remove}/>;
  if (page==='checkout')return <Checkout {...common} cart={cart} onBack={()=>go('cart')} onCart={()=>go('cart')} cartCount={cartCount} onPlace={place} placing={placing} error={orderError}/>;
  if (page==='success'&&order)return <Confirmation {...common} order={order} onNew={()=>{setOrder(null);loadProducts();go('welcome')}}/>;
  return <Welcome {...common} onStart={()=>go('menu')}/>;
}
