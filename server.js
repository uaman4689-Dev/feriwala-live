require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for persistent PostgreSQL storage.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  max: 5
});
const q = async (sql, params=[]) => pool.query(sql.replace(/\?/g, (_, offset) => '$' + (sql.slice(0, offset).match(/\?/g)||[]).length), params);
const text = (v, max=250) => String(v ?? '').trim().slice(0,max);
const integer = (v, min=0, max=100000000) => { const n=Number(v); if(!Number.isSafeInteger(n)||n<min||n>max) throw new Error('দাম/স্টকের মান সঠিক নয়।'); return n; };
function validImage(value){const image=String(value||'');if(!image)return '';if(image.length>5000000||!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image))throw new Error('সঠিক ছবি দিন (PNG/JPG/WebP, সর্বোচ্চ প্রায় 3.5MB)।');return image;}
async function initDb(){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS categories (id BIGSERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS products (
 id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
 price INTEGER NOT NULL CHECK(price >= 0), old_price INTEGER NOT NULL DEFAULT 0 CHECK(old_price >= 0),
 emoji TEXT NOT NULL DEFAULT '🎁', label TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
 stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), active INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), image TEXT NOT NULL DEFAULT ''
 );
 CREATE TABLE IF NOT EXISTS orders (
 id BIGSERIAL PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
 address TEXT NOT NULL, payment TEXT NOT NULL DEFAULT 'Cash on Delivery', items_json TEXT NOT NULL,
 total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'New', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 delivery_zone TEXT NOT NULL DEFAULT 'inside', delivery_fee INTEGER NOT NULL DEFAULT 70
 );
 CREATE TABLE IF NOT EXISTS admins (id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS resellers (id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, referral_code TEXT UNIQUE NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, normal_type TEXT NOT NULL DEFAULT 'percent' CHECK(normal_type IN ('percent','fixed')), normal_value NUMERIC(10,2) NOT NULL DEFAULT 10 CHECK(normal_value >= 0), offer_type TEXT NOT NULL DEFAULT 'fixed' CHECK(offer_type IN ('percent','fixed')), offer_value NUMERIC(10,2) NOT NULL DEFAULT 20 CHECK(offer_value >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS reseller_commissions (id BIGSERIAL PRIMARY KEY, reseller_id BIGINT NOT NULL REFERENCES resellers(id), order_id BIGINT NOT NULL REFERENCES orders(id), amount NUMERIC(12,2) NOT NULL CHECK(amount >= 0), status TEXT NOT NULL DEFAULT 'payable' CHECK(status IN ('payable','paid','reversed')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ, UNIQUE(reseller_id, order_id));
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS reseller_id BIGINT REFERENCES resellers(id);
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_code TEXT;
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_processed BOOLEAN NOT NULL DEFAULT FALSE;
 CREATE TABLE IF NOT EXISTS offers (id BIGSERIAL PRIMARY KEY, text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), product_id BIGINT, image TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0, old_price INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '');
 `);
 await pool.query("INSERT INTO categories(name) SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND BTRIM(category)<>'' ON CONFLICT(name) DO NOTHING").catch(()=>{});
 const count=Number((await pool.query('SELECT COUNT(*) AS n FROM products')).rows[0].n);
 if(!count){
  const seed=[
   ['Classic Couple Watch Set','ঘড়ি',890,1090,'⌚','POPULAR','কাপল গিফট সেট',12],
   ['Soft Musk Attar','আতর',199,250,'🌿','BESTSELLER','সফট ও এলিগ্যান্ট সুগন্ধ',20],
   ['Everyday Money Wallet','মানিব্যাগ',299,350,'👛','','দৈনন্দিন ব্যবহারের জন্য',15],
   ['Classic Sunglasses','চশমা',249,320,'🕶️','NEW','স্মার্ট ও ক্যাজুয়াল লুক',10],
   ['Artificial Flower Vase','হোম ডেকর',399,499,'🌷','HOME BEAUTY','ঘর সাজাতে সুন্দর পছন্দ',8],
   ['Mini Gift Light','গিফট',149,199,'✨','GIFT IDEA','ছোট্ট উপহারে বড় আনন্দ',10],
   ['Tasbih Gift Set','গিফট',199,250,'📿','','নিজের জন্য বা উপহার হিসেবে',10],
   ['Minimal Watch','ঘড়ি',599,750,'⌚','SMART PICK','সিম্পল, ক্লাসিক ডিজাইন',8]
  ];
  for(const p of seed) await pool.query('INSERT INTO products(name,category,price,old_price,emoji,label,description,stock) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',p);
 }
 const username=process.env.ADMIN_USERNAME||'admin';
 const password=process.env.ADMIN_PASSWORD;
 if(!password){console.warn('ADMIN_PASSWORD is not set. Set it in Render before using admin login.');}
 else {
  const found=await pool.query('SELECT id FROM admins WHERE username=$1',[username]);
  if(!found.rowCount) await pool.query('INSERT INTO admins(username,password_hash) VALUES($1,$2)',[username,bcrypt.hashSync(password,12)]);
 }
}
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'6mb'}));
app.use(express.urlencoded({extended:false,limit:'100kb'}));
app.use(session({name:'feriwala.sid',secret:process.env.SESSION_SECRET||crypto.randomBytes(48).toString('hex'),resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000}}));
const loginLimiter=rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:true,legacyHeaders:false});
const requireAdmin=(req,res,next)=>req.session&&req.session.adminId?next():res.status(401).json({error:'লগইন করুন।'});
const requireReseller=(req,res,next)=>req.session&&req.session.resellerId?next():res.status(401).json({error:'রিসেলার লগইন করুন।'});
const referralCode=v=>text(v,40).toUpperCase().replace(/[^A-Z0-9_-]/g,'');
app.get('/api/store',(req,res)=>res.json({name:process.env.STORE_NAME||'Feriwala',whatsapp:process.env.WHATSAPP_NUMBER||'',messenger:process.env.FACEBOOK_MESSENGER_URL||''}));
app.get('/api/offers',async(req,res)=>{try{const r=await pool.query('SELECT id,text,product_id AS "productId",image,price,old_price AS "oldPrice",description FROM offers WHERE active=1 ORDER BY id DESC');res.json(r.rows)}catch(e){res.status(500).json({error:'অফার লোড করা যায়নি।'})}});
app.get('/api/products',async(req,res)=>{try{const r=await pool.query('SELECT id,name,category,price,old_price AS "oldPrice",emoji,label,description,stock,image FROM products WHERE active=1 ORDER BY id DESC');res.json(r.rows)}catch(e){res.status(500).json({error:'প্রোডাক্ট লোড করা যায়নি।'})}});
app.post('/api/orders',async(req,res)=>{
 const client=await pool.connect();
 try{
  const customer=text(req.body.name,100),phone=text(req.body.phone,24),address=text(req.body.address,500),payment=text(req.body.payment,40)||'Cash on Delivery';
  const zone=req.body.deliveryZone==='outside'?'outside':'inside',fee=zone==='outside'?120:70,refCode=referralCode(req.body.referralCode||'');
  if(customer.length<2||! /^[0-9+() -]{8,20}$/.test(phone)||address.length<8)return res.status(400).json({error:'নাম, সঠিক মোবাইল নম্বর ও পূর্ণ ঠিকানা দিন।'});
  if(!Array.isArray(req.body.items)||!req.body.items.length||req.body.items.length>50)return res.status(400).json({error:'কার্টে প্রোডাক্ট যোগ করুন।'});
  await client.query('BEGIN');let subtotal=0;const items=[];
  for(const raw of req.body.items){const id=integer(raw.id,1),qty=integer(raw.qty,1,99);const pr=await client.query('SELECT id,name,price,stock,emoji FROM products WHERE id=$1 AND active=1 FOR UPDATE',[id]);const p=pr.rows[0];if(!p)throw new Error('একটি প্রোডাক্ট আর পাওয়া যাচ্ছে না।');if(p.stock<qty)throw new Error(p.name+': বর্তমানে পর্যাপ্ত স্টক নেই।');subtotal+=p.price*qty;items.push({id:p.id,name:p.name,price:p.price,qty,emoji:p.emoji});}
  const total=subtotal+fee;let resellerId=null;if(refCode){const rr=await client.query('SELECT id FROM resellers WHERE referral_code=$1 AND active=TRUE',[refCode]);if(rr.rowCount)resellerId=rr.rows[0].id;}const inserted=await client.query('INSERT INTO orders(customer_name,phone,address,payment,items_json,total,delivery_zone,delivery_fee,reseller_id,referral_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[customer,phone,address,payment,JSON.stringify(items),total,zone,fee,resellerId,resellerId?refCode:null]);
  for(const item of items)await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[item.qty,item.id]);
  await client.query('COMMIT');res.status(201).json({message:'অর্ডার গ্রহণ করা হয়েছে।',id:inserted.rows[0].id,total,subtotal,deliveryFee:fee,deliveryZone:zone});
 }catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.message||'অর্ডার করা যায়নি।'});}finally{client.release();}
});
app.get('/api/orders/status',async(req,res)=>{try{const phone=text(req.query.phone,24).replace(/[\s()-]/g,'');if(!phone||! /^[0-9+]{8,20}$/.test(phone))return res.status(400).json({error:'সঠিক মোবাইল নম্বর দিন।'});const r=await pool.query('SELECT id,customer_name,phone,items_json,total,status,created_at FROM orders WHERE regexp_replace(phone, \'[[:space:]()-]\', \'\', \'g\')=$1 ORDER BY id DESC',[phone]);res.json(r.rows.map(o=>({id:o.id,name:o.customer_name,items:JSON.parse(o.items_json),total:o.total,status:o.status,createdAt:o.created_at})));}catch(e){res.status(400).json({error:'অর্ডারের তথ্য পাওয়া যায়নি।'});}});
app.post('/api/reseller/login',loginLimiter,async(req,res)=>{try{const username=text(req.body.username,100),password=String(req.body.password||'');const r=await pool.query('SELECT id,password_hash FROM resellers WHERE username=$1 AND active=TRUE',[username]);const u=r.rows[0];if(!u||!bcrypt.compareSync(password,u.password_hash))return res.status(401).json({error:'ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'লগইন করা যায়নি।'});req.session.resellerId=u.id;res.json({message:'লগইন সফল।'});});}catch(e){res.status(500).json({error:'লগইন করা যায়নি।'})}});
app.post('/api/reseller/logout',(req,res)=>req.session.destroy(()=>res.json({message:'লগআউট হয়েছে।'})));
app.get('/api/reseller/me',requireReseller,async(req,res)=>{try{const r=await pool.query('SELECT id,username,referral_code AS "referralCode",normal_type AS "normalType",normal_value AS "normalValue",offer_type AS "offerType",offer_value AS "offerValue" FROM resellers WHERE id=$1 AND active=TRUE',[req.session.resellerId]);if(!r.rowCount)return res.status(401).json({error:'অ্যাকাউন্ট বন্ধ আছে।'});res.json(r.rows[0]);}catch(e){res.status(500).json({error:'অ্যাকাউন্ট লোড করা যায়নি।'})}});
app.get('/api/reseller/dashboard',requireReseller,async(req,res)=>{try{const id=req.session.resellerId;const s=await pool.query("SELECT COUNT(*)::int AS orders,COALESCE(SUM(total),0)::numeric AS sales FROM orders WHERE reseller_id=$1 AND status <> 'Cancelled'",[id]);const c=await pool.query("SELECT COALESCE(SUM(amount) FILTER(WHERE status='payable'),0)::numeric AS payable,COALESCE(SUM(amount) FILTER(WHERE status='paid'),0)::numeric AS paid FROM reseller_commissions WHERE reseller_id=$1",[id]);const o=await pool.query("SELECT o.id,o.total,o.status,o.created_at AS \"createdAt\",COALESCE(rc.amount,0)::numeric AS commission,COALESCE(rc.status,'pending') AS \"commissionStatus\" FROM orders o LEFT JOIN reseller_commissions rc ON rc.order_id=o.id AND rc.reseller_id=o.reseller_id WHERE o.reseller_id=$1 ORDER BY o.id DESC LIMIT 100",[id]);const me=await pool.query('SELECT referral_code FROM resellers WHERE id=$1',[id]);res.json({sales:{orders:s.rows[0].orders,total:Number(s.rows[0].sales)},commission:{payable:Number(c.rows[0].payable),paid:Number(c.rows[0].paid)},referralCode:me.rows[0].referral_code,orders:o.rows});}catch(e){res.status(500).json({error:'ড্যাশবোর্ড লোড করা যায়নি।'})}});
app.post('/api/admin/resellers',requireAdmin,async(req,res)=>{try{const username=text(req.body.username,60),password=String(req.body.password||''),code=referralCode(req.body.referralCode||('FER'+crypto.randomBytes(4).toString('hex').toUpperCase()));if(!/^[a-zA-Z0-9_.-]{3,60}$/.test(username)||password.length<10)return res.status(400).json({error:'ইউজারনেম ৩+ অক্ষর এবং পাসওয়ার্ড কমপক্ষে ১০ অক্ষরের দিন।'});const nt=req.body.normalType==='fixed'?'fixed':'percent',ot=req.body.offerType==='percent'?'percent':'fixed',nv=Number(req.body.normalValue??10),ov=Number(req.body.offerValue??20);if(!Number.isFinite(nv)||nv<0||!Number.isFinite(ov)||ov<0)return res.status(400).json({error:'কমিশনের মান সঠিক নয়।'});const r=await pool.query('INSERT INTO resellers(username,password_hash,referral_code,normal_type,normal_value,offer_type,offer_value) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,username,referral_code AS "referralCode",active,normal_type AS "normalType",normal_value AS "normalValue",offer_type AS "offerType",offer_value AS "offerValue"',[username,bcrypt.hashSync(password,12),code,nt,nv,ot,ov]);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({error:e.code==='23505'?'ইউজারনেম বা Referral Code আগে থেকেই আছে।':'রিসেলার তৈরি করা যায়নি।'})}});
app.get('/api/admin/resellers',requireAdmin,async(req,res)=>{try{const r=await pool.query("SELECT r.id,r.username,r.referral_code AS \"referralCode\",r.active,r.normal_type AS \"normalType\",r.normal_value AS \"normalValue\",r.offer_type AS \"offerType\",r.offer_value AS \"offerValue\",COALESCE((SELECT SUM(o.total) FROM orders o WHERE o.reseller_id=r.id AND o.status <> 'Cancelled'),0)::numeric AS sales,(SELECT COUNT(*) FROM orders o WHERE o.reseller_id=r.id AND o.status <> 'Cancelled')::int AS orders,COALESCE((SELECT SUM(c.amount) FROM reseller_commissions c WHERE c.reseller_id=r.id AND c.status='payable'),0)::numeric AS payable,COALESCE((SELECT SUM(c.amount) FROM reseller_commissions c WHERE c.reseller_id=r.id AND c.status='paid'),0)::numeric AS paid FROM resellers r ORDER BY r.id DESC");res.json(r.rows);}catch(e){res.status(500).json({error:'রিসেলার লোড করা যায়নি।'})}});
app.patch('/api/admin/resellers/:id',requireAdmin,async(req,res)=>{try{const nt=req.body.normalType==='fixed'?'fixed':'percent',ot=req.body.offerType==='percent'?'percent':'fixed',nv=Number(req.body.normalValue),ov=Number(req.body.offerValue);if(!Number.isFinite(nv)||nv<0||!Number.isFinite(ov)||ov<0)return res.status(400).json({error:'কমিশনের মান সঠিক নয়।'});const r=await pool.query('UPDATE resellers SET normal_type=$1,normal_value=$2,offer_type=$3,offer_value=$4,active=$5 WHERE id=$6 RETURNING id',[nt,nv,ot,ov,req.body.active!==false,integer(req.params.id,1)]);if(!r.rowCount)return res.status(404).json({error:'রিসেলার পাওয়া যায়নি।'});res.json({message:'সেটিংস আপডেট হয়েছে।'});}catch(e){res.status(400).json({error:'সেটিংস আপডেট করা যায়নি।'})}});
app.get('/api/admin/reseller-commissions',requireAdmin,async(req,res)=>{try{const r=await pool.query("SELECT c.id,c.order_id AS \"orderId\",c.reseller_id AS \"resellerId\",rs.username,rs.referral_code AS \"referralCode\",c.amount,c.status,c.created_at AS \"createdAt\",c.paid_at AS \"paidAt\" FROM reseller_commissions c JOIN resellers rs ON rs.id=c.reseller_id ORDER BY c.id DESC LIMIT 500");res.json(r.rows);}catch(e){res.status(500).json({error:'কমিশন হিসাব লোড করা যায়নি।'})}});
app.post('/api/admin/reseller-commissions/:id/pay',requireAdmin,async(req,res)=>{try{const r=await pool.query("UPDATE reseller_commissions SET status='paid',paid_at=NOW() WHERE id=$1 AND status='payable' RETURNING id",[integer(req.params.id,1)]);if(!r.rowCount)return res.status(404).json({error:'পাওনাযোগ্য কমিশন পাওয়া যায়নি।'});res.json({message:'কমিশন পরিশোধিত হয়েছে।'});}catch(e){res.status(400).json({error:'পেমেন্ট আপডেট করা যায়নি।'})}});
app.post('/api/admin/login',loginLimiter,async(req,res)=>{try{const username=text(req.body.username,100),password=String(req.body.password||'');const r=await pool.query('SELECT id,password_hash FROM admins WHERE username=$1',[username]);const admin=r.rows[0];if(!admin||!bcrypt.compareSync(password,admin.password_hash))return res.status(401).json({error:'ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'লগইন করা যায়নি।'});req.session.adminId=admin.id;res.json({message:'লগইন সফল।'});});}catch(e){res.status(500).json({error:'লগইন করা যায়নি।'})}});
app.post('/api/admin/logout',(req,res)=>req.session.destroy(()=>res.json({message:'লগআউট হয়েছে।'})));
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({loggedIn:true}));
app.get('/api/admin/categories',requireAdmin,async(req,res)=>{try{res.json((await pool.query('SELECT id,name FROM categories ORDER BY name ASC')).rows)}catch(e){res.status(500).json({error:'ক্যাটাগরি লোড করা যায়নি।'})}});
app.post('/api/admin/categories',requireAdmin,async(req,res)=>{try{const name=text(req.body.name,50);if(name.length<2)return res.status(400).json({error:'ক্যাটাগরির নাম কমপক্ষে ২ অক্ষরের দিন।'});const r=await pool.query('INSERT INTO categories(name) VALUES($1) ON CONFLICT(name) DO NOTHING RETURNING id,name',[name]);const row=r.rows[0]||(await pool.query('SELECT id,name FROM categories WHERE name=$1',[name])).rows[0];res.status(201).json({message:'ক্যাটাগরি সংরক্ষণ হয়েছে।',category:row})}catch(e){res.status(400).json({error:'ক্যাটাগরি যোগ করা যায়নি।'})}});
app.get('/api/admin/products',requireAdmin,async(req,res)=>{try{res.json((await pool.query('SELECT * FROM products ORDER BY id DESC')).rows)}catch(e){res.status(500).json({error:'প্রোডাক্ট লোড করা যায়নি।'})}});
app.get('/api/admin/offers',requireAdmin,async(req,res)=>{try{res.json((await pool.query('SELECT * FROM offers ORDER BY id DESC')).rows)}catch(e){res.status(500).json({error:'অফার লোড করা যায়নি।'})}});
app.post('/api/admin/offers',requireAdmin,async(req,res)=>{try{const value=text(req.body.text,500),productId=req.body.productId?integer(req.body.productId,1):null,image=validImage(req.body.image),price=integer(req.body.price||0),oldPrice=integer(req.body.oldPrice||0),description=text(req.body.description,300);if(!value)return res.status(400).json({error:'অফারের নাম/লেখা দিন।'});if(productId&&!(await pool.query('SELECT id FROM products WHERE id=$1',[productId])).rowCount)return res.status(400).json({error:'সঠিক প্রোডাক্ট নির্বাচন করুন।'});const r=await pool.query('INSERT INTO offers(text,active,product_id,image,price,old_price,description) VALUES($1,1,$2,$3,$4,$5,$6) RETURNING id',[value,productId,image,price,oldPrice,description]);res.status(201).json({id:r.rows[0].id,message:'অফার যোগ হয়েছে।'})}catch(e){res.status(400).json({error:e.message||'অফার যোগ করা যায়নি।'})}});
app.delete('/api/admin/offers/:id',requireAdmin,async(req,res)=>{try{const r=await pool.query('DELETE FROM offers WHERE id=$1',[integer(req.params.id,1)]);if(!r.rowCount)return res.status(404).json({error:'অফার পাওয়া যায়নি।'});res.json({message:'অফার মুছে ফেলা হয়েছে।'})}catch(e){res.status(400).json({error:'অফার মুছে ফেলা যায়নি।'})}});
app.post('/api/admin/products',requireAdmin,async(req,res)=>{try{const p=req.body,image=validImage(p.image);const r=await pool.query('INSERT INTO products(name,category,price,old_price,emoji,label,description,stock,active,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[text(p.name,120),text(p.category,50),integer(p.price),integer(p.oldPrice||0),text(p.emoji||'🎁',12),text(p.label,40),text(p.description,300),integer(p.stock||0),p.active===false?0:1,image]);res.status(201).json({id:r.rows[0].id,message:'প্রোডাক্ট যোগ হয়েছে।'})}catch(e){res.status(400).json({error:e.message||'তথ্য সঠিক নয়।'})}});
app.put('/api/admin/products/:id',requireAdmin,async(req,res)=>{try{const p=req.body,image=validImage(p.image);const r=await pool.query('UPDATE products SET name=$1,category=$2,price=$3,old_price=$4,emoji=$5,label=$6,description=$7,stock=$8,active=$9,image=$10 WHERE id=$11',[text(p.name,120),text(p.category,50),integer(p.price),integer(p.oldPrice||0),text(p.emoji||'🎁',12),text(p.label,40),text(p.description,300),integer(p.stock||0),p.active===false?0:1,image,integer(req.params.id,1)]);if(!r.rowCount)return res.status(404).json({error:'প্রোডাক্ট পাওয়া যায়নি।'});res.json({message:'প্রোডাক্ট আপডেট হয়েছে।'})}catch(e){res.status(400).json({error:e.message||'তথ্য সঠিক নয়।'})}});
app.delete('/api/admin/products/:id',requireAdmin,async(req,res)=>{try{const r=await pool.query('DELETE FROM products WHERE id=$1',[integer(req.params.id,1)]);if(!r.rowCount)return res.status(404).json({error:'প্রোডাক্ট পাওয়া যায়নি।'});res.json({message:'প্রোডাক্ট ডিলিট হয়েছে।'})}catch(e){res.status(400).json({error:'প্রোডাক্ট ডিলিট করা যায়নি।'})}});
app.get('/api/admin/orders',requireAdmin,async(req,res)=>{try{const r=await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 500');res.json(r.rows.map(o=>({...o,items:JSON.parse(o.items_json)})))}catch(e){res.status(500).json({error:'অর্ডার লোড করা যায়নি।'})}});
app.patch('/api/admin/orders/:id',requireAdmin,async(req,res)=>{try{const allowed=['New','Confirmed','Processing','Shipped','Delivered','Cancelled'],status=text(req.body.status,20);if(!allowed.includes(status))return res.status(400).json({error:'স্ট্যাটাস সঠিক নয়।'});const id=integer(req.params.id,1),client=await pool.connect();try{await client.query('BEGIN');const old=await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id]);if(!old.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'অর্ডার পাওয়া যায়নি।'});}const o=old.rows[0];await client.query('UPDATE orders SET status=$1 WHERE id=$2',[status,id]);if(status==='Delivered'&&o.reseller_id&&!o.commission_processed){const r=(await client.query('SELECT normal_type,normal_value,offer_type,offer_value FROM resellers WHERE id=$1',[o.reseller_id])).rows[0];if(r){let amount=0;for(const item of JSON.parse(o.items_json)){const of=(await client.query('SELECT EXISTS(SELECT 1 FROM offers WHERE product_id=$1 AND active=1) AS yes',[item.id])).rows[0].yes;const type=of?r.offer_type:r.normal_type,value=Number(of?r.offer_value:r.normal_value);amount+=type==='percent'?Number(item.price)*Number(item.qty)*value/100:value*Number(item.qty);}await client.query("INSERT INTO reseller_commissions(reseller_id,order_id,amount,status) VALUES($1,$2,$3,'payable') ON CONFLICT(reseller_id,order_id) DO NOTHING",[o.reseller_id,id,amount]);}await client.query('UPDATE orders SET commission_processed=TRUE WHERE id=$1',[id]);}if(status==='Cancelled'&&o.reseller_id)await client.query("UPDATE reseller_commissions SET status='reversed' WHERE order_id=$1 AND status='payable'",[id]);await client.query('COMMIT');res.json({message:'অর্ডার স্ট্যাটাস আপডেট হয়েছে।'});}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}}catch(e){res.status(400).json({error:'অর্ডার আপডেট করা যায়নি।'})}});
app.use('/admin',express.static(path.join(__dirname,'admin')));
app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
initDb().then(()=>app.listen(PORT,()=>console.log('Feriwala PostgreSQL service running on port '+PORT))).catch(err=>{console.error('Feriwala database startup failed:',err);process.exit(1)});
