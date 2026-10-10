require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const dbPath = process.env.DATABASE_PATH || path.join(ROOT, 'data', 'feriwala.sqlite');
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
let db;
let transactionDepth = 0;
function persistDb() {
 if (transactionDepth === 0 && db) fs.writeFileSync(dbPath, Buffer.from(db.export()));
}
function makeDb(SQL, existingBytes) {
 const raw = existingBytes ? new SQL.Database(new Uint8Array(existingBytes)) : new SQL.Database();
 return {
  exec(sql) { raw.exec(sql); persistDb(); },
  prepare(sql) { return {
   get(...params) { const stmt = raw.prepare(sql); try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); } },
   all(...params) { const stmt = raw.prepare(sql); const rows=[]; try { stmt.bind(params); while(stmt.step()) rows.push(stmt.getAsObject()); return rows; } finally { stmt.free(); } },
   run(...params) { raw.run(sql, params); const changes = raw.getRowsModified(); const last = raw.exec('SELECT last_insert_rowid() AS id'); const lastInsertRowid = last.length && last[0].values.length ? last[0].values[0][0] : 0; persistDb(); return { changes, lastInsertRowid }; }
  }; },
  transaction(fn) { return (...args) => { raw.run('BEGIN TRANSACTION'); transactionDepth++; try { const out=fn(...args); raw.run('COMMIT'); transactionDepth--; persistDb(); return out; } catch(e) { try { raw.run('ROLLBACK'); } catch(_) {} transactionDepth--; throw e; } }; },
  export() { return raw.export(); },
  close() { raw.close(); }
 };
}
async function start() {
 const SQL = await initSqlJs();
 const existingBytes = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
 db = makeDb(SQL, existingBytes);
 db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL,
 price INTEGER NOT NULL CHECK(price >= 0), old_price INTEGER NOT NULL DEFAULT 0 CHECK(old_price >= 0),
 emoji TEXT NOT NULL DEFAULT '🎁', label TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
 stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
 address TEXT NOT NULL, payment TEXT NOT NULL DEFAULT 'Cash on Delivery', items_json TEXT NOT NULL,
 total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'New', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
`);
const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (!count) {
 const seed = [
 ['Classic Couple Watch Set','ঘড়ি',890,1090,'⌚','POPULAR','কাপল গিফট সেট',12],
 ['Soft Musk Attar','আতর',199,250,'🌿','BESTSELLER','সফট ও এলিগ্যান্ট সুগন্ধ',20],
 ['Everyday Money Wallet','মানিব্যাগ',299,350,'👛','','দৈনন্দিন ব্যবহারের জন্য',15],
 ['Classic Sunglasses','চশমা',249,320,'🕶️','NEW','স্মার্ট ও ক্যাজুয়াল লুক',10],
 ['Artificial Flower Vase','হোম ডেকর',399,499,'🌷','HOME BEAUTY','ঘর সাজাতে সুন্দর পছন্দ',8],
 ['Mini Gift Light','গিফট',149,199,'✨','GIFT IDEA','ছোট্ট উপহারে বড় আনন্দ',10],
 ['Tasbih Gift Set','গিফট',199,250,'📿','','নিজের জন্য বা উপহার হিসেবে',10],
 ['Minimal Watch','ঘড়ি',599,750,'⌚','SMART PICK','সিম্পল, ক্লাসিক ডিজাইন',8]
 ];
 const insert = db.prepare('INSERT INTO products(name,category,price,old_price,emoji,label,description,stock) VALUES(?,?,?,?,?,?,?,?)');
 db.transaction(rows => rows.forEach(row => insert.run(...row)))(seed);
}
const adminUser = process.env.ADMIN_USERNAME || 'admin';
const adminPass = process.env.ADMIN_PASSWORD || 'ChangeThisPassword123!';
if (!db.prepare('SELECT id FROM admins WHERE username=?').get(adminUser)) {
 db.prepare('INSERT INTO admins(username,password_hash) VALUES(?,?)').run(adminUser, bcrypt.hashSync(adminPass, 12));
}
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(session({
 name: 'feriwala.sid', secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
 resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const requireAdmin = (req, res, next) => req.session && req.session.adminId ? next() : res.status(401).json({ error: 'লগইন করুন।' });
const text = (v, max=250) => String(v ?? '').trim().slice(0,max);
const integer = (v, min=0, max=100000000) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('দাম/স্টকের মান সঠিক নয়।'); return n; };
app.get('/api/store', (req,res) => res.json({name:process.env.STORE_NAME || 'Feriwala', whatsapp:process.env.WHATSAPP_NUMBER || '', messenger:process.env.FACEBOOK_MESSENGER_URL || ''}));
app.get('/api/products', (req,res) => res.json(db.prepare('SELECT id,name,category,price,old_price AS oldPrice,emoji,label,description,stock FROM products WHERE active=1 ORDER BY id DESC').all()));
app.post('/api/orders', (req,res) => {
 try {
  const customer = text(req.body.name,100), phone=text(req.body.phone,24), address=text(req.body.address,500), payment=text(req.body.payment,40) || 'Cash on Delivery';
  if (customer.length < 2 || !/^[0-9+() -]{8,20}$/.test(phone) || address.length < 8) return res.status(400).json({error:'নাম, সঠিক মোবাইল নম্বর ও পূর্ণ ঠিকানা দিন।'});
  if (!Array.isArray(req.body.items) || !req.body.items.length || req.body.items.length > 50) return res.status(400).json({error:'কার্টে প্রোডাক্ট যোগ করুন।'});
  const result = db.transaction(() => {
   let total=0; const items=[];
   for (const raw of req.body.items) {
    const id=integer(raw.id,1), qty=integer(raw.qty,1,99); const p=db.prepare('SELECT id,name,price,stock,emoji FROM products WHERE id=? AND active=1').get(id);
    if (!p) throw new Error('একটি প্রোডাক্ট আর পাওয়া যাচ্ছে না।');
    if (p.stock < qty) throw new Error(`${p.name}: বর্তমানে পর্যাপ্ত স্টক নেই।`);
    total += p.price*qty; items.push({id:p.id,name:p.name,price:p.price,qty,emoji:p.emoji});
   }
   const info=db.prepare('INSERT INTO orders(customer_name,phone,address,payment,items_json,total) VALUES(?,?,?,?,?,?)').run(customer,phone,address,payment,JSON.stringify(items),total);
   const upd=db.prepare('UPDATE products SET stock=stock-? WHERE id=?'); items.forEach(i=>upd.run(i.qty,i.id));
   return {id:info.lastInsertRowid,total};
  })();
  res.status(201).json({message:'অর্ডার গ্রহণ করা হয়েছে।',...result});
 } catch(e) { res.status(400).json({error:e.message || 'অর্ডার করা যায়নি।'}); }
});
app.post('/api/admin/login', loginLimiter, (req,res) => {
 const username=text(req.body.username,100), password=String(req.body.password || '');
 const admin=db.prepare('SELECT id,password_hash FROM admins WHERE username=?').get(username);
 if (!admin || !bcrypt.compareSync(password,admin.password_hash)) return res.status(401).json({error:'ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।'});
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:'লগইন করা যায়নি।'});req.session.adminId=admin.id;res.json({message:'লগইন সফল।'});});
});
app.post('/api/admin/logout', (req,res)=>req.session.destroy(()=>res.json({message:'লগআউট হয়েছে।'})));
app.get('/api/admin/me', requireAdmin, (req,res)=>res.json({loggedIn:true}));
app.get('/api/admin/products', requireAdmin, (req,res)=>res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all()));
app.post('/api/admin/products', requireAdmin, (req,res)=>{
 try {const p=req.body;const info=db.prepare('INSERT INTO products(name,category,price,old_price,emoji,label,description,stock,active) VALUES(?,?,?,?,?,?,?,?,?)').run(text(p.name,120),text(p.category,50),integer(p.price),integer(p.oldPrice||0),text(p.emoji||'🎁',12),text(p.label,40),text(p.description,300),integer(p.stock||0),p.active===false?0:1);res.status(201).json({id:info.lastInsertRowid,message:'প্রোডাক্ট যোগ হয়েছে।'});}catch(e){res.status(400).json({error:e.message||'তথ্য সঠিক নয়।'});}
});
app.put('/api/admin/products/:id', requireAdmin, (req,res)=>{
 try {const p=req.body;const info=db.prepare('UPDATE products SET name=?,category=?,price=?,old_price=?,emoji=?,label=?,description=?,stock=?,active=? WHERE id=?').run(text(p.name,120),text(p.category,50),integer(p.price),integer(p.oldPrice||0),text(p.emoji||'🎁',12),text(p.label,40),text(p.description,300),integer(p.stock||0),p.active===false?0:1,integer(req.params.id,1));if(!info.changes)return res.status(404).json({error:'প্রোডাক্ট পাওয়া যায়নি।'});res.json({message:'প্রোডাক্ট আপডেট হয়েছে।'});}catch(e){res.status(400).json({error:e.message||'তথ্য সঠিক নয়।'});}
});
app.delete('/api/admin/products/:id', requireAdmin, (req,res)=>{const info=db.prepare('DELETE FROM products WHERE id=?').run(Number(req.params.id));if(!info.changes)return res.status(404).json({error:'প্রোডাক্ট পাওয়া যায়নি।'});res.json({message:'প্রোডাক্ট ডিলিট হয়েছে।'});});
app.get('/api/admin/orders', requireAdmin, (req,res)=>res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 500').all().map(o=>({...o,items:JSON.parse(o.items_json)}))));
app.patch('/api/admin/orders/:id', requireAdmin, (req,res)=>{const allowed=['New','Confirmed','Processing','Shipped','Delivered','Cancelled'];const status=text(req.body.status,20);if(!allowed.includes(status))return res.status(400).json({error:'স্ট্যাটাস সঠিক নয়।'});const info=db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,Number(req.params.id));if(!info.changes)return res.status(404).json({error:'অর্ডার পাওয়া যায়নি।'});res.json({message:'অর্ডার স্ট্যাটাস আপডেট হয়েছে।'});});
app.use('/admin', express.static(path.join(ROOT,'admin')));
app.use(express.static(path.join(ROOT,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.listen(PORT,()=>console.log(`Feriwala is running on http://localhost:${PORT}`));
}
start().catch(err => { console.error('Feriwala startup failed:', err); process.exit(1); });
