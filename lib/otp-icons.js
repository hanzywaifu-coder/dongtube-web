'use strict';
const fs = require('fs');
const path = require('path');

const ICONS = require('./otp-icons-map').OTP_SERVICE_ICONS;
const DIR = path.join(__dirname, '..', 'public', 'img', 'otp-services');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

let files = null;
let lookup = null;

function build() {
  // Ikon bersifat dekoratif: bila direktori hilang, katalog tetap jalan tanpa ikon.
  if (!fs.existsSync(DIR)) { files = new Set(); lookup = new Map(); return; }
  files = new Set(fs.readdirSync(DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)));
  lookup = new Map();
  for (const [key, value] of Object.entries(ICONS)) {
    const file = String(value).split('/').pop().replace(/\.svg$/, '');
    if (!files.has(file)) continue;
    const parts = String(key).split('-');
    for (const variant of [key, parts[0], parts.join('')]) {
      const k = norm(variant);
      if (k && !lookup.has(k)) lookup.set(k, file);
    }
    const n = norm(key);
    if (n && !lookup.has(n)) lookup.set(n, file);
  }
}

function iconUrl(serviceName) {
  if (!files) build();
  const n = norm(serviceName);
  if (!n) return null;
  if (lookup.has(n)) return `/img/otp-services/${lookup.get(n)}.svg`;
  const first = norm(String(serviceName || '').split(/\s+/)[0]);
  if (lookup.has(first)) return `/img/otp-services/${lookup.get(first)}.svg`;
  if (n.length >= 4) {
    for (const [k, file] of lookup) {
      if (k.startsWith(n) || (n.startsWith(k) && k.length >= 4)) return `/img/otp-services/${file}.svg`;
    }
  }
  return null;
}

module.exports = { iconUrl };
