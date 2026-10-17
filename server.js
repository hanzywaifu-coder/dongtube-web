require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const db = require('./lib/db');
const pay2 = require('./lib/pay2');
const { iconUrl } = require('./lib/otp-icons');
const DbSessionStore = require('./lib/session-store');

const PORT = Number(process.env.PORT || 3002);
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 10000);
const FALLBACK_COUNTRY = String(process.env.DEFAULT_COUNTRY || '7');
const HISTORY_PAGE = 20;
const absUrl = (v) => {
  const s = String(v || '');
  return s.startsWith('/') ? pay2.origin() + s : s;
};
const ACTIVE_LIMIT = 12;
const REFRESH_BUDGET = 2;
const ACTIVE_STATUSES = ['submitting', 'active', 'received'];
const REMOTE_FINAL = ['cancelled', 'failed', 'expired'];
const LOCAL_FINAL = ['cancelled', 'finished'];
const JKT_OFFSET = 7 * 3600;

const app = express();

/* Express 4 tidak meneruskan rejection promise dari handler async ke error
   middleware (diam-diam jadi unhandled rejection). Bungkus semua handler agar
   setiap kegagalan proses berakhir di error middleware, bukan hilang senyap. */
function wrapHandler(fn) {
  if (typeof fn !== 'function' || fn.length === 4) return fn;
  const w = function (req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.catch(next);
      return out;
    } catch (e) { next(e); }
  };
  Object.defineProperty(w, 'name', { value: fn.name || 'wrapped' });
  return w;
}
for (const m of ['use', 'get', 'post', 'put', 'patch', 'delete', 'all']) {
  const orig = app[m];
  app[m] = function (...args) { return orig.apply(this, args.map(wrapHandler)); };
}

/* Mode perawatan otomatis, tanpa ping dan tanpa timer:
   - Semua data hanya lewat API DongtubeDB (lib/db.js). Saat koneksi gagal,
     lib/db.js menandai down dan gate di bawah menolak SELURUH permintaan
     (503 perawatan), termasuk halaman tamu dan berkas statis, sampai ada
     percobaan koneksi yang berhasil.
   - Pemulihan dicek HANYA saat ada permintaan nyata yang masuk: percobaan
     boot diulang dengan jeda minimal BOOT_RETRY_MS, jadi tidak pernah ada
     trafik tambahan. */
let booted = false;
let booting = null;
let bootRetryAt = 0;
const BOOT_RETRY_MS = 3000;

const downPage = (status) => {
  const title = status === 503 ? 'Layanan sementara berhenti' : 'Terjadi kesalahan';
  const body = status === 503
    ? 'Koneksi ke database gagal, sehingga seluruh proses dihentikan agar tidak ada data yang diproses tanpa tercatat.'
    : 'Permintaan tidak dapat diproses. Muat ulang halaman beberapa saat lagi.';
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Layanan tidak tersedia</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;color:#0f172a}.card{background:#fff;border-radius:24px;padding:40px 32px;max-width:420px;text-align:center;box-shadow:0 10px 30px rgba(15,23,42,.08)}h1{font-size:20px;margin:0 0 10px}p{font-size:14px;line-height:1.6;color:#475569;margin:0 0 8px}.code{font-size:12px;color:#94a3b8;margin-top:14px}</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p><p class="code">HTTP ${status}</p></div></body></html>`;
};

/* Seluruh proses boot lewat API DongtubeDB dan idempoten, sehingga aman
   dijalankan ulang setiap kali koneksi berhasil kembali. */
async function bootSteps() {
  await db.ensureTables();
  // Probe tulis NYATA (nilai acak dikirim sebagai parameter, karena fungsi SQL
  // seperti randomblob diblokir API): kegagalan tulis walau baca masih bisa
  // ikut terdeteksi, supaya tidak ada proses yang jalan tanpa tercatat.
  await db.query(`INSERT INTO web_settings (key,value) VALUES('_db_probe',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [crypto.randomUUID()]);
  await db.query(`DELETE FROM web_settings WHERE key='_db_probe'`);
  // Penanda instance disimpan di database itu sendiri (tanpa berkas lokal),
  // supaya keadaannya identik di VPS maupun Vercel.
  const instanceMarker = await db.getOne(`SELECT value FROM web_settings WHERE key='db_instance_id'`);
  if (!instanceMarker) {
    await db.query(`INSERT INTO web_settings (key,value) VALUES ('db_instance_id',?) ON CONFLICT(key) DO NOTHING`, [crypto.randomUUID()]);
  }

  /* Akun admin bawaan sepenuhnya dikontrol .env (ADMIN_USERNAME / ADMIN_EMAIL /
     ADMIN_PASSWORD): dibuat otomatis saat deploy pertama. Password dari .env
     hanya ditekan ulang ketika nilainya diubah di .env (ditandai hash tersimpan
     di web_settings), sehingga ganti password lewat halaman profil tidak
     hilang saat service restart. */
  const envAdminName = (process.env.ADMIN_USERNAME || 'admin').trim();
  const envAdminEmail = (process.env.ADMIN_EMAIL || `${envAdminName}@dongtube.local`).trim().toLowerCase();
  const envAdminPass = process.env.ADMIN_PASSWORD || '';
  const adminRow = await db.getOne('SELECT id,role FROM web_users WHERE email=?', [envAdminEmail]);
  if (!adminRow) {
    await db.query('INSERT INTO web_users (name,email,password,role,balance) VALUES (?,?,?,?,?)',
      [envAdminName, envAdminEmail, hashPassword(envAdminPass || 'admin123'), 'admin', 100000]);
  } else if (adminRow.role !== 'admin') {
    await db.query('UPDATE web_users SET role=? WHERE id=?', ['admin', adminRow.id]);
  }
  if (envAdminPass) {
    const envHash = crypto.createHash('sha256').update(envAdminPass).digest('hex');
    const savedHash = await db.getOne(`SELECT value FROM web_settings WHERE key='admin_env_hash'`);
    if (!savedHash || savedHash.value !== envHash) {
      await db.query('UPDATE web_users SET password=? WHERE email=?', [hashPassword(envAdminPass), envAdminEmail]);
      await db.query(`INSERT INTO web_settings (key,value) VALUES ('admin_env_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [envHash]);
    }
  }
  const markupSetting = process.env.DEFAULT_MARKUP_PERCENT || '30';
  await db.query(`INSERT INTO web_settings (key,value) VALUES ('default_markup_percent',?) ON CONFLICT(key) DO NOTHING`, [String(markupSetting)]);
  booted = true;
  bootRetryAt = 0;
}

async function ensureBooted() {
  if (booted && !db.isDown()) return;
  if (booting) return booting;
  if (bootRetryAt && Date.now() - bootRetryAt < BOOT_RETRY_MS) {
    const e = new Error('Database belum terhubung, percobaan berikutnya menyusul.');
    e.status = 503;
    e.reason = 'db_down';
    throw e;
  }
  booting = bootSteps()
    .catch((e) => { bootRetryAt = Date.now(); throw e; })
    .finally(() => { booting = null; });
  return booting;
}

app.use(async (req, res, next) => {
  if (booted && !db.isDown()) return next();
  const wasDown = db.isDown();
  try {
    await ensureBooted();
    if (wasDown) console.log('[db] database pulih, mode perawatan diakhiri');
    return next();
  } catch (e) {
    if (db.isDown() || e.reason === 'db_down') {
      res.set('Retry-After', '10');
      const wantsJson = (req.get('Accept') || '').includes('json') || req.path.startsWith('/api/');
      if (wantsJson) return res.status(503).json({ error: 'Database tidak tersedia. Semua proses berhenti sampai database pulih.', reason: 'db_down' });
      return res.status(503).type('html').send(downPage(503));
    }
    // Gagal bukan karena koneksi (SQL salah / konfigurasi): hentikan di VPS,
    // serahkan ke error middleware di serverless. Tanpa fallback.
    console.error(`[db] boot gagal: ${e && e.message}`);
    if (require.main === module) process.exit(1);
    return next(e);
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// trust proxy 1: nginx di depan mengirim X-Forwarded-Proto, sehingga cookie
// Secure hanya terpasang pada koneksi HTTPS sungguhan (akses langsung :3002 tetap jalan).
app.set('trust proxy', 1);
app.use(session({
  // Sesi selalu disimpan di tabel web_sessions lewat API DongtubeDB, supaya
  // setiap proses tercatat dan perilakunya sama di VPS maupun Vercel.
  store: new DbSessionStore(),
  secret: process.env.SESSION_SECRET || 'change_me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: 'auto', sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

/* ================= utilitas ================= */
const pct = (v) => Math.max(0, Number(v) || 0);
const userPrice = (cost, markup) => Math.round((Number(cost) || 0) * (1 + pct(markup) / 100));
const digits = (v) => String(v ?? '').trim().replace(/[^0-9]/g, '');
const rp = (n) => `Rp ${(Number(n) || 0).toLocaleString('id-ID')}`;

function fail(status, message, reason) {
  const e = new Error(message);
  e.status = status;
  if (reason) e.reason = reason;
  return e;
}
function sendError(res, e, fallback) {
  res.status(Number(e.status) || 500).json({
    error: e.message || fallback || 'Permintaan gagal.',
    ...(e.reason ? { reason: e.reason } : {}),
  });
}

function hashPassword(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(p, salt, 64).toString('hex');
  return `${salt}:${h}`;
}
function verifyPassword(p, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  // Hash tersimpan yang rusak atau bukan hex dianggap salah sandi, bukan
  // menumbangkan proses login dengan exception.
  try {
    const h = crypto.scryptSync(p, salt, 64);
    const w = Buffer.from(hash, 'hex');
    if (w.length !== 64) return false;
    return crypto.timingSafeEqual(h, w);
  } catch (e) { return false; }
}

async function currentUser(req) {
  if (!req.session.userId) return null;
  return db.getOne('SELECT id,name,email,balance,role,markup_percent FROM web_users WHERE id=?', [req.session.userId]);
}

app.use((req, res, next) => {
  res.locals.settings = {
    name: process.env.SITE_NAME || 'Dongtube OTP',
    description: 'Sewa nomor virtual untuk verifikasi SMS ratusan platform. Kode OTP masuk dalam hitungan detik.',
    logoUrl: '',
  };
  res.locals.reqPath = req.path;
  next();
});
app.use(async (req, res, next) => {
  res.locals.user = await currentUser(req);
  next();
});
/* Lencana bottom bar: satu query ringan untuk dua hitungan (pesanan OTP
   aktif dan invoice isi saldo yang masih menunggu pembayaran), hanya untuk
   pengguna login. Tanpa lencana ini pengguna tidak tahu ada pesanan aktif
   atau tagihan yang menggantung saat membuka halaman lain. */
app.use(async (req, res, next) => {
  const u = res.locals.user;
  if (!u) { res.locals.navBadges = null; return next(); }
  const r = await db.getOne(
    `SELECT
       (SELECT COUNT(*) FROM web_orders WHERE user_id=? AND status IN ('submitting','active','received')) AS active,
       (SELECT COUNT(*) FROM web_deposits WHERE user_id=? AND status='pending') AS pending`,
    [u.id, u.id]);
  res.locals.navBadges = { active: Number(r && r.active) || 0, pending: Number(r && r.pending) || 0 };
  next();
});

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  next();
}
function requireAuthJson(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'Sesi berakhir. Silakan masuk kembali.' });
  next();
}
function requireAdmin(req, res, next) {
  const u = res.locals.user;
  if (!u || u.role !== 'admin') return res.redirect('/otp');
  next();
}

const LOGIN_ERRORS = {
  'email-atau-password-salah': 'Email atau password salah.',
  'belum-login': 'Silakan masuk terlebih dahulu.',
  'terlalu-banyak': 'Terlalu banyak percobaan masuk. Tunggu beberapa menit lalu coba lagi.',
};
const REGISTER_ERRORS = {
  'semua-field-wajib': 'Semua field wajib diisi.',
  'email-format': 'Format email tidak valid.',
  'terlalu-banyak': 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.',
  'password-pendek': 'Password minimal 6 karakter.',
  'email-terpakai': 'Email sudah terdaftar. Silakan masuk.',
  'username-terpakai': 'Username sudah dipakai user lain.',
};

/* ================= katalog pay2 ================= */
async function countriesPayload() {
  const data = await pay2.countries();
  const list = (data.countries || []).map((c) => ({
    id: String(c.id),
    name: String(c.name || ''),
    emoji: c.flag || '',
    code: '',
  }));
  return { list, byId: new Map(list.map((c) => [c.id, c])), fallback: String(data.default || FALLBACK_COUNTRY) };
}

function filterTiers(service, operatorId) {
  const tiers = Array.isArray(service.tiers) ? service.tiers : [];
  if (!operatorId) return tiers;
  const scoped = tiers.filter((t) => String(t.operator_id ?? '') === String(operatorId));
  return scoped.length ? scoped : tiers;
}

function pickCheapest(tiers) {
  if (!tiers.length) return null;
  const pool = tiers.filter((t) => Number(t.stock) > 0);
  const list = pool.length ? pool : tiers;
  return list.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
}

function buildServices(raw, operatorId, markup) {
  return raw
    .map((s) => {
      const tiers = filterTiers(s, operatorId);
      const tier = pickCheapest(tiers);
      return {
        code: String(s.service_code ?? ''),
        name: String(s.service_name || ''),
        icon: iconUrl(s.service_name) || '',
        price: userPrice(tier ? tier.price : s.price, markup),
        stock: Number(tier ? tier.stock : s.stock) || 0,
        product_id: String(tier ? tier.product_id : (s.product_id ?? '')),
        tier_count: tiers.length,
        _tiers: tiers,
      };
    })
    .filter((s) => s.code);
}

function toTile(s, countryId) {
  return {
    key: `${s.code}:${countryId}`,
    service_code: s.code,
    icon: s.icon,
    country_id: countryId,
    label: s.name,
    price: s.price,
    stock: s.stock,
    product_id: s.product_id,
    tier_count: s.tier_count,
  };
}

async function loadServices(countryId, operatorId, markup) {
  const svc = await pay2.services(countryId).catch(() => {
    throw fail(503, 'Katalog layanan sedang tidak tersedia. Coba lagi sebentar lagi.', 'provider_down');
  });
  return buildServices(svc.services || [], operatorId, markup);
}

/* ================= statistik halaman OTP ================= */
async function otpStatsFor(userId) {
  const rows = await db.getAll('SELECT status FROM web_orders WHERE user_id=? ORDER BY id DESC LIMIT 500', [userId]);
  const total = rows.length;
  const active = rows.filter((r) => ACTIVE_STATUSES.includes(r.status)).length;
  const success = rows.filter((r) => r.status === 'received' || r.status === 'finished').length;
  return { total, active, success, successRate: total ? Math.round((success / total) * 100) : 0 };
}

async function otpTrendFor(userId) {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db.getAll('SELECT created_at,charged_price FROM web_orders WHERE user_id=? AND created_at>=? ORDER BY id DESC LIMIT 1000',
    [userId, nowSec - 6 * 86400 - JKT_OFFSET]);
  const today = Math.floor((nowSec + JKT_OFFSET) / 86400);
  const buckets = [];
  for (let i = 6; i >= 0; i--) buckets.push({ key: today - i, orders: 0, spending: 0 });
  const index = new Map(buckets.map((b) => [b.key, b]));
  for (const r of rows) {
    const b = index.get(Math.floor(((r.created_at || 0) + JKT_OFFSET) / 86400));
    if (!b) continue;
    b.orders += 1;
    b.spending += Number(r.charged_price) || 0;
  }
  const label = (key) => {
    const d = new Date((key * 86400 - JKT_OFFSET) * 1000);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  return {
    labels: buckets.map((b) => label(b.key)),
    orders: buckets.map((b) => b.orders),
    spending: buckets.map((b) => b.spending),
  };
}

/* ================= pesanan OTP ================= */
async function refundLocal(userId, amount) {
  if (!(amount > 0)) return;
  await db.query('UPDATE web_users SET balance = balance + ? WHERE id = ?', [amount, userId]);
}

function mapPay2Error(e) {
  if (e.reason === 'insufficient_balance' && e.status === 402) {
    return fail(503, 'Layanan OTP belum bisa diproses sekarang. Dana sistem belum terisi, coba lagi nanti.', 'provider_down');
  }
  if (e.status === 429) return fail(429, e.message || 'Terlalu banyak permintaan, tunggu sebentar.', 'rate_limited');
  return fail(Number(e.status) || 500, e.message || 'Pesanan OTP tidak dapat dibuat saat ini.', e.reason || null);
}

async function insertOrder(u, input, item, code, charged) {
  const cost = Number(item.amount) || 0;
  const r = await db.query(
    `INSERT INTO web_orders (user_id,pay2_id,country_id,service_name,service_code,product_id,phone,status,cost_price,charged_price,profit,expires_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      u.id,
      String(item.id),
      input.countryId,
      String(item.service_name || input.serviceName || ''),
      code,
      String(item.product_id || input.productId || ''),
      String(item.phone_number || ''),
      String(item.status || 'submitting'),
      cost,
      charged,
      charged - cost,
      item.expires_at_ms ?? null,
    ]
  );
  return r.lastInsertRowid;
}

async function placeOtpOrder(u, rawInput) {
  const input = rawInput || {};
  const qty = Math.min(100, Math.max(1, Math.floor(Number(input.qty) || 1)));
  const countryId = digits(input.country_id);
  const productId = String(input.product_id ?? '').trim();
  const operatorId = /^\d{1,10}$/.test(String(input.operator_id ?? '').trim()) ? String(input.operator_id).trim() : '';
  const quoted = Number(input.quoted_price) || 0;
  const markup = pct(u.markup_percent);
  if (!countryId) throw fail(400, 'Negara tidak valid.', 'invalid_request');

  const services = await loadServices(countryId, operatorId, markup);
  const serviceCode = digits(input.service_code);
  let service = serviceCode ? services.find((s) => s.code === serviceCode) : null;
  if (!service && productId) service = services.find((s) => s._tiers.some((t) => String(t.product_id) === productId));
  if (!service) throw fail(404, 'Layanan tidak tersedia di katalog.', 'not_found');

  const tier = productId
    ? service._tiers.find((t) => String(t.product_id) === productId)
    : pickCheapest(service._tiers);
  if (!tier) throw fail(409, 'Harga yang dipilih tidak tersedia lagi.', 'not_found');
  const charged = userPrice(tier.price, markup);
  if (quoted > 0 && charged > quoted) {
    throw fail(409, `Harga berubah dari ${rp(quoted)} menjadi ${rp(charged)}. Muat ulang daftar harga lalu coba lagi.`, 'price_changed');
  }
  if ((Number(tier.stock) || 0) < qty) {
    throw fail(409, 'Stok untuk harga ini sedang habis. Silakan pilih harga lain.', 'out_of_stock');
  }

  const total = charged * qty;
  const debit = await db.query('UPDATE web_users SET balance=balance-? WHERE id=? AND balance>=?', [total, u.id, total]);
  if (!debit.changes) throw fail(402, 'Saldo tidak cukup. Silakan isi saldo terlebih dahulu.', 'insufficient_balance');

  const payload = {
    country_id: countryId,
    service_code: service.code,
    product_id: String(tier.product_id),
    operator_id: operatorId,
    quoted_price: charged,
    qty,
  };
  let data;
  try {
    try {
      data = await pay2.order(payload);
    } catch (e) {
      // tier yang dipilih tidak dikenali penyedia untuk carrier itu -> ulang tanpa pilihan carrier
      if (operatorId && (e.reason === 'not_found' || e.reason === 'invalid_request')) {
        data = await pay2.order({ ...payload, operator_id: '' });
      } else {
        throw e;
      }
    }
  } catch (e) {
    await refundLocal(u.id, total);
    throw mapPay2Error(e);
  }

  if (data.duplicate) {
    const pay2Id = String(data.order && data.order.id);
    const existing = await db.getOne('SELECT id FROM web_orders WHERE user_id=? AND pay2_id=?', [u.id, pay2Id]);
    await refundLocal(u.id, total);
    if (!existing) throw fail(409, 'Permintaan sama baru saja dibuat. Tunggu sebentar lalu coba lagi.', 'duplicate');
    const item = data.order;
    return {
      success: true,
      duplicate: true,
      order: {
        id: String(existing.id),
        status: String(item.status || 'submitting'),
        phoneNumber: String(item.phone_number || ''),
        serviceName: String(item.service_name || service.name),
        amount: charged,
        expires_at_ms: item.expires_at_ms ?? null,
      },
    };
  }

  const items = (data.order && Array.isArray(data.order.orders)) ? data.order.orders : (data.order ? [data.order] : []);
  const created = [];
  let refundAmount = 0;
  let firstFailure = null;
  for (const item of items) {
    if (!item || item.ok === false) {
      firstFailure = firstFailure || { error: item?.error || 'Pesanan tidak dapat dibuat.', reason: item?.reason || null };
      refundAmount += charged;
      continue;
    }
    const existing = await db.getOne('SELECT id FROM web_orders WHERE user_id=? AND pay2_id=?', [u.id, String(item.id)]);
    if (existing) {
      refundAmount += charged;
      created.push({ id: existing.id, status: item.status, phoneNumber: item.phone_number, serviceName: item.service_name, amount: charged, expires_at_ms: item.expires_at_ms ?? null });
      continue;
    }
    const id = await insertOrder(u, { countryId, serviceCode: service.code, serviceName: service.name, productId: String(tier.product_id) }, item, service.code, charged);
    created.push({ id, status: String(item.status || 'submitting'), phoneNumber: String(item.phone_number || ''), serviceName: String(item.service_name || service.name), amount: charged, expires_at_ms: item.expires_at_ms ?? null });
  }
  if (refundAmount) await refundLocal(u.id, refundAmount);
  if (!created.length) throw fail(400, firstFailure?.error || 'Pesanan tidak dapat dibuat.', firstFailure?.reason);

  const base = created.map((o) => ({ ...o, id: String(o.id) }));
  if (qty > 1) {
    return { success: true, qty, created: base.length, failed: qty - base.length, order: { qty, orders: base.map((o) => ({ ok: true, ...o })) } };
  }
  return { success: true, duplicate: false, order: base[0] };
}

async function syncRemote(row, o) {
  const updates = {};
  if (o.status && !(LOCAL_FINAL.includes(row.status) && !REMOTE_FINAL.includes(o.status))) updates.status = o.status;
  if (o.otp && o.otp !== row.otp_code) updates.otp_code = o.otp;
  if (o.otp_message && o.otp_message !== row.otp_message) updates.otp_message = o.otp_message;
  if (o.phone_number && o.phone_number !== row.phone) updates.phone = o.phone_number;
  if (o.expires_at_ms && o.expires_at_ms !== row.expires_at_ms) updates.expires_at_ms = o.expires_at_ms;

  const willBeFailed = REMOTE_FINAL.includes(updates.status || row.status);
  const needRefund = !row.refunded && row.status !== 'finished' && (o.refunded === true || willBeFailed);
  if (needRefund) {
    updates.refunded = 1;
    updates.profit = 0;
  }

  if (Object.keys(updates).length) {
    const keys = Object.keys(updates);
    const set = keys.map((k) => `${k}=?`).join(',');
    await db.query(`UPDATE web_orders SET ${set},updated_at=strftime('%s','now') WHERE id=?`,
      [...keys.map((k) => updates[k]), row.id]);
    Object.assign(row, updates);
  }
  if (needRefund) await refundLocal(row.user_id, Number(row.charged_price) || 0);
  return row;
}

function activeOrderShape(row, o, byId) {
  const expires = Number(row.expires_at_ms) || 0;
  const status = row.status;
  const otp = row.otp_code || null;
  const country = byId.get(String(row.country_id));
  return {
    id: String(row.id),
    status,
    phone_number: row.phone || '',
    otp,
    otp_message: row.otp_message || null,
    expires_at: expires ? new Date(expires).toISOString() : null,
    service_name: row.service_name || '',
    country_name: country ? country.name : '',
    sms_revision: o && Number.isFinite(o.sms_revision) ? o.sms_revision : null,
    can_finish: status === 'received' && (o ? o.can_finish !== false : true),
    can_cancel: status === 'active' && !otp && (o ? Boolean(o.can_cancel) : true),
    can_resend: status === 'active' && (o ? Boolean(o.can_resend) : true),
    can_replace: status === 'active' && !otp && (o ? Boolean(o.can_replace) : true),
    cancel_available_at: o && o.cancel_available_at ? o.cancel_available_at : null,
    resend_available_at: o && o.resend_available_at ? o.resend_available_at : null,
    amount: Number(row.charged_price) || 0,
  };
}

async function cancelLocalOrder(u, row) {
  if (LOCAL_FINAL.includes(row.status)) throw fail(409, 'Pesanan ini sudah ditutup.');
  await pay2.cancel(row.pay2_id);
  const r = await db.query(
    `UPDATE web_orders SET status='cancelled',refunded=1,profit=0,updated_at=strftime('%s','now') WHERE id=? AND refunded=0`,
    [row.id]
  );
  if (r.changes) await refundLocal(u.id, Number(row.charged_price) || 0);
  else await db.query(`UPDATE web_orders SET status='cancelled',updated_at=strftime('%s','now') WHERE id=? AND status NOT IN ('cancelled','finished')`, [row.id]);
  row.status = 'cancelled';
  row.refunded = 1;
}

async function finishLocalOrder(u, row) {
  await pay2.finish(row.pay2_id);
  await db.query(`UPDATE web_orders SET status='finished',updated_at=strftime('%s','now') WHERE id=? AND status NOT IN ('cancelled','finished')`, [row.id]);
  row.status = 'finished';
}

/* ================= halaman ================= */
app.get('/', (req, res) => res.render('pages/landing', { title: '', hideBottomNav: true }));
app.get('/login', (req, res) => res.render('pages/login', { error: LOGIN_ERRORS[req.query.err] || '', success: req.query.ok || '', hideBottomNav: true }));
app.get('/register', (req, res) => res.render('pages/register', { error: REGISTER_ERRORS[req.query.err] || '', hideBottomNav: true }));

app.post('/register', async (req, res) => {
  if (!attemptOk('register:' + req.ip, 10, 5 * 60 * 1000)) return res.redirect('/register?err=terlalu-banyak');
  const name = String(req.body.username || req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !email || !password) return res.redirect('/register?err=semua-field-wajib');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.redirect('/register?err=email-format');
  if (password.length < 6) return res.redirect('/register?err=password-pendek');
  const dupeEmail = await db.getOne('SELECT id FROM web_users WHERE email=?', [email]);
  if (dupeEmail) return res.redirect('/register?err=email-terpakai');
  const dupeName = await db.getOne('SELECT id FROM web_users WHERE LOWER(name)=?', [name.toLowerCase()]);
  if (dupeName) return res.redirect('/register?err=username-terpakai');
  try {
    const r = await db.query('INSERT INTO web_users (name,email,password) VALUES (?,?,?)', [name, email, hashPassword(password)]);
    await newSession(req);
    req.session.userId = r.lastInsertRowid;
    res.redirect('/otp');
  } catch (e) {
    if (/unique/i.test(String(e && e.message))) return res.redirect('/register?err=email-terpakai');
    throw e; // kegagalan database harus menggagalkan proses, bukan jadi pesan email terpakai
  }
});

app.post('/check-availability', async (req, res) => {
  const type = String(req.body.type || '');
  const value = String(req.body.value || '').trim();
  if (type === 'username') {
    if (!/^[a-z0-9]{4,15}$/.test(value.toLowerCase())) return res.json({ available: false, message: 'Username 4-15 karakter, huruf kecil dan angka saja, tidak valid' });
    const taken = await db.getOne('SELECT id FROM web_users WHERE LOWER(name)=?', [value.toLowerCase()]);
    return res.json(taken ? { available: false, message: 'Username sudah digunakan' } : { available: true, message: 'Username tersedia' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return res.json({ available: false, message: 'Format email tidak valid' });
  const taken = await db.getOne('SELECT id FROM web_users WHERE email=?', [value.toLowerCase()]);
  return res.json(taken ? { available: false, message: 'Email sudah terdaftar' } : { available: true, message: 'Email tersedia' });
});

/* Pembatas percobaan masuk/daftar per IP: bucket waktu di memori, tanpa
   dependensi dan tanpa trafik tambahan. Pengunjung normal tidak terpengaruh;
   brute force berhenti pada 20 percobaan / 5 menit per IP. */
const attemptBuckets = new Map();
function attemptOk(bucket, max, windowMs) {
  const now = Date.now();
  const list = (attemptBuckets.get(bucket) || []).filter((t) => now - t < windowMs);
  if (attemptBuckets.size > 5000) {
    for (const [k, v] of attemptBuckets) if (!v.length || v.every((t) => now - t >= windowMs)) attemptBuckets.delete(k);
  }
  if (list.length >= max) { attemptBuckets.set(bucket, list); return false; }
  list.push(now);
  attemptBuckets.set(bucket, list);
  return true;
}
/* Sesi baru saat login/daftar (anti session fixation): sesi lama dibuang,
   hanya userId yang dibawa ke sesi yang benar-benar baru. */
function newSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

app.post('/login', async (req, res) => {
  if (!attemptOk('login:' + req.ip, 20, 5 * 60 * 1000)) return res.redirect('/login?err=terlalu-banyak');
  const login = String(req.body.login || req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!login || !password) return res.redirect('/login?err=email-atau-password-salah');
  const user = await db.getOne('SELECT * FROM web_users WHERE email=? OR LOWER(name)=? LIMIT 1', [login, login]);
  if (!user || !verifyPassword(password, user.password)) return res.redirect('/login?err=email-atau-password-salah');
  await newSession(req);
  req.session.userId = user.id;
  res.redirect('/otp');
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

/* ================= profil ================= */
const PROFILE_ERRORS = {
  'email-format': 'Format email tidak valid.',
  'email-dipakai': 'Email sudah dipakai oleh akun lain.',
  'password-lama': 'Password lama tidak sesuai.',
  'password-pendek': 'Password baru minimal 6 karakter.',
  'password-sama': 'Konfirmasi password baru tidak sama.',
  'gagal': 'Perubahan gagal disimpan. Coba lagi.',
};
const PROFILE_SUCCES = { updated: 'Data akun berhasil diperbarui.', password: 'Password berhasil diganti.' };

app.get('/profile', requireAuth, (req, res) => res.render('pages/profile', {
  error: PROFILE_ERRORS[req.query.err] || '',
  success: PROFILE_SUCCES[req.query.ok] || '',
}));

app.post('/profile', requireAuth, async (req, res) => {
  const id = res.locals.user.id;
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.redirect('/profile?err=email-format');
  try {
    const dupe = await db.getOne('SELECT id FROM web_users WHERE email=? AND id<>?', [email, id]);
    if (dupe) return res.redirect('/profile?err=email-dipakai');
    await db.query('UPDATE web_users SET email=? WHERE id=?', [email, id]);
    return res.redirect('/profile?ok=updated');
  } catch (e) {
    if (/unique/i.test(String(e && e.message))) return res.redirect('/profile?err=email-dipakai');
    throw e;
  }
});

app.post('/profile/password', requireAuth, async (req, res) => {
  const id = res.locals.user.id;
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  const confirm = String(req.body.confirmPassword || '');
  const row = await db.getOne('SELECT password FROM web_users WHERE id=?', [id]);
  if (!row || !verifyPassword(current, row.password)) return res.redirect('/profile?err=password-lama');
  if (next.length < 6) return res.redirect('/profile?err=password-pendek');
  if (next !== confirm) return res.redirect('/profile?err=password-sama');
  await db.query('UPDATE web_users SET password=? WHERE id=?', [hashPassword(next), id]);
  return res.redirect('/profile?ok=password');
});

app.get('/otp', requireAuth, async (req, res) => {
  const u = res.locals.user;
  const defaultCountry = (await countriesPayload()).fallback;
  const otpStats = await otpStatsFor(u.id);
  const otpTrend = await otpTrendFor(u.id);
  res.render('pages/otp', { title: 'Dashboard OTP', defaultCountry, otpStats, otpTrend });
});

app.get('/otp/catalog', requireAuthJson, async (req, res) => {
  try {
    const u = res.locals.user;
    const markup = pct(u.markup_percent);
    const countryId = digits(req.query.country);
    const serviceCode = digits(req.query.platform);
    const operatorId = String(req.query.operator ?? '').trim();
    const { list, fallback } = await countriesPayload();
    const effective = countryId && list.some((c) => c.id === countryId) ? countryId : fallback;
    const services = await loadServices(effective, operatorId, markup);
    const tiles = [];
    if (serviceCode) {
      const target = services.find((s) => s.code === serviceCode);
      if (target) tiles.push(toTile(target, effective));
    } else if (countryId) {
      for (const s of services) tiles.push(toTile(s, effective));
    }
    res.json({
      success: true,
      services: services.map(({ _tiers, ...s }) => s),
      countries: list,
      tiles,
      country: countryId || '',
    });
  } catch (e) {
    sendError(res, e, 'Katalog tidak dapat dimuat.');
  }
});

app.get('/otp/tiers', requireAuthJson, async (req, res) => {
  try {
    const u = res.locals.user;
    const markup = pct(u.markup_percent);
    const countryId = digits(req.query.country);
    const serviceCode = digits(req.query.platform);
    const operatorId = String(req.query.operator ?? '').trim();
    if (!countryId || !serviceCode) return res.json({ success: true, tiers: [] });
    const services = await loadServices(countryId, operatorId, markup);
    const service = services.find((s) => s.code === serviceCode);
    const tiers = (service ? service._tiers : []).map((t) => ({
      product_id: t.product_id,
      price: userPrice(t.price, markup),
      stock: Number(t.stock) || 0,
      operator: t.operator || null,
      operator_id: t.operator_id ?? null,
    }));
    res.json({ success: true, tiers });
  } catch (e) {
    sendError(res, e, 'Daftar harga tidak dapat dimuat.');
  }
});

app.get('/otp/operators', requireAuthJson, async (req, res) => {
  const countryId = digits(req.query.country);
  const serviceCode = digits(req.query.platform);
  if (!countryId || !serviceCode) return res.json({ success: true, count: 0, operators: [] });
  try {
    const { fallback } = await countriesPayload();
    const data = await pay2.operators(countryId || fallback, serviceCode);
    const operators = (data.operators || []).filter((o) => o && o.code);
    res.json({ success: true, count: operators.length, operators });
  } catch (e) {
    sendError(res, e, 'Operator tidak dapat dimuat.');
  }
});

app.post('/otp/order', requireAuthJson, async (req, res) => {
  try {
    const payload = await placeOtpOrder(res.locals.user, req.body || {});
    res.json(payload);
  } catch (e) {
    sendError(res, e, 'Pesanan tidak dapat dibuat.');
  }
});

app.get('/otp/active', requireAuthJson, async (req, res) => {
  try {
    const u = res.locals.user;
    const rows = await db.getAll(
      `SELECT * FROM web_orders WHERE user_id=? AND status IN ('submitting','active','received') ORDER BY id DESC LIMIT ${ACTIVE_LIMIT}`,
      [u.id]
    );
    const { byId } = await countriesPayload();
    if (!rows.length) return res.json({ success: true, count: 0, orders: [], balance: Number(u.balance) || 0 });

    let remote = new Map();
    const list = await pay2.ordersList(100);
    remote = new Map((list.orders || []).map((o) => [String(o.id), o]));

    let budget = REFRESH_BUDGET;
    const orders = [];
    for (const row of rows) {
      let o = row.pay2_id ? remote.get(String(row.pay2_id)) : null;
      if (row.status === 'active' && !row.otp_code && row.pay2_id && budget > 0) {
        budget -= 1;
        const data = await pay2.orderStatus(row.pay2_id);
        if (data.order) o = data.order;
      }
      if (o) await syncRemote(row, o);
      if (ACTIVE_STATUSES.includes(row.status)) orders.push(activeOrderShape(row, o, byId));
    }
    res.json({ success: true, count: orders.length, orders, balance: Number(u.balance) || 0 });
  } catch (e) {
    sendError(res, e, 'Pesanan aktif tidak dapat dimuat.');
  }
});

async function loadOwnOrder(req, res) {
  const u = res.locals.user;
  const row = await db.getOne('SELECT * FROM web_orders WHERE id=? AND user_id=?', [req.params.id, u.id]);
  if (!row) throw fail(404, 'Pesanan tidak ditemukan.');
  return { u, row };
}

app.post('/otp/orders/:id/:action', requireAuthJson, async (req, res) => {
  try {
    const { u, row } = await loadOwnOrder(req, res);
    if (!row.pay2_id) throw fail(404, 'Pesanan tidak ditemukan.');
    const action = String(req.params.action);
    if (action === 'cancel') {
      await cancelLocalOrder(u, row);
      return res.json({ success: true });
    }
    if (action === 'finish') {
      await finishLocalOrder(u, row);
      return res.json({ success: true });
    }
    if (action === 'resend') {
      const data = await pay2.resend(row.pay2_id);
      return res.json({ success: true, resent: data.resent !== false });
    }
    if (action === 'replace') {
      await cancelLocalOrder(u, row);
      const created = await placeOtpOrder(u, { country_id: row.country_id, service_code: row.service_code, product_id: row.product_id, qty: 1 });
      return res.json({ success: true, order: created.order });
    }
    throw fail(404, 'Aksi tidak dikenal.');
  } catch (e) {
    sendError(res, e, 'Permintaan gagal.');
  }
});

/* ================= riwayat ================= */
const HISTORY_FILTER = {
  all: '',
  active: " AND status IN ('submitting','active')",
  completed: " AND status IN ('received','finished')",
  canceled: " AND status IN ('cancelled','expired','failed')",
};

function historyRow(r, byId) {
  const country = byId.get(String(r.country_id));
  return {
    _id: String(r.id),
    status: r.status,
    serviceName: r.service_name || '',
    countryName: country ? country.name : String(r.country_id || ''),
    phoneNumber: r.phone || '',
    otp: r.otp_code || null,
    otpMessage: r.otp_message || null,
    amount: Number(r.charged_price) || 0,
    refunded: Boolean(r.refunded),
    finishedAt: r.status === 'finished' ? new Date((r.updated_at || 0) * 1000) : null,
    createdAt: new Date((r.created_at || 0) * 1000),
    expiresAtMs: Number(r.expires_at_ms) || 0,
  };
}

app.get('/otp/orders', requireAuth, async (req, res) => {
  const u = res.locals.user;
  const tab = ['all', 'active', 'completed', 'canceled'].includes(req.query.tab) ? req.query.tab : 'all';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const tabs = {};
  for (const key of Object.keys(HISTORY_FILTER)) {
    const row = await db.getOne(`SELECT COUNT(*) AS n FROM web_orders WHERE user_id=?${HISTORY_FILTER[key]}`, [u.id]);
    tabs[key] = Number(row && row.n) || 0;
  }
  const totalPages = Math.max(1, Math.ceil((tabs[tab] || 0) / HISTORY_PAGE));
  const offset = (Math.min(page, totalPages) - 1) * HISTORY_PAGE;
  const rows = await db.getAll(
    `SELECT * FROM web_orders WHERE user_id=?${HISTORY_FILTER[tab]} ORDER BY id DESC LIMIT ${HISTORY_PAGE} OFFSET ${offset}`,
    [u.id]
  );
  const { byId } = await countriesPayload();
  res.render('pages/otp_orders', {
    title: 'Riwayat OTP',
    error: req.query.err === 'gagal' ? 'Permintaan gagal diproses. Muat ulang halaman lalu coba lagi.' : '',
    orders: rows.map((r) => historyRow(r, byId)),
    tabs,
    tab,
    page: Math.min(page, totalPages),
    totalPages,
    otpDeadline: (o) => o.expiresAtMs || null,
  });
});

app.get('/otp/orders/:id/status', requireAuth, async (req, res) => {
  try {
    const { row } = await loadOwnOrder(req, res);
    let payload = { status: row.status, otp: row.otp_code || '' };
    if (ACTIVE_STATUSES.includes(row.status) && row.pay2_id) {
      const data = await pay2.orderStatus(row.pay2_id, true);
      if (data.order) {
        await syncRemote(row, data.order);
        payload = { status: row.status, otp: row.otp_code || '' };
      }
    }
    res.json({ success: true, order: payload });
  } catch (e) {
    sendError(res, e, 'Status OTP gagal diperiksa.');
  }
});

app.post('/otp/orders/:id/finish', requireAuth, async (req, res) => {
  try {
    const { u, row } = await loadOwnOrder(req, res);
    await finishLocalOrder(u, row);
    res.json({ success: true });
  } catch (e) {
    sendError(res, e, 'Pesanan tidak dapat ditandai selesai.');
  }
});

app.post('/otp/orders/:id/cancel', requireAuth, async (req, res) => {
  const json = req.get('Accept')?.includes('application/json');
  try {
    const { u, row } = await loadOwnOrder(req, res);
    await cancelLocalOrder(u, row);
    if (json) return res.json({ success: true });
    return res.redirect('/otp/orders');
  } catch (e) {
    if (json) return sendError(res, e, 'Pembatalan gagal.');
    return res.redirect('/otp/orders?err=gagal');
  }
});

/* ================= deposit ================= */
function depositView(r) {
  return {
    _id: r.reference,
    type: 'deposit',
    amount: Number(r.amount) || 0,
    fee: Number(r.fee) || 0,
    total: Number(r.total) || 0,
    method: 'qris',
    status: r.status,
    qris_image: absUrl(r.qris_image),
    createdAt: new Date((r.created_at || 0) * 1000),
    expiredAt: r.expired_at ? new Date(r.expired_at * 1000) : null,
    completedAt: r.paid_at ? new Date(r.paid_at * 1000) : null,
  };
}

app.get('/deposit', requireAuth, async (req, res) => {
  const u = res.locals.user;
  const rows = await db.getAll('SELECT * FROM web_deposits WHERE user_id=? ORDER BY id DESC LIMIT 50', [u.id]);
  res.render('pages/deposit', {
    title: 'Isi Saldo',
    invoices: rows.map(depositView),
    minDeposit: MIN_DEPOSIT,
    error: req.query.err ? 'Nominal isi saldo tidak valid.' : '',
  });
});

app.post('/invoice/create', requireAuthJson, async (req, res) => {
  try {
    const u = res.locals.user;
    const amount = Math.floor(Number(String(req.body.amount ?? '').replace(/[^0-9]/g, '')));
    if (!amount || amount < MIN_DEPOSIT) throw fail(400, `Nominal minimal ${rp(MIN_DEPOSIT)}.`);
    const inv = await pay2.invoiceCreate(amount);
    const reference = String(inv.invoice_id || inv.reference || '');
    if (!reference) throw fail(502, 'Invoice tidak dapat dibuat saat ini.');
    await db.query(
      `INSERT INTO web_deposits (user_id,reference,amount,fee,total,qris_image,created_at,expired_at) VALUES (?,?,?,?,?,?,?,?)`,
      [
        u.id,
        reference,
        Number(inv.amount) || amount,
        Number(inv.fee) || 0,
        Number(inv.total) || amount,
        String(inv.qris_image || ''),
        Math.floor(Date.now() / 1000),
        inv.expired_at ? Math.floor(new Date(inv.expired_at).getTime() / 1000) : null,
      ]
    );
    res.json({
      reference,
      amount: Number(inv.amount) || amount,
      fee: Number(inv.fee) || 0,
      total: Number(inv.total) || amount,
      method: 'qris',
      qris_image: absUrl(inv.qris_image),
      createdAt: new Date().toISOString(),
      expiredAt: inv.expired_at || null,
      status: 'pending',
    });
  } catch (e) {
    sendError(res, e, 'Invoice tidak dapat dibuat.');
  }
});

app.get('/api/invoice/:id', requireAuthJson, async (req, res) => {
  try {
    const u = res.locals.user;
    const row = await db.getOne('SELECT * FROM web_deposits WHERE reference=? AND user_id=?', [String(req.params.id), u.id]);
    if (!row) throw fail(404, 'Invoice tidak ditemukan.');
    let status = row.status;
    if (status === 'pending') {
      const data = await pay2.invoiceStatus(row.reference);
      status = String(data.status || 'pending');
      if (status === 'paid' || status === 'success') {
        const r = await db.query(`UPDATE web_deposits SET status='paid',paid_at=strftime('%s','now') WHERE id=? AND status='pending'`, [row.id]);
        if (r.changes) await refundLocal(u.id, Number(row.amount) || 0);
        status = 'paid';
      } else if (status !== 'pending') {
        await db.query(`UPDATE web_deposits SET status=? WHERE id=? AND status='pending'`, [status, row.id]);
      }
    }
    res.json({ ...depositView(row), reference: row.reference, status });
  } catch (e) {
    sendError(res, e, 'Invoice tidak dapat diperiksa.');
  }
});

/* ================= admin ================= */
const ADMIN_ERRORS = {
  'user-tidak-ada': 'User tidak ditemukan.',
  'nama-salah': 'Nama 3-20 karakter (huruf, angka, spasi, titik, atau strip).',
  'email-format': 'Format email tidak valid.',
  'email-dipakai': 'Email sudah dipakai oleh user lain.',
  'saldo-salah': 'Nominal saldo tidak valid.',
  'tidak-bisa-hapus': 'Tidak bisa menghapus akun sendiri.',
};
const ADMIN_SUCCES = { user: 'Perubahan user berhasil disimpan.', hapus: 'User beserta pesanan & depositnya dihapus.' };

app.get('/admin', requireAuth, requireAdmin, async (req, res) => {
  const users = await db.getAll('SELECT id,name,email,balance,role,markup_percent,created_at FROM web_users ORDER BY id LIMIT 200');
  const orders = await db.getAll('SELECT * FROM web_orders ORDER BY id DESC LIMIT 50');
  const setting = await db.getOne("SELECT value FROM web_settings WHERE key='default_markup_percent'");
  // Ringkasan keuntungan: profit = harga jual - harga modal pay2 (pesanan yang tidak di-refund).
  const stat = await db.getOne(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(charged_price),0) AS revenue,
      COALESCE(SUM(cost_price),0) AS cost,
      COALESCE(SUM(CASE WHEN refunded=0 THEN profit ELSE 0 END),0) AS profit,
      COALESCE(SUM(CASE WHEN refunded=1 THEN charged_price ELSE 0 END),0) AS refunded
    FROM web_orders`);
  const statMonth = await db.getOne(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN refunded=0 THEN profit ELSE 0 END),0) AS profit
    FROM web_orders WHERE created_at >= strftime('%s','now','start of month')`);
  const statusStat = await db.getAll(`SELECT status, COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN refunded=0 THEN profit ELSE 0 END),0) AS profit
    FROM web_orders GROUP BY status ORDER BY n DESC`);
  const balanceStat = await db.getOne(`SELECT COALESCE(SUM(balance),0) AS total, COUNT(*) AS n FROM web_users`);
  res.render('pages/admin', {
    title: 'Admin',
    users,
    orders,
    stat,
    statMonth,
    statusStat,
    balanceStat,
    markup: setting ? setting.value : '30',
    error: ADMIN_ERRORS[req.query.err] || '',
    success: ADMIN_SUCCES[req.query.ok] || '',
    editId: Number(req.query.edit) || 0,
  });
});
app.post('/admin/markup', requireAuth, requireAdmin, async (req, res) => {
  // Angka saja dan dijepit 0-1000: nilai liar dari form tidak boleh masuk ke DB.
  const v = String(Math.min(1000, Math.max(0, Number(req.body.markup) || 0)));
  await db.query(`INSERT INTO web_settings (key,value) VALUES ('default_markup_percent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [v]);
  await db.query('UPDATE web_users SET markup_percent=?', [Number(v) || 0]);
  res.redirect('/admin');
});
app.post('/admin/users/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const back = (q) => res.redirect('/admin?edit=' + id + (q ? '&' + q : ''));
  const target = await db.getOne('SELECT * FROM web_users WHERE id=?', [id]);
  if (!target) return res.redirect('/admin?err=user-tidak-ada');

  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[a-z0-9 ._-]{3,20}$/i.test(name)) return back('err=nama-salah');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return back('err=email-format');
  const dupe = await db.getOne('SELECT id FROM web_users WHERE email=? AND id<>?', [email, id]);
  if (dupe) return back('err=email-dipakai');

  let role = String(req.body.role || target.role);
  if (role !== 'user' && role !== 'admin') role = target.role;
  if (id === res.locals.user.id) role = target.role; // tidak bisa menurunkan role sendiri
  const markup = Number(req.body.markup_percent);
  const markupVal = Number.isFinite(markup) && markup >= 0 ? markup : Number(target.markup_percent) || 0;

  const op = String(req.body.balance_op || '');
  const rawAmt = String(req.body.balance_amount == null ? '' : req.body.balance_amount).trim();
  let amount = null;
  if (rawAmt !== '') { // kosong = tidak menyentuh saldo
    amount = Number(rawAmt.replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(amount)) return back('err=saldo-salah');
    if ((op === 'add' || op === 'sub') && amount <= 0) return back('err=saldo-salah');
    if (op === 'set' && amount < 0) return back('err=saldo-salah');
  }

  try {
    await db.query('UPDATE web_users SET name=?,email=?,role=?,markup_percent=? WHERE id=?',
      [name, email, role, markupVal, id]);
    if (amount !== null && op === 'add') await db.query('UPDATE web_users SET balance=balance+? WHERE id=?', [amount, id]);
    else if (amount !== null && op === 'sub') await db.query('UPDATE web_users SET balance=MAX(0,balance-?) WHERE id=?', [amount, id]);
    else if (amount !== null && op === 'set') await db.query('UPDATE web_users SET balance=? WHERE id=?', [amount, id]);
    return res.redirect('/admin?edit=' + id + '&ok=user');
  } catch (e) {
    if (/unique/i.test(String(e && e.message))) return back('err=email-dipakai');
    throw e;
  }
});

app.post('/admin/users/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id || id === res.locals.user.id) return res.redirect('/admin?err=tidak-bisa-hapus');
  const target = await db.getOne('SELECT id FROM web_users WHERE id=?', [id]);
  if (!target) return res.redirect('/admin?err=user-tidak-ada');
  await db.query('DELETE FROM web_orders WHERE user_id=?', [id]);
  await db.query('DELETE FROM web_deposits WHERE user_id=?', [id]);
  await db.query('DELETE FROM web_users WHERE id=?', [id]);
  res.redirect('/admin?ok=hapus');
});

app.post('/admin/balance', requireAuth, requireAdmin, async (req, res) => {
  const uid = Number(req.body.user_id);
  const amt = Number(req.body.amount || 0);
  if (uid && amt) await db.query('UPDATE web_users SET balance=balance+? WHERE id=?', [amt, uid]);
  res.redirect('/admin');
});

app.use((req, res) => res.status(404).render('pages/landing', { title: 'Tidak ditemukan', hideBottomNav: true }));

/* Error middleware global: kegagalan apa pun, termasuk koneksi database,
   berakhir di sini dengan status jujur, bukan halaman yang seolah sukses. */
app.use((err, req, res, next) => {
  const status = Number(err.status) || (err.reason === 'db_down' ? 503 : 500);
  console.error(`[error] ${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${status} ${err.message}`);
  if (res.headersSent) return next(err);
  const wantsJson = (req.get('Accept') || '').includes('json') || req.path.startsWith('/api/');
  if (wantsJson) {
    return res.status(status).json({ error: err.message || 'Permintaan gagal.', ...(err.reason ? { reason: err.reason } : {}) });
  }
  res.status(status).type('html').send(downPage(status));
});

const ready = (async () => {
  try {
    await ensureBooted();
  } catch (e) {
    if (db.isDown() || e.reason === 'db_down') {
      // Koneksi ke API DongtubeDB gagal: tetap jalankan proses dalam mode
      // perawatan. Gate di awal menolak semua permintaan dan mengulang boot
      // sampai ada percobaan koneksi yang berhasil.
      console.error(`[db] mode perawatan aktif: koneksi DongtubeDB gagal (${e && e.message}). Semua permintaan ditolak sampai pulih.`);
      if (require.main === module) {
        app.listen(PORT, () => console.log(`Dongtube Web mode perawatan di http://localhost:${PORT}`));
      }
      return;
    }
    // Gagal bukan karena koneksi (SQL salah / konfigurasi): hentikan di VPS,
    // lempar ke penangkap ready di serverless. Tanpa fallback.
    console.error(`[db] boot gagal: ${e && e.message}`);
    if (require.main === module) process.exit(1);
    throw e;
  }
  // Mode serverless (Vercel) tidak boleh listen: server.js diekspor berbentuk
  // function dan Vercel memanggilnya langsung; gerbang di awal menunggu boot.
  // node server.js di VPS tetap seperti biasa.
  if (require.main === module) {
    app.listen(PORT, () => console.log(`Dongtube Web running on http://localhost:${PORT}`));
  }
})();
// Pasang penangkap kosong: request pertama bisa meng-await ready setelah
// rejection terjadi; tanpa ini Node menganggapnya unhandled rejection.
ready.catch(() => {});
// Vercel memuat server.js sebagai entry backend framework dan mensyaratkan
// export berupa function atau server; Express app sendiri memang function.
// Properti app dan ready disediakan untuk harness pengujian.
module.exports = app;
module.exports.app = app;
module.exports.ready = ready;
