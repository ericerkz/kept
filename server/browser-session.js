const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const session = require('express-session');
const { csrfSync } = require('csrf-sync');

// Browser credentials stay in an HttpOnly cookie. The existing sessions table
// remains the source of truth for expiry, logout, password resets and disabling
// accounts; native/API clients continue to use their existing bearer tokens.
function createBrowserSessions({ dataDir, run, get, resolveSessionFromToken, createSession, publicUser, ttlMs }) {
  const name = 'kept.browser';
  const secretPath = path.join(dataDir, 'browser-session-secret');
  try { fs.writeFileSync(secretPath, crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }

  class SqliteStore extends session.Store {
    get(sid, callback) {
      get('SELECT data FROM browser_sessions WHERE sid = ? AND expiresAt > ?', [sid, Date.now()])
        .then(row => row ? JSON.parse(row.data) : null).then(value => callback(null, value), callback);
    }
    set(sid, value, callback) {
      const expiresAt = new Date(value.cookie.expires).getTime();
      run('INSERT OR REPLACE INTO browser_sessions (sid, data, expiresAt) VALUES (?, ?, ?)',
        [sid, JSON.stringify(value), expiresAt]).then(() => callback?.(), callback);
    }
    destroy(sid, callback) {
      run('DELETE FROM browser_sessions WHERE sid = ?', [sid]).then(() => callback?.(), callback);
    }
  }
  const middleware = session({
    name, secret: fs.readFileSync(secretPath, 'utf8'), store: new SqliteStore(),
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: 'auto', sameSite: 'lax', path: '/', maxAge: ttlMs }
  });
  const { generateToken, csrfSynchronisedProtection: protect } = csrfSync();
  const save = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
  async function finishLogin(req, res, user, { retireToken } = {}) {
    const previousToken = req.session.token;
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    const result = await createSession(user);
    req.session.token = result.token;
    const csrfToken = generateToken(req);
    await save(req);
    for (const token of new Set([previousToken, retireToken].filter(Boolean))) {
      await run('DELETE FROM sessions WHERE token = ?', [token]);
    }
    res.json({ user: result.user, csrfToken });
  }
  return {
    middleware, protect, finishLogin,
    async init() {
      await run('CREATE TABLE IF NOT EXISTS browser_sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expiresAt INTEGER NOT NULL)');
      await run('DELETE FROM browser_sessions WHERE expiresAt <= ?', [Date.now()]);
    },
    async status(req, res) {
      const user = await resolveSessionFromToken(req.session.token);
      res.json({ authenticated: !!user, user: user ? publicUser(user) : null, csrfToken: generateToken(req) });
    },
    async logout(req, res) {
      if (!req.browserAuth) return;
      await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
      res.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure });
    },
    async realtimeToken(req) {
      // Cookie-authenticated WebSockets need an origin check: they cannot send
      // the CSRF header used by HTTP requests. Never trust native-shell origins
      // implicitly here; native shells already have bearer authentication.
      const allowed = new Set(String(process.env.KEPT_CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
      const protocol = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
      allowed.add(process.env.BASE_URL ? new URL(process.env.BASE_URL).origin : `${protocol}://${req.headers.host}`);
      if (!allowed.has(req.headers.origin)) return '';
      await new Promise((resolve, reject) => middleware(req, new http.ServerResponse(req), error => error ? reject(error) : resolve()));
      return req.session?.token || '';
    }
  };
}

module.exports = { createBrowserSessions };
