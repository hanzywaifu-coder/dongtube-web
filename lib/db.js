/* Satu-satunya jalur data dongtube-web: API DongtubeDB di pay2 (HTTP, header
   X-API-Key). Tidak ada database lokal, tidak ada driver lain, tidak ada
   fallback; seluruh data hanya ada di belakang API ini, sama di VPS dan Vercel.

   Klasifikasi respon API:
   - 200 success:true  → sukses; koneksi ditandai sehat.
   - 400 success:false → query ditolak API (SQL salah atau diblokir): server
     menjawab, jadi koneksi sehat; error diteruskan apa adanya sebagai
     kegagalan aplikasi (bukan mode perawatan).
   - Selainnya (jaringan, timeout, 401, 403, 429, 5xx) → koneksi gagal:
     ditandai down, permintaan berikutnya ditolak semua (503 perawatan) sampai
     ada percobaan koneksi yang berhasil. */
const fetch = global.fetch;
const pay2 = require('./pay2');

/* Timeout per panggilan: API biasanya balas di bawah setengah detik.5 detik
   sudah longgar sekaligus membatasi rugi per percobaan boot di serverless:
   satu panggilan yang menggantung paling lama memakan 2 kali percobaan (10
   detik), jauh di bawah batas durasi fungsi Vercel. */
const TIMEOUT_MS = 5000;

let down = false;
const isDown = () => down;

function markDown(reason) {
  if (down) return;
  down = true;
  console.error(`[db] koneksi DongtubeDB gagal, semua proses berhenti sampai pulih: ${reason}`);
}

async function query(sql, params = [], opts = {}) {
  const key = pay2.key();
  if (!key) throw new Error('PAY2_API_KEY kosong; akses database DongtubeDB ditolak.');
  let body;
  try {
    body = JSON.stringify({ sql, params });
  } catch (e) {
    // Parameter tidak bisa diserialisasi: kesalahan pemakaian, bukan koneksi.
    throw new Error(`Parameter query tidak dapat dikirim: ${e && e.message}`);
  }
  let r;
  const kirim = () => fetch(`${pay2.origin()}/db/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': key },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  try {
    try {
      r = await kirim();
    } catch (e) {
      // Kegagalan transport (timeout atau jaringan putus di tengah jalan):
      // ulangi sekali tanpa jeda. Dari Vercel kadang ada gangguan sesaat yang
      // membuat fetch menggantung sampai timeout, dan satu gangguan begitu
      // tidak boleh langsung mematikan boot. Respon HTTP tidak pernah masuk
      // cabang ini, jadi kegagalan dari server tidak pernah diulang diam-diam.
      r = await kirim();
    }
  } catch (e) {
    // opts.expectFail: untuk statement yang memang boleh gagal (migrasi skema
    // legacy); kegagalan itu tidak dihitung sebagai koneksi mati, error tetap
    // dilempar utuh dengan reason db_down untuk penentuan mode perawatan.
    if (!opts.expectFail) markDown(e && e.message);
    const err = new Error(`DongtubeDB tidak terjangkau: ${e && e.message}`);
    err.status = 503;
    err.reason = 'db_down';
    throw err;
  }
  const text = await r.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch { d = null; }

  if (r.status === 200 && d && d.success === true) {
    down = false;
    if (Array.isArray(d.rows)) return { rows: d.rows, count: Number(d.count ?? d.rows.length) };
    return { changes: Number(d.changes || 0), lastInsertRowid: Number(d.lastInsertRowid || 0) };
  }
  const msg = (d && (d.error || d.message)) || `HTTP ${r.status}`;
  if (r.status === 400) throw new Error(msg);
  if (!opts.expectFail) markDown(`HTTP ${r.status}: ${msg}`);
  const err = new Error(`DongtubeDB: ${msg}`);
  err.status = 503;
  err.reason = 'db_down';
  throw err;
}

async function ensureTables() {
  await query(`CREATE TABLE IF NOT EXISTS web_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    markup_percent REAL NOT NULL DEFAULT 30,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`);
  await query(`CREATE TABLE IF NOT EXISTS web_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    pay2_id TEXT,
    country_id TEXT,
    service_name TEXT,
    service_code TEXT,
    product_id TEXT,
    phone TEXT,
    otp_code TEXT,
    otp_message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    cost_price REAL NOT NULL,
    charged_price REAL NOT NULL,
    profit REAL NOT NULL DEFAULT 0,
    refunded INTEGER NOT NULL DEFAULT 0,
    expires_at_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`);
  await query(`CREATE TABLE IF NOT EXISTS web_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL,
    fee INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    qris_image TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    expired_at INTEGER,
    paid_at INTEGER
  )`);
  await query(`CREATE TABLE IF NOT EXISTS web_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS web_sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires INTEGER NOT NULL
  )`);
  for (const col of ['service_code TEXT', 'otp_message TEXT', 'refunded INTEGER NOT NULL DEFAULT 0', 'expires_at_ms INTEGER']) {
    // expectFail: duplikat kolom adalah hasil normal pada skema lama yang sudah
    // terlanjur ada, jadi kegagalan itu tidak boleh dihitung koneksi mati.
    try { await query(`ALTER TABLE web_orders ADD COLUMN ${col}`, [], { expectFail: true }); }
    catch (e) {
      // Hanya "kolom sudah ada" yang boleh diabaikan; kegagalan lain harus
      // tetap melempar supaya aplikasi berhenti, bukan jalan tanpa skema.
      if (!/duplicate column/i.test(String(e && e.message))) throw e;
    }
  }
  // Indeks untuk kueri per-pengguna (lencana bottom bar, riwayat, dashboard):
  // dibuat sekali dan membuat COUNT/daftar per user konstan walau tabel besar.
  await query('CREATE INDEX IF NOT EXISTS idx_orders_user ON web_orders(user_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_deposits_user ON web_deposits(user_id)');
}

async function getOne(sql, params = []) {
  const r = await query(sql, params);
  if (!Array.isArray(r.rows)) throw new Error('Respons SELECT tidak berbentuk rows array.');
  return r.rows[0] || null;
}
async function getAll(sql, params = []) {
  const r = await query(sql, params);
  if (!Array.isArray(r.rows)) throw new Error('Respons SELECT tidak berbentuk rows array.');
  return r.rows;
}

module.exports = { ensureTables, query, getOne, getAll, isDown };
