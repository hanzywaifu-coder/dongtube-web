const fetch = global.fetch;

/* Base URL Dongtube Payment dikodekan langsung, bukan lewat .env: satu nilai
   ini menentukan origin katalog, invoice, QRIS, dan seluruh akses DongtubeDB. */
const ORIGIN_URL = 'https://payment.dongtube.cyou';
const BASE_URL = `${ORIGIN_URL}/api/v1`;
const BASE = () => BASE_URL;
const ORIGIN = () => ORIGIN_URL;
const KEY = () => String(process.env.PAY2_API_KEY || '').trim();

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { exp: Date.now() + ttlMs, val });
  if (cache.size > 400) for (const [k, v] of cache) if (v.exp <= Date.now()) cache.delete(k);
  return val;
}
function dropCache(prefix) { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); }

/* Batas waktu per panggilan API pay2. Tanpa batas, satu fetch yang menggantung
   membuat permintaan tidak pernah selesai dan fungsi Vercel dibunuh sebelum
   sempat membalas (FUNCTION_INVOCATION_FAILED).8 detik aman di bawah batas
   durasi fungsi, dan kegagalannya berakhir sebagai error jujur di error
   middleware, bukan proses mati. */
const TIMEOUT_MS = 8000;

async function j(url, init) {
  let r;
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // Provider tidak terjangkau: buang seluruh cache supaya tidak ada data
    // basi yang disajikan, lalu lempar sebagai kegagalan keras (tanpa fallback).
    cache.clear();
    e.status = 503;
    e.reason = 'db_down';
    throw e;
  }
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = null; }
  if (!r.ok) {
    cache.clear();
    const err = new Error((d && (d.error || d.message)) || `HTTP ${r.status}`);
    err.status = r.status;
    err.reason = (d && d.reason) || (r.status >= 500 ? 'db_down' : null);
    throw err;
  }
  if (!d || typeof d !== 'object') {
    // Status sukses tetapi isi tidak valid dianggap kegagalan, bukan data kosong.
    cache.clear();
    const err = new Error('Respons provider bukan JSON valid.');
    err.status = 502;
    err.reason = 'db_down';
    throw err;
  }
  return d;
}
const otpGet = (path) => j(`${ORIGIN()}/api/otp${path}`, { headers: { 'X-API-Key': KEY() } });
const otpPost = (path, body) => j(`${ORIGIN()}/api/otp${path}`, {
  method: 'POST',
  headers: { 'X-API-Key': KEY(), 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});
const v1Get = (path) => j(`${BASE()}${path}`, { headers: { 'X-API-Key': KEY() } });

const refreshedAt = new Map();
const pay2 = {
  base: BASE,
  origin: ORIGIN,
  key: KEY,
  dropCache,

  countries: () => cached('countries', 120000, () => otpGet('/countries')),
  services: (countryId) => cached(`services:${countryId}`, 60000, () => otpGet(`/services?country_id=${encodeURIComponent(countryId || '')}`)),
  operators: (countryId, platformId) => cached(`operators:${countryId}:${platformId}`, 30000,
    () => otpGet(`/operators?country_id=${encodeURIComponent(countryId)}&platform_id=${encodeURIComponent(platformId)}`)),

  order: (payload) => otpPost('/order', payload),
  ordersList: (limit) => cached(`orders:${limit || 100}`, 4000, () => otpGet(`/orders?limit=${Math.min(100, limit || 100)}`)),
  orderStatus: async (id, force) => {
    const last = refreshedAt.get(id) || 0;
    if (!force && Date.now() - last < 10000) return cached(`order:${id}`, 9000, () => otpGet(`/orders/${encodeURIComponent(id)}`));
    refreshedAt.set(id, Date.now());
    const data = await otpGet(`/orders/${encodeURIComponent(id)}`);
    cache.set(`order:${id}`, { exp: Date.now() + 9000, val: data });
    return data;
  },
  cancel: (id) => otpPost(`/orders/${encodeURIComponent(id)}/cancel`),
  finish: (id) => otpPost(`/orders/${encodeURIComponent(id)}/finish`),
  resend: (id) => otpPost(`/orders/${encodeURIComponent(id)}/resend`),

  invoiceCreate: (amount) => v1Get(`/invoice?amount=${encodeURIComponent(amount)}`),
  invoiceStatus: (id) => v1Get(`/invoice/status?id=${encodeURIComponent(id)}`),
};

module.exports = pay2;
