# Feriwala Online Shop — লাইভ করার গাইড

এটি শুধু ডিজাইন ডেমো নয়। ডেটাবেসের জন্য `sql.js` ব্যবহার করা হয়েছে, তাই Windows-এ `better-sqlite3`-এর মতো C++ Build Tools কম্পাইল করার প্রয়োজন নেই। ছোট/শুরুর দোকানের জন্য উপযোগী; প্রতিটি পরিবর্তনে ডেটাবেস ফাইল সেভ হয়। এতে রয়েছে customer storefront, backend API, SQLite database (sql.js, native C++ build tools ছাড়াই), admin login, product add/edit/delete, stock tracking এবং order management। প্রথমবার চালু হলে ৮টি নমুনা প্রোডাক্ট যোগ হবে। এগুলো নিজের পণ্য/দাম দিয়ে বদলে নেবেন।

## ১. কম্পিউটারে চালান

1. ZIP extract করুন।
2. Node.js 20 বা তার নতুন সংস্করণ ইনস্টল করুন: https://nodejs.org/
3. এই ফোল্ডারে Terminal/Command Prompt খুলুন।
4. `.env.example` ফাইলের কপি করে `.env` নাম দিন।
5. `.env` ফাইলে `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET` বদলান। লম্বা, অনুমান করা কঠিন পাসওয়ার্ড/সিক্রেট ব্যবহার করুন।
6. চালান:

   ```bash
   npm install
   npm start
   ```

7. Customer site: http://localhost:3000
8. Admin panel: http://localhost:3000/admin/

## ২. লাইভ সার্ভারে নেওয়া

- Node.js চালাতে পারে এমন VPS/Node hosting ব্যবহার করুন। সাধারণ static hosting-এ backend চলবে না।
- Project files সার্ভারে upload করুন, `npm install` চালান, environment variables সেট করুন এবং `npm start`/process manager দিয়ে app চালু রাখুন।
- Domain DNS-কে সার্ভারে point করুন এবং HTTPS/SSL চালু করুন। Production-এ `NODE_ENV=production` দিন।
- `SESSION_SECRET` ও `ADMIN_PASSWORD` অবশ্যই নিজের মতো বদলাবেন; `.env` GitHub/public repository-তে upload করবেন না।
- SQLite database-এর জন্য persistent disk/volume ব্যবহার করুন এবং `DATABASE_PATH`-এ তার স্থায়ী path দিন। Deploy/restart-এর পর database file মুছে যায় এমন ephemeral hosting ব্যবহার করবেন না। নিয়মিত database backup নিন।
- Session store এই starter project-এ Express-এর default memory store। একক instance-এর ছোট শুরুতে কাজ করবে, কিন্তু production-এ স্থায়ী/বহু instance-এর জন্য Redis/SQLite-backed session store সেটআপ করা উচিত।
- Checkout বর্তমানে Cash on Delivery বা Mobile Banking পদ্ধতির অর্ডার request নেয়; কোনো payment gateway টাকা সংগ্রহ করে না। bKash/Nagad/SSLCommerz যোগ করতে আলাদা merchant integration লাগবে।

## ৩. Admin কীভাবে ব্যবহার করবেন

`/admin/` খুলে `.env`-এর username/password দিয়ে লগইন করুন। “নতুন প্রোডাক্ট” দিয়ে পণ্য যোগ, “এডিট” দিয়ে দাম/স্টক/তথ্য বদল, “ডিলিট” দিয়ে পণ্য সরাতে পারবেন। “অর্ডার ম্যানেজমেন্ট” ট্যাবে কাস্টমারের অর্ডার ও status পাবেন।

## ৪. লাইভের আগে চেকলিস্ট

- [ ] নমুনা পণ্যের নাম, দাম, স্টক, বিবরণ নিজের তথ্য দিয়ে বদলানো
- [ ] `.env`-এর admin password ও session secret পরিবর্তন
- [ ] আসল WhatsApp নম্বর `WHATSAPP_NUMBER`-এ বসানো (দেশের কোডসহ, যেমন 8801XXXXXXXXX)
- [ ] Facebook Page username দিয়ে `FACEBOOK_MESSENGER_URL`-এ `https://m.me/YourPageUsername` বসানো
- [ ] HTTPS, persistent database storage ও backup পরীক্ষা
- [ ] নিজের ফোন থেকে test order করে admin panel-এ দেখা
- [ ] Delivery charge, return policy, privacy notice ও payment details যোগ করা

**সীমাবদ্ধতা:** পণ্যের ছবির বদলে এখন ইমোজি ব্যবহার করা হয়েছে। এটি চালু হওয়ার মতো starter full-stack project, কিন্তু আপনার hosting/domain-এ deploy ও বাস্তব order test না করা পর্যন্ত একে live/published বলা যাবে না।
