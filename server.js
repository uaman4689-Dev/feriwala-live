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
 CREATE TABLE IF NOT EXISTS offers (id BIGSERIAL PRIMARY KEY, text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), product_id BIGINT, image TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0, old_price INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '');
 `);
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
app.get('/api/store',(req,res)=>res.json({name:process.env.STORE_NAME||'Feriwala',whatsapp:process.env.WHATSAPP_NUMBER||'',messenger:process.env.FACEBOOK_MESSENGER_URL||''}));
app.get('/api/offers',async(req,res)=>{try{const r=await pool.query('SELECT id,text,product_id AS "productId",image,price,old_price AS "oldPrice",description FROM offers WHERE active=1 ORDER BY id DESC');res.json(r.rows)}catch(e){res.status(500).json({error:'অফার লোড করা যায়নি।'})}});
app.get('/api/products',async(req,res)=>{try{const r=await pool.query('SELECT id,name,category,price,old_price AS "oldPrice",emoji,label,description,stock,image FROM products WHERE active=1 ORDER BY id DESC');res.json(r.rows)}catch(e){res.status(500).json({error:'প্রোডাক্ট লোড করা যায়নি।'})}});
app.post('/api/orders',async(req,res)=>{
 const client=await pool.connect();
 try{
  const customer=text(req.body.name,100),phone=text(req.body.phone,24),address=text(req.body.address,500),payment=text(req.body.payment,40)||'Cash on Delivery';
  const zone=req.body.deliveryZone==='outside'?'outside':'inside',fee=zone==='outside'?120:70;
  if(customer.length<2||! /^[0-9+() -]{8,20}$/.test(phone)||address.length<8)return res.status(400).json({error:'নাম, সঠিক মোবাইল নম্বর ও পূর্ণ ঠিকানা দিন।'});
  if(!Array.isArray(req.body.items)||!req.body.items.length||req.body.items.length>50)return res.status(400).json({error:'কার্টে প্রোডাক্ট যোগ করুন।'});
  await client.query('BEGIN');let subtotal=0;const items=[];
  for(const raw of req.body.items){const id=integer(raw.id,1),qty=integer(raw.qty,1,99);const pr=await client.query('SELECT id,name,price,stock,emoji FROM products WHERE id=$1 AND active=1 FOR UPDATE',[id]);const p=pr.rows[0];if(!p)throw new Error('একটি প্রোডাক্ট আর পাওয়া যাচ্ছে না।');if(p.stock<qty)throw new Error(p.name+': বর্তমানে পর্যাপ্ত স্টক নেই।');subtotal+=p.price*qty;items.push({id:p.id,name:p.name,price:p.price,qty,emoji:p.emoji});}
  const total=subtotal+fee;const inserted=await client.query('INSERT INTO orders(customer_name,phone,address,payment,items_json,total,delivery_zone,delivery_fee) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[customer,phone,address,payment,JSON.stringify(items),total,zone,fee]);
  for(const item of items)await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[item.qty,item.id]);
  await client.query('COMMIT');res.status(201).json({message:'অর্ডার গ্রহণ করা হয়েছে।',id:inserted.rows[0].id,total,subtotal,deliveryFee:fee,deliveryZone:zone});
 }catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.message||'অর্ডার করা যায়নি।'});}finally{client.release();}
});
app.get('/api/orders/status',async(req,res)=>{try{const phone=text(req.query.phone,24).replace(/[\s()-]/g,'');if(!phone||! /^[0-9+]{8,20}$/.test(phone))return res.status(400).json({error:'সঠিক মোবাইল নম্বর দিন।'});const r=await pool.query('SELECT id,customer_name,phone,items_json,total,status,created_at FROM orders WHERE regexp_replace(phone, \'[[:space:]()-]\', \'\', \'g\')=$1 ORDER BY id DESC',[phone]);res.json(r.rows.map(o=>({id:o.id,name:o.customer_name,items:JSON.parse(o.items_json),total:o.total,status:o.status,createdAt:o.created_at})));}catch(e){res.status(400).json({error:'অর্ডারের তথ্য পাওয়া যায়নি।'});}});
app.post('/api/admin/login',loginLimiter,async(req,res)=>{try{const username=text(req.body.username,100),password=String(req.body.password||'');const r=await pool.query('SELECT id,password_hash FROM admins WHERE username=$1',[username]);const admin=r.rows[0];if(!admin||!bcrypt.compareSync(password,admin.password_hash))return res.status(401).json({error:'ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'লগইন করা যায়নি।'});req.session.adminId=admin.id;res.json({message:'লগইন সফল।'});});}catch(e){res.status(500).json({error:'লগইন করা যায়নি।'})}});
app.post('/api/admin/logout',(req,res)=>req.session.destroy(()=>res.json({message:'লগআউট হয়েছে।'})));
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({loggedIn:true}));
app.get('/api/admin/products',requireAdmin,async(req,res)=>{try{res.json((await pool.query('SELECT * FROM products ORDER BY id DESC')).rows)}catch(e){res.status(500).json({error:'প্রোডাক্ট লোড করা যায়নি।'})}});
app.get('/api/admin/offers',requireAdmin,async(req,res)=>{try{res.json((await pool.query('SELECT * FROM offers ORDER BY id DESC')).rows)}catch(e){res.status(500).json({error:'অফার লোড করা যায়নি।'})}});
app.post('/api/admin/offers',requireAdmin,async(req,res)=>{try{const value=text(req.body.text,500),productId=req.body.productId?integer(req.body.productId,1):null,image=validImage(req.body.image),price=integer(req.body.price||0),oldPrice=integer(req.body.oldPrice||0),description=text(req.body.description,300);if(!value)return res.status(400).json({error:'অফারের নাম/লেখা দিন।'});if(productId&&!(await pool.query('SELECT id FROM products WHERE id=$1',[productId])).rowCount)return res.status(400).json({error:'সঠিক প্রোডাক্ট নির্বাচন করুন।'});const r=await pool.query('INSERT INTO offers(text,active,product_id,image,price,old_price,description) VALUES($1,1,$2,$3,$4,$5,$6) RETURNING id',[value,productId,image,price,oldPrice,description]);res.status(201).json({id:r.rows[0].id,message:'অফার যোগ হয়েছে।'})}catch(e){res.status(400).json({error:e.message||'অফার যোগ করা যায়নি।'})}});
app.delete('/api/admin/offers/:id',requireAdmin,async(req,res)=>{try{const r=await pool.query('DELETE FROM offers WHERE id=$1',[integer(req.params.id,1)]);if(!r.rowCount)return res.status(404).json({error:'অফার পাওয়া যায়নি।'});res.json({message:'অফার মুছে ফেলা হয়েছে।'})}catch(e){res.status(400).json({error:'অফার মুছে ফেলা যায়নি।'})}});
app.post('/api/admin/products',requireAdmin,async(req,res)=>{try{const p=req.body,image=validImage(p.image);const r=await pool.query('INSERT INTO products(name,category,price,old_price,emoji,label,description,stock,active,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[text(p.name,120),text(p.category,50),integer(p.price),integer(p.oldPrice||0),text(p.emoji||'🎁',12),text(p.label,40),text(p.description,300),integer(p.stock||0),p.active===false?0:1,image]);res.status(201).json({id:r.rows[0].id,message:'প্রোডাক্ট যোগ হয়েছে।'})}catch(e){res.status(400).json({error:e.message||'তথ্য সঠিক নয়।'})}});
app.put('/api/admin/products/:id',requireAdmin,async(req,res)=>{try{const p=req.body,image=validImage(p.image);const r=await pool.query('UPDATE products SET name=$1,category=$2,price=$3,old_price=$4,emoji=$5,label=$6,description=$7,stock=$8,active=$9,image=$10 WHERE id=$11',[text(p.name,120),text(p.category,50),integer(p.price),integer(p.oldPrice||0),text(p.emoji||'🎁',12),text(p.label,40),text(p.description,300),integer(p.stock||0),p.active===false?0:1,image,integer(req.params.id,1)]);if(!r.rowCount)return res.status(404).json({error:'প্রোডাক্ট পাওয়া যায়নি।'});res.json({message:'প্রোডাক্ট আপডেট হয়েছে।'})}catch(e){res.status(400).json({error:e.message||'তথ্য সঠিক নয়।'})}});
app.delete('/api/admin/products/:id',requireAdmin,async(req,res)=>{try{const r=await pool.query('DELETE FROM products WHERE id=$1',[integer(req.params.id,1)]);if(!r.rowCount)return res.status(404).json({error:'প্রোডাক্ট পাওয়া যায়নি।'});res.json({message:'প্রোডাক্ট ডিলিট হয়েছে।'})}catch(e){res.status(400).json({error:'প্রোডাক্ট ডিলিট করা যায়নি।'})}});
app.get('/api/admin/orders',requireAdmin,async(req,res)=>{try{const r=await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 500');res.json(r.rows.map(o=>({...o,items:JSON.parse(o.items_json)})))}catch(e){res.status(500).json({error:'অর্ডার লোড করা যায়নি।'})}});
app.patch('/api/admin/orders/:id',requireAdmin,async(req,res)=>{try{const allowed=['New','Confirmed','Processing','Shipped','Delivered','Cancelled'],status=text(req.body.status,20);if(!allowed.includes(status))return res.status(400).json({error:'স্ট্যাটাস সঠিক নয়।'});const r=await pool.query('UPDATE orders SET status=$1 WHERE id=$2',[status,integer(req.params.id,1)]);if(!r.rowCount)return res.status(404).json({error:'অর্ডার পাওয়া যায়নি।'});res.json({message:'অর্ডার স্ট্যাটাস আপডেট হয়েছে।'})}catch(e){res.status(400).json({error:'অর্ডার আপডেট করা যায়নি।'})}});
app.use('/admin',express.static(path.join(__dirname,'admin')));
app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
initDb().then(()=>app.listen(PORT,()=>console.log('Feriwala PostgreSQL service running on port '+PORT))).catch(err=>{console.error('Feriwala database startup failed:',err);process.exit(1)});
