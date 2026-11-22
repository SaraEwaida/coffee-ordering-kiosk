import express from 'express';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { db, cents, dollars, productFromDb, orderFromDb, loyaltyFromDb, transaction, logEvent, dbFile } from './db.js';
import { validOptions, unitPrice } from '../shared/catalog.js';

const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'48kb'}));
app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
const sessions=new Map();
const attempts=new Map();
const now=()=>new Date().toISOString();
const error=(status,message)=>Object.assign(new Error(message),{status});
const orderQuery='SELECT * FROM orders WHERE id=?';
const productQuery='SELECT * FROM products WHERE id=?';
const loyaltyQuery='SELECT * FROM loyalty_accounts WHERE code=?';
const cleanCode = value => String(value||'').trim().replace(/[ -]/g,'').toUpperCase();
// The code is a private bearer credential: possession allows claiming discounts in this demo.
const validCode = code => /^[A-F0-9]{20}$/.test(code);
function loyaltyDetails(row){
  return loyaltyFromDb(row);
}
const lookupAttempts=new Map();
function throttleLoyalty(req,res,next){
  const key=req.ip||'unknown';const t=Date.now();
  const entries=(lookupAttempts.get(key)||[]).filter(x=>t-x<10*60*1000);
  if(entries.length>=150)return next(error(429,'Too many lookups; try again soon'));
  entries.push(t);lookupAttempts.set(key,entries);next();
}

function requireStaff(req,_res,next){
  const auth=req.get('authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  const entry=sessions.get(token);
  if(!entry || entry.expiresAt<Date.now()) return next(error(401,'Employee login required'));
  req.staff=entry.employee;next();
}
function requireAdmin(req,res,next){if(req.staff.role!=='admin')return next(error(403,'Manager access required'));next();}
function lanIp(){
  for(const list of Object.values(networkInterfaces()))for(const item of list||[]) {
    if(item.family==='IPv4' && !item.internal) return item.address;
  }
  return 'localhost';
}
app.get('/api/health',(_req,res)=>res.json({ok:true,database:'sqlite',file:dbFile.split(/[\\/]/).at(-1)}));
app.get('/api/config',(_req,res)=>res.json({
  receiptOrigin: process.env.PUBLIC_RECEIPT_ORIGIN || `http://${lanIp()}:${process.env.NODE_ENV==='production'?(process.env.PORT||3001):5173}`,
  cardTerminalOnly:true,
}));
app.get('/api/products',(_req,res)=>res.json(db.prepare('SELECT * FROM products ORDER BY rowid').all().map(productFromDb)));
// Public demo lookup returns points only. No phone numbers, names or purchase histories.
app.get('/api/loyalty/accounts/:code',throttleLoyalty,(req,res,next)=>{
  const code=cleanCode(req.params.code);
  if(!validCode(code))return next(error(404,'Rewards card not found'));
  const row=db.prepare(loyaltyQuery).get(code);
  if(!row)return next(error(404,'Rewards card not found'));
  res.json(loyaltyDetails(row));
});
app.get('/api/loyalty/overview',requireStaff,requireAdmin,(_req,res)=>{
  const sums=db.prepare('SELECT COUNT(*) AS customers,COALESCE(SUM(points_balance),0) AS outstandingPoints,COALESCE(SUM(total_earned),0) AS issuedPoints FROM loyalty_accounts').get();
  const recent=db.prepare(`SELECT t.id,t.kind,t.points_delta AS points,t.created_at AS createdAt,
    o.sequence AS orderNumber,a.code FROM loyalty_transactions t
    JOIN loyalty_accounts a ON a.id=t.account_id JOIN orders o ON o.id=t.order_id
    ORDER BY t.id DESC LIMIT 30`).all().map(x=>({...x,code:'••••'+x.code.slice(-4)}));
  res.json({...sums,recent});
});

app.post('/api/staff/login',(req,res,next)=>{
  try {
    const username=String(req.body?.username||'').trim().slice(0,40);
    const pin=String(req.body?.pin||'');
    const key=req.ip||'unknown';
    const history=(attempts.get(key)||[]).filter(t=>Date.now()-t<10*60*1000);
    if(history.length>=6) throw error(429,'Too many attempts. Try again later.');
    if(!/^\d{6,12}$/.test(pin)) throw error(401,'Incorrect username or PIN');
    const user=db.prepare('SELECT * FROM employees WHERE username=? AND active=1').get(username);
    const received=user?scryptSync(pin,user.pin_salt,32):Buffer.alloc(32);
    const expected=user?Buffer.from(user.pin_hash,'hex'):Buffer.alloc(32);
    if(!user||!timingSafeEqual(received,expected)){
      history.push(Date.now());attempts.set(key,history);
      throw error(401,'Incorrect username or PIN');
    }
    attempts.delete(key);
    const token=randomBytes(32).toString('base64url');
    const employee={id:user.id,username:user.username,displayName:user.display_name,role:user.role};
    sessions.set(token,{employee,expiresAt:Date.now()+8*60*60*1000});
    logEvent('employee',employee.id,'staff.login','employee',employee.id);
    res.json({accessToken:token,employee});
  }catch(e){next(e);}
});
app.post('/api/staff/logout',requireStaff,(req,res)=>{
  const token=req.get('authorization').slice(7);
  sessions.delete(token);res.json({ok:true});
});

app.post('/api/orders',(req,res,next)=>{
  try {
    const body=req.body||{};
    if(!Array.isArray(body.items)||body.items.length<1||body.items.length>30) throw error(400,'Order needs 1–30 different items');
    if(!['takeaway','dine_in'].includes(body.fulfillment)) throw error(400,'Invalid order type');
    if(!['counter','card_terminal'].includes(body.paymentMethod)) throw error(400,'Invalid payment method');
    const name=String(body.customerName||'').trim();
    if(name.length>40) throw error(400,'Pickup name is too long');
    const requestKey=typeof body.requestKey==='string'&&/^[\w-]{12,100}$/.test(body.requestKey)?body.requestKey:null;
    if(requestKey){
      const existing=db.prepare('SELECT * FROM orders WHERE request_key=?').get(requestKey);
      if(existing){
        const member=existing.loyalty_account_id?db.prepare('SELECT code FROM loyalty_accounts WHERE id=?').get(existing.loyalty_account_id):null;
        return res.json({...orderFromDb(existing),loyaltyCode:member?.code||null});
      }
    }
    const items=body.items.map(input=>{
      const row=db.prepare(productQuery).get(input.productId);
      if(!row||!row.available)throw error(400,`Product unavailable: ${input.productId}`);
      const quantity=Number(input.quantity);
      if(!Number.isInteger(quantity)||quantity<1||quantity>20)throw error(400,'Invalid quantity');
      const options=validOptions(input.options);
      const product=productFromDb(row);
      const unitCents=cents(unitPrice(product,options));
      return {product,options,quantity,unitCents,lineCents:unitCents*quantity};
    });
    if(items.reduce((n,i)=>n+i.quantity,0)>50)throw error(400,'Maximum 50 drinks per order');
    const joinRewards=body.joinRewards===true;
    const loyaltyCode=cleanCode(body.loyaltyCode);
    const redeemPoints=body.redeemPoints===undefined?0:Number(body.redeemPoints);
    if(![0,50,100].includes(redeemPoints))throw error(400,'Choose 0, 50, or 100 reward points');
    if(joinRewards&&loyaltyCode)throw error(400,'Choose join or existing card, not both');
    if(redeemPoints&&(!loyaltyCode||joinRewards))throw error(400,'A current rewards card is required to redeem points');
    if(loyaltyCode&&!validCode(loyaltyCode))throw error(400,'Invalid rewards card code');
    const id=randomUUID(),receiptToken=randomBytes(32).toString('base64url');
    const subtotalCents=items.reduce((n,i)=>n+i.lineCents,0);
    const discountCents=redeemPoints===50?500:redeemPoints===100?1000:0;
    if(discountCents>subtotalCents)throw error(400,'Add more items to use this reward');
    const order=transaction(()=>{
      let account=null;
      if(loyaltyCode){
        account=db.prepare(loyaltyQuery).get(loyaltyCode);
        if(!account)throw error(404,'Rewards card not found');
        if(account.points_balance<redeemPoints)throw error(400,'Not enough reward points');
      } else if(joinRewards){
        const code=randomBytes(10).toString('hex').toUpperCase();
        const accountId=randomUUID();
        db.prepare('INSERT INTO loyalty_accounts(id,code,created_at) VALUES(?,?,?)').run(accountId,code,now());
        account=db.prepare('SELECT * FROM loyalty_accounts WHERE id=?').get(accountId);
      }
      const totalCents=subtotalCents-discountCents;
      const sequence=db.prepare('SELECT COALESCE(MAX(sequence),1000)+1 AS next FROM orders').get().next;
      db.prepare(`INSERT INTO orders(id,sequence,created_at,customer_name,fulfillment,status,payment_method,payment_status,total_cents,receipt_token,request_key,loyalty_account_id,loyalty_redeemed_points,loyalty_discount_cents,subtotal_cents)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,sequence,now(),name,body.fulfillment,'new',body.paymentMethod,'pending',totalCents,receiptToken,requestKey,account?.id||null,redeemPoints,discountCents,subtotalCents);
      for(const i of items)db.prepare(`INSERT INTO order_items(id,order_id,product_id,name,name_ar,image,options_json,quantity,unit_price_cents,line_total_cents)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),id,i.product.id,i.product.name,i.product.nameAr,i.product.image,JSON.stringify(i.options),i.quantity,i.unitCents,i.lineCents);
      db.prepare('INSERT INTO payments(id,order_id,method,status,amount_cents,recorded_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(),id,body.paymentMethod,'pending',totalCents,now());
      if(account){
        if(joinRewards)logEvent('customer',null,'loyalty.joined','loyalty_account',account.id);
        if(redeemPoints){
          db.prepare('UPDATE loyalty_accounts SET points_balance=points_balance-? WHERE id=?').run(redeemPoints,account.id);
          db.prepare('INSERT INTO loyalty_transactions(account_id,order_id,points_delta,kind,created_at) VALUES(?,?,?,?,?)')
            .run(account.id,id,-redeemPoints,'redeemed',now());
          logEvent('customer',null,'loyalty.redeemed','order',id,{points:redeemPoints,discountCents});
        }
      }
      logEvent('customer',null,'order.created','order',id,{sequence,method:body.paymentMethod,itemCount:items.length,subtotalCents,discountCents,totalCents});
      return {...orderFromDb(db.prepare(orderQuery).get(id)),loyaltyCode:account?.code||null};
    });
    res.status(201).json(order);
  }catch(e){next(e);}
});

app.get('/api/receipts/:token',(req,res,next)=>{
  try{
    if(!/^[\w-]{40,64}$/.test(req.params.token))throw error(404,'Receipt not found');
    const row=db.prepare('SELECT * FROM orders WHERE receipt_token=?').get(req.params.token);
    if(!row)throw error(404,'Receipt not found');
    const order=orderFromDb(row);
    // No employee data or internal IDs; only what the customer needs to see.
    res.json({number:order.number,createdAt:order.createdAt,customerName:order.customerName,
      fulfillment:order.fulfillment,status:order.status,paymentMethod:order.paymentMethod,
      paymentStatus:order.paymentStatus,total:order.total,items:order.items,loyalty:order.loyalty});
  }catch(e){next(e);}
});

app.get('/api/orders',requireStaff,(_req,res)=>res.json(db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all().map(orderFromDb)));
app.get('/api/summary',requireStaff,(_req,res)=>{
  const row=db.prepare(`SELECT count(*) AS orders,
    sum(CASE WHEN status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END) AS open,
    sum(CASE WHEN payment_status='paid' THEN total_cents ELSE 0 END) AS paid_cents FROM orders`).get();
  res.json({orders:row.orders||0,open:row.open||0,paidRevenue:dollars(row.paid_cents||0)});
});
app.get('/api/events',requireStaff,requireAdmin,(_req,res)=>{
  res.json(db.prepare(`SELECT e.id,e.created_at AS createdAt,e.actor_type AS actorType,e.event_type AS eventType,
   e.entity_type AS entityType,e.entity_id AS entityId,e.details_json AS detailsJson,
   COALESCE(u.display_name,CASE WHEN e.actor_type='customer' THEN 'Customer' ELSE 'System' END) AS actorName
   FROM events e LEFT JOIN employees u ON u.id=e.actor_id ORDER BY e.id DESC LIMIT 100`).all()
   .map(e=>({...e,details:JSON.parse(e.detailsJson),detailsJson:undefined})));
});
app.patch('/api/orders/:id',requireStaff,(req,res,next)=>{
  try{
    const body=req.body||{};
    const original=db.prepare(orderQuery).get(req.params.id);
    if(!original)throw error(404,'Order not found');
    if(Object.hasOwn(body,'paid')&&typeof body.paid!=='boolean')throw error(400,'Invalid payment value');
    if(Object.hasOwn(body,'paid')&&body.paid===false)throw error(400,'Payment reversal must go through the payment provider');
    if(Object.hasOwn(body,'status')&&!['new','preparing','ready','completed','cancelled'].includes(body.status))throw error(400,'Invalid status');
    if(original.status==='cancelled')throw error(400,'Cancelled order cannot be changed');
    if(body.status==='cancelled'&&original.payment_status==='paid')throw error(400,'Paid orders require a separate refund process');
    if(body.status==='cancelled'&&body.paid===true)throw error(400,'Cannot cancel and mark paid together');
    if(!Object.hasOwn(body,'status')&&!Object.hasOwn(body,'paid'))throw error(400,'Nothing to update');
    const result=transaction(()=>{
      if(body.status==='cancelled'&&original.status!=='cancelled'&&original.loyalty_account_id&&original.loyalty_redeemed_points){
        db.prepare('UPDATE loyalty_accounts SET points_balance=points_balance+? WHERE id=?')
          .run(original.loyalty_redeemed_points,original.loyalty_account_id);
        db.prepare('INSERT INTO loyalty_transactions(account_id,order_id,points_delta,kind,created_at) VALUES(?,?,?,?,?)')
          .run(original.loyalty_account_id,original.id,original.loyalty_redeemed_points,'reversal',now());
        logEvent('employee',req.staff.id,'loyalty.reversed','order',original.id,{points:original.loyalty_redeemed_points});
      }
      if(body.status&&body.status!==original.status){
        db.prepare('UPDATE orders SET status=? WHERE id=?').run(body.status,original.id);
        logEvent('employee',req.staff.id,'order.status_changed','order',original.id,{from:original.status,to:body.status});
      }
      if(body.paid===true&&original.payment_status!=='paid'){
        // Only record real money received after staff has checked their cash drawer/card terminal.
        db.prepare("UPDATE orders SET payment_status='paid' WHERE id=?").run(original.id);
        db.prepare("UPDATE payments SET status='paid',recorded_at=?,recorded_by=? WHERE order_id=? AND status='pending'").run(now(),req.staff.id,original.id);
        if(original.loyalty_account_id){
          // Award one point per whole paid USD, once, in the same database transaction.
          const points=Math.floor(original.total_cents/100);
          if(points>0){
            db.prepare('UPDATE loyalty_accounts SET points_balance=points_balance+?,total_earned=total_earned+? WHERE id=?')
              .run(points,points,original.loyalty_account_id);
            db.prepare('UPDATE orders SET loyalty_earned_points=? WHERE id=?').run(points,original.id);
            db.prepare('INSERT INTO loyalty_transactions(account_id,order_id,points_delta,kind,created_at) VALUES(?,?,?,?,?)')
              .run(original.loyalty_account_id,original.id,points,'earned',now());
            logEvent('employee',req.staff.id,'loyalty.earned','order',original.id,{points});
          }
        }
        logEvent('employee',req.staff.id,'payment.recorded','order',original.id,{method:original.payment_method,totalCents:original.total_cents});
      }
      return orderFromDb(db.prepare(orderQuery).get(original.id));
    });
    res.json(result);
  }catch(e){next(e);}
});
app.patch('/api/products/:id',requireStaff,requireAdmin,(req,res,next)=>{
  try{
    const body=req.body||{};
    const old=db.prepare(productQuery).get(req.params.id);
    if(!old)throw error(404,'Product not found');
    if(!Object.hasOwn(body,'price')&&!Object.hasOwn(body,'available'))throw error(400,'Nothing to update');
    let price=old.price_cents,available=old.available;
    if(Object.hasOwn(body,'price')){
      if(body.price===''||body.price===null||!Number.isFinite(Number(body.price))||Number(body.price)<0||Number(body.price)>999)throw error(400,'Invalid price');
      price=cents(body.price);
    }
    if(Object.hasOwn(body,'available')){
      if(typeof body.available!=='boolean')throw error(400,'Availability must be boolean');
      available=body.available?1:0;
    }
    const result=transaction(()=>{
      db.prepare('UPDATE products SET price_cents=?,available=? WHERE id=?').run(price,available,old.id);
      if(price!==old.price_cents)logEvent('employee',req.staff.id,'product.price_changed','product',old.id,{from:dollars(old.price_cents),to:dollars(price)});
      if(available!==old.available)logEvent('employee',req.staff.id,'product.availability_changed','product',old.id,{from:Boolean(old.available),to:Boolean(available)});
      return productFromDb(db.prepare(productQuery).get(old.id));
    });
    res.json(result);
  }catch(e){next(e);}
});

const here=dirname(fileURLToPath(import.meta.url));
const distDir=resolve(here,'../dist');
if(existsSync(distDir)){
  app.use(express.static(distDir));
  app.get(/^\/(?!api(?:\/|$)).*/ ,(_req,res)=>res.sendFile(resolve(distDir,'index.html')));
}
app.use((err,_req,res,_next)=>{
  const status=err.status|| (err instanceof SyntaxError?400:500);
  if(status===500)console.error(err);
  res.status(status).json({error:status===500?'Server error; see logs':err.message});
});
const port=Number(process.env.PORT||3001);
app.listen(port,'0.0.0.0',()=>console.log(`Coffee Kiosk API + SQLite running at http://localhost:${port}`));
