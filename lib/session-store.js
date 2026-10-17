/* Store sesi express-session yang disimpan di database (tabel web_sessions).

   Dipakai bila SESSION_STORE=db, wajib di Vercel: setiap request bisa mendarat
   di instance serverless yang berbeda sehingga memori tidak bisa dipakai.
   Di VPS cukup MemoryStore bawaan (env SESSION_STORE tidak diatur). */
const { Store } = require('express-session');
const db = require('./db');

function expiryOf(sess) {
  const raw = sess && sess.cookie && sess.cookie.expires;
  const t = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(t) ? t : Date.now() + 7 * 24 * 60 * 60 * 1000;
}

class DbSessionStore extends Store {
  get(sid, cb) {
    db.getOne('SELECT data, expires FROM web_sessions WHERE sid=? AND expires>?', [sid, Date.now()])
      .then((row) => {
        if (!row) return cb(null, null);
        try { cb(null, JSON.parse(row.data)); }
        catch (e) { cb(e); }
      })
      .catch(cb);
  }

  set(sid, sess, cb) {
    let data;
    try { data = JSON.stringify(sess); }
    catch (e) { return cb(e); }
    db.query(
      'INSERT INTO web_sessions (sid,data,expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires=excluded.expires',
      [sid, data, expiryOf(sess)]
    ).then(() => cb(null)).catch(cb);
  }

  destroy(sid, cb) {
    db.query('DELETE FROM web_sessions WHERE sid=?', [sid]).then(() => cb(null)).catch(cb);
  }

  touch(sid, sess, cb) {
    db.query('UPDATE web_sessions SET expires=? WHERE sid=?', [expiryOf(sess), sid])
      .then(() => cb(null)).catch(cb);
  }
}

module.exports = DbSessionStore;
