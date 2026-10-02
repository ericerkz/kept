const crypto = require('crypto');
const express = require('express');

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const PENDING_TTL_SECONDS = 10 * 60;
const SUPPORTED_SCOPES = ['kept.read', 'kept.write'];
const MCP_INTERNAL_HEADER = 'x-kept-mcp-internal';
const MCP_INTERNAL_SECRET = crypto.randomBytes(32).toString('base64url');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomToken(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

function addSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function baseUrlFor(req) {
  return String(process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function oauthError(res, status, error, description) {
  return res.status(status).json({ error, error_description: description });
}

function parseScopes(value) {
  return [...new Set(String(value || '').split(/\s+/).filter(Boolean))];
}

function validScopes(value) {
  const scopes = parseScopes(value);
  return scopes.length > 0 && scopes.every(scope => SUPPORTED_SCOPES.includes(scope));
}

function validRedirectUri(value) {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol)
      && !['data:', 'file:', 'javascript:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function appendRedirect(urlValue, values) {
  const url = new URL(urlValue);
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function htmlPage(title, body, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - Kept</title><style>
  :root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f8;color:#202124}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.panel{width:min(520px,100%);background:#fff;border:1px solid #dadce0;border-radius:8px;padding:28px;box-shadow:0 8px 28px #0002}.brand{font-size:18px;font-weight:700;color:#f9ab00;margin-bottom:24px}h1{font-size:25px;margin:0 0 12px}p{line-height:1.5;color:#5f6368}.scopes{padding:0;list-style:none;margin:20px 0}.scopes li{padding:10px 0;border-top:1px solid #eee}.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:24px}button,a.button{appearance:none;border:1px solid #dadce0;border-radius:5px;padding:10px 16px;background:#fff;color:#202124;font:inherit;text-decoration:none;cursor:pointer}.primary{background:#1a73e8!important;border-color:#1a73e8!important;color:#fff!important}.error{color:#b3261e}@media(prefers-color-scheme:dark){:root{background:#202124;color:#e8eaed}.panel{background:#292a2d;border-color:#5f6368}p{color:#bdc1c6}.scopes li{border-color:#3c4043}button,a.button{background:#292a2d;color:#e8eaed;border-color:#5f6368}}
  </style></head><body><main class="panel"><div class="brand">Kept</div>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

async function initOAuthTables({ run, all }) {
  await run(`CREATE TABLE IF NOT EXISTS oauth_clients (
    clientId TEXT PRIMARY KEY, clientName TEXT NOT NULL, redirectUris TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS oauth_pending_authorizations (
    requestHash TEXT PRIMARY KEY, clientId TEXT NOT NULL, redirectUri TEXT NOT NULL,
    state TEXT, codeChallenge TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL,
    createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS oauth_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER NOT NULL,
    clientId TEXT NOT NULL, clientName TEXT NOT NULL, resource TEXT NOT NULL,
    scope TEXT NOT NULL, authorizedAt TEXT NOT NULL, lastUsedAt TEXT,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(userId, clientId, resource)
  )`);
  const authorizationCodeColumns = await all('PRAGMA table_info(oauth_authorization_codes)');
  if (authorizationCodeColumns.some(column => column.name === 'mcpTokenId')) {
    // OAuth grants were briefly tied to the local MCP token. Access tokens are
    // deliberately invalidated while moving to independent per-app grants.
    await run('DROP TABLE IF EXISTS oauth_authorization_codes');
    await run('DROP TABLE IF EXISTS oauth_access_tokens');
    await run('DROP TABLE IF EXISTS oauth_refresh_tokens');
  }
  await run(`CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    codeHash TEXT PRIMARY KEY, clientId TEXT NOT NULL, userId INTEGER NOT NULL,
    grantId INTEGER NOT NULL, redirectUri TEXT NOT NULL, codeChallenge TEXT NOT NULL,
    resource TEXT NOT NULL, scope TEXT NOT NULL, createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL, usedAt TEXT,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(grantId) REFERENCES oauth_grants(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    tokenHash TEXT PRIMARY KEY, userId INTEGER NOT NULL, grantId INTEGER NOT NULL,
    clientId TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL,
    createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL, revokedAt TEXT,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(grantId) REFERENCES oauth_grants(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    tokenHash TEXT PRIMARY KEY, userId INTEGER NOT NULL, grantId INTEGER NOT NULL,
    clientId TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL,
    createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL, revokedAt TEXT,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(grantId) REFERENCES oauth_grants(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS oauth_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER NOT NULL,
    grantId INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
    status INTEGER NOT NULL, createdAt TEXT NOT NULL,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(grantId) REFERENCES oauth_grants(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS oidc_flows (
    stateHash TEXT PRIMARY KEY, codeVerifier TEXT NOT NULL, nonce TEXT NOT NULL,
    oauthRequest TEXT, linkUserId INTEGER, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL
  )`);
  const oidcFlowColumns = await all('PRAGMA table_info(oidc_flows)');
  if (!oidcFlowColumns.some(column => column.name === 'linkUserId')) {
    await run('ALTER TABLE oidc_flows ADD COLUMN linkUserId INTEGER');
  }
  await run(`CREATE TABLE IF NOT EXISTS oidc_identities (
    issuer TEXT NOT NULL, subject TEXT NOT NULL, userId INTEGER NOT NULL,
    email TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    PRIMARY KEY(issuer, subject), FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_oidc_identities_user_issuer ON oidc_identities(userId, issuer)');
  await run(`CREATE TABLE IF NOT EXISTS oidc_login_codes (
    codeHash TEXT PRIMARY KEY, userId INTEGER NOT NULL, createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL, usedAt TEXT,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  )`);
  const now = new Date().toISOString();
  await run('DELETE FROM oauth_pending_authorizations WHERE expiresAt <= ?', [now]);
  await run('DELETE FROM oauth_authorization_codes WHERE expiresAt <= ?', [now]);
  await run('DELETE FROM oauth_access_tokens WHERE expiresAt <= ? OR revokedAt IS NOT NULL', [now]);
  await run('DELETE FROM oauth_refresh_tokens WHERE expiresAt <= ? OR revokedAt IS NOT NULL', [now]);
  await run('DELETE FROM oidc_flows WHERE expiresAt <= ?', [now]);
  await run('DELETE FROM oidc_login_codes WHERE expiresAt <= ?', [now]);
}

async function resolveOAuthAccessToken(token, { get }) {
  if (!String(token || '').startsWith('kept_oauth_')) return null;
  return get(
    `SELECT users.*, oauth_grants.id AS oauthGrantId,
            oauth_access_tokens.scope AS oauthScope, oauth_access_tokens.clientId AS oauthClientId,
            oauth_access_tokens.resource AS oauthResource
     FROM oauth_access_tokens
     JOIN users ON users.id = oauth_access_tokens.userId
     JOIN oauth_grants ON oauth_grants.id = oauth_access_tokens.grantId
     WHERE oauth_access_tokens.tokenHash = ? AND oauth_access_tokens.revokedAt IS NULL
       AND oauth_access_tokens.expiresAt > ? AND users.enabled = 1 AND users.oauthEnabled = 1`,
    [sha256(token), new Date().toISOString()]
  );
}

function oauthTokenCanCallApi(access, req) {
  if (!access?.oauthClientId) return true;
  if (String(access.oauthResource || '').endsWith('/api')) return true;
  return String(access.oauthResource || '').endsWith('/mcp')
    && req.header(MCP_INTERNAL_HEADER) === MCP_INTERNAL_SECRET;
}

function oidcSettings() {
  const issuer = String(process.env.KEPT_OIDC_ISSUER || '').trim().replace(/\/+$/, '');
  const clientId = String(process.env.KEPT_OIDC_CLIENT_ID || '').trim();
  return {
    enabled: !!(issuer && clientId), issuer, clientId,
    clientSecret: String(process.env.KEPT_OIDC_CLIENT_SECRET || ''),
    name: String(process.env.KEPT_OIDC_NAME || 'Single sign-on').trim() || 'Single sign-on',
    autoLinkEmail: process.env.KEPT_OIDC_AUTO_LINK_EMAIL === '1',
    autoProvision: process.env.KEPT_OIDC_AUTO_PROVISION === '1',
    scopes: String(process.env.KEPT_OIDC_SCOPES || 'openid profile email').trim()
  };
}

let oidcModulePromise;
let oidcConfigPromise;
async function oidcClient(settings) {
  oidcModulePromise ||= import('openid-client');
  const client = await oidcModulePromise;
  const issuerUrl = new URL(settings.issuer);
  const isLoopback = issuerUrl.hostname === 'localhost' || issuerUrl.hostname === '127.0.0.1' || issuerUrl.hostname === '::1';
  oidcConfigPromise ||= client.discovery(
    issuerUrl, settings.clientId,
    settings.clientSecret || undefined,
    undefined,
    isLoopback ? { execute: [client.allowInsecureRequests] } : undefined
  );
  return { client, config: await oidcConfigPromise };
}

async function resolveClient(clientId, { get }) {
  const stored = await get('SELECT * FROM oauth_clients WHERE clientId = ?', [clientId]);
  if (stored) return { clientId, clientName: stored.clientName, redirectUris: safeJson(stored.redirectUris, []) };
  let metadataUrl;
  try { metadataUrl = new URL(clientId); } catch { return null; }
  if (metadataUrl.protocol !== 'https:' || metadataUrl.hostname !== 'chatgpt.com' || !/^\/oauth\/(?:client|[^/]+\/client)\.json$/.test(metadataUrl.pathname)) return null;
  const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) return null;
  const metadata = await response.json();
  if (metadata.client_id !== clientId || !Array.isArray(metadata.redirect_uris)) return null;
  return { clientId, clientName: metadata.client_name || 'ChatGPT', redirectUris: metadata.redirect_uris.filter(validRedirectUri) };
}

function mountOAuthAndMcpRoutes(app, dependencies) {
  const { get, all, run, asyncRoute, requireAuth, resolveSessionFromToken, createSession, createUser, normalizeUsername, oauthRegistrationLimiter, internalBaseUrl } = dependencies;
  const urlencoded = express.urlencoded({ extended: false, limit: '32kb' });

  app.use('/oauth/authorize', (_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      Pragma: 'no-cache'
    });
    next();
  });

  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const issuer = baseUrlFor(req);
    res.json({ resource: `${issuer}/api`, authorization_servers: [issuer], scopes_supported: SUPPORTED_SCOPES, bearer_methods_supported: ['header'] });
  });
  app.get('/.well-known/oauth-protected-resource/api', (req, res) => {
    const issuer = baseUrlFor(req);
    res.json({ resource: `${issuer}/api`, authorization_servers: [issuer], scopes_supported: SUPPORTED_SCOPES, bearer_methods_supported: ['header'] });
  });
  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
    const issuer = baseUrlFor(req);
    res.json({ resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: SUPPORTED_SCOPES, bearer_methods_supported: ['header'] });
  });
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const issuer = baseUrlFor(req);
    res.json({
      issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      scopes_supported: SUPPORTED_SCOPES, authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true
    });
  });

  app.post('/oauth/register', oauthRegistrationLimiter, asyncRoute(async (req, res) => {
    const redirectUris = Array.isArray(req.body?.redirect_uris) ? [...new Set(req.body.redirect_uris.map(String))] : [];
    if (!redirectUris.length || redirectUris.length > 10 || redirectUris.some(uri => !validRedirectUri(uri))) {
      return oauthError(res, 400, 'invalid_client_metadata', 'One or more redirect_uris are missing or invalid.');
    }
    if (req.body?.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== 'none') {
      return oauthError(res, 400, 'invalid_client_metadata', 'Only public clients using token_endpoint_auth_method none are supported.');
    }
    const clientId = randomToken('kept_client_');
    const clientName = String(req.body?.client_name || 'OAuth client').trim().slice(0, 120) || 'OAuth client';
    await run('INSERT INTO oauth_clients (clientId, clientName, redirectUris, createdAt) VALUES (?, ?, ?, ?)', [clientId, clientName, JSON.stringify(redirectUris), new Date().toISOString()]);
    res.status(201).json({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: clientName, redirect_uris: redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  }));

  async function loadPending(rawRequest) {
    return get('SELECT * FROM oauth_pending_authorizations WHERE requestHash = ? AND expiresAt > ?', [sha256(rawRequest), new Date().toISOString()]);
  }

  function consentPage(requestId, pending, clientName) {
    const safeRequest = JSON.stringify(requestId).replace(/</g, '\\u003c');
    const scopes = new Set(parseScopes(pending?.scope));
    const scopeItems = [
      scopes.has('kept.read') ? '<li><strong>Read</strong> your notes, labels, reminders, images, and attachments</li>' : '',
      scopes.has('kept.write') ? '<li><strong>Change</strong> notes, checklists, reminders, collaborators, and attachments</li>' : ''
    ].join('');
    return htmlPage('Connect', `<h1>Connect ${escapeHtml(clientName)}?</h1><p>This client is requesting access to your Kept account.</p><ul class="scopes">${scopeItems}</ul><p>Locked notes and permanent deletion still follow your External Access settings.</p><p id="message"></p><div class="actions"><button id="cancel">Cancel</button><button class="primary" id="approve">Connect</button></div>`, `
const requestId=${safeRequest};const message=document.getElementById('message');
function session(){try{return JSON.parse(localStorage.getItem('gk_session')||'null')}catch{return null}}
const current=session();if(!current?.token){location.href='/login?oauth_request='+encodeURIComponent(requestId)}
document.getElementById('cancel').onclick=()=>location.href='/oauth/authorize/cancel?request='+encodeURIComponent(requestId);
document.getElementById('approve').onclick=async()=>{const button=document.getElementById('approve');button.disabled=true;message.textContent='Connecting...';try{const response=await fetch('/oauth/authorize/approve',{method:'POST',headers:{authorization:'Bearer '+session().token,'content-type':'application/json'},body:JSON.stringify({request:requestId})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not connect.');location.href=data.redirect}catch(error){message.className='error';message.textContent=error.message;button.disabled=false}};`);
  }

  app.get('/oauth/authorize', asyncRoute(async (req, res) => {
    const issuer = baseUrlFor(req);
    const clientId = String(req.query.client_id || '');
    const client = await resolveClient(clientId, { get });
    const redirectUri = String(req.query.redirect_uri || '');
    if (!client || !client.redirectUris.includes(redirectUri)) return res.status(400).send(htmlPage('Invalid request', '<h1>Invalid OAuth request</h1><p>The client or redirect address is not registered with this Kept server.</p>'));
    if (req.query.response_type !== 'code') return res.redirect(appendRedirect(redirectUri, { error: 'unsupported_response_type', state: req.query.state }));
    if (req.query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(req.query.code_challenge || ''))) return res.redirect(appendRedirect(redirectUri, { error: 'invalid_request', error_description: 'PKCE S256 is required.', state: req.query.state }));
    const resource = String(req.query.resource || `${issuer}/api`).replace(/\/+$/, '');
    if (![`${issuer}/api`, `${issuer}/mcp`].includes(resource)) return res.redirect(appendRedirect(redirectUri, { error: 'invalid_target', state: req.query.state }));
    const scope = parseScopes(String(req.query.scope || 'kept.read')).join(' ');
    if (!validScopes(scope)) return res.redirect(appendRedirect(redirectUri, { error: 'invalid_scope', error_description: `Supported scopes: ${SUPPORTED_SCOPES.join(' ')}`, state: req.query.state }));
    const requestId = randomToken('kept_oauth_request_');
    const pending = { scope };
    await run(`INSERT INTO oauth_pending_authorizations (requestHash, clientId, redirectUri, state, codeChallenge, resource, scope, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [sha256(requestId), clientId, redirectUri, String(req.query.state || ''), String(req.query.code_challenge), resource, scope, new Date().toISOString(), addSeconds(PENDING_TTL_SECONDS)]);
    res.type('html').send(consentPage(requestId, pending, client.clientName));
  }));

  app.get('/oauth/authorize/resume', asyncRoute(async (req, res) => {
    const requestId = String(req.query.request || '');
    const pending = await loadPending(requestId);
    if (!pending) return res.status(400).send(htmlPage('Expired request', '<h1>This connection request expired</h1><p>Return to the client and try connecting again.</p>'));
    const client = await resolveClient(pending.clientId, { get });
    res.type('html').send(consentPage(requestId, pending, client?.clientName || 'this client'));
  }));

  app.get('/oauth/authorize/cancel', asyncRoute(async (req, res) => {
    const requestId = String(req.query.request || '');
    const pending = await loadPending(requestId);
    if (!pending) return res.status(400).send(htmlPage('Expired request', '<h1>This connection request expired</h1>'));
    await run('DELETE FROM oauth_pending_authorizations WHERE requestHash = ?', [sha256(requestId)]);
    res.redirect(appendRedirect(pending.redirectUri, { error: 'access_denied', state: pending.state }));
  }));

  app.post('/oauth/authorize/approve', asyncRoute(async (req, res) => {
    const header = req.header('authorization') || '';
    const sessionToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = await resolveSessionFromToken(sessionToken);
    if (!user) return res.status(401).json({ error: 'Please sign in to Kept first.' });
    const requestId = String(req.body?.request || '');
    const pending = await loadPending(requestId);
    if (!pending) return res.status(400).json({ error: 'This connection request expired.' });
    if (!user.oauthEnabled) return res.status(403).json({ error: 'Enable OAuth app access in Kept settings before connecting this client.' });
    const client = await resolveClient(pending.clientId, { get });
    if (!client) return res.status(400).json({ error: 'This OAuth client is no longer available.' });
    const code = randomToken('kept_code_');
    const now = new Date().toISOString();
    await run('BEGIN IMMEDIATE');
    try {
      await run(
        `INSERT INTO oauth_grants (userId, clientId, clientName, resource, scope, authorizedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId, clientId, resource) DO UPDATE SET
           clientName = excluded.clientName, scope = excluded.scope, authorizedAt = excluded.authorizedAt`,
        [user.id, pending.clientId, client.clientName, pending.resource, pending.scope, now]
      );
      const grant = await get(
        'SELECT id FROM oauth_grants WHERE userId = ? AND clientId = ? AND resource = ?',
        [user.id, pending.clientId, pending.resource]
      );
      await run('DELETE FROM external_unlock_challenges WHERE principalType = ? AND principalId = ?', ['oauth', grant.id]);
      await run('DELETE FROM oauth_authorization_codes WHERE grantId = ?', [grant.id]);
      await run('DELETE FROM oauth_access_tokens WHERE grantId = ?', [grant.id]);
      await run('DELETE FROM oauth_refresh_tokens WHERE grantId = ?', [grant.id]);
      await run(
        `INSERT INTO oauth_authorization_codes
         (codeHash, clientId, userId, grantId, redirectUri, codeChallenge, resource, scope, createdAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sha256(code), pending.clientId, user.id, grant.id, pending.redirectUri, pending.codeChallenge, pending.resource, pending.scope, now, addSeconds(AUTHORIZATION_CODE_TTL_SECONDS)]
      );
      await run('DELETE FROM oauth_pending_authorizations WHERE requestHash = ?', [sha256(requestId)]);
      await run('COMMIT');
    } catch (error) { await run('ROLLBACK'); throw error; }
    res.json({ redirect: appendRedirect(pending.redirectUri, { code, state: pending.state, iss: baseUrlFor(req) }) });
  }));

  function tokenPayload(accessToken, refreshToken, scope) {
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope };
  }

  async function issueTokens(record) {
    const accessToken = randomToken('kept_oauth_');
    const refreshToken = randomToken('kept_refresh_');
    const now = new Date().toISOString();
    await run(`INSERT INTO oauth_access_tokens (tokenHash, userId, grantId, clientId, resource, scope, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [sha256(accessToken), record.userId, record.grantId, record.clientId, record.resource, record.scope, now, addSeconds(ACCESS_TOKEN_TTL_SECONDS)]);
    await run(`INSERT INTO oauth_refresh_tokens (tokenHash, userId, grantId, clientId, resource, scope, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [sha256(refreshToken), record.userId, record.grantId, record.clientId, record.resource, record.scope, now, addSeconds(REFRESH_TOKEN_TTL_SECONDS)]);
    return tokenPayload(accessToken, refreshToken, record.scope);
  }

  app.post('/oauth/token', urlencoded, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const grantType = String(req.body?.grant_type || '');
    const clientId = String(req.body?.client_id || '');
    if (!clientId || !(await resolveClient(clientId, { get }))) return oauthError(res, 401, 'invalid_client', 'Unknown OAuth client.');
    if (grantType === 'authorization_code') {
      const code = await get('SELECT * FROM oauth_authorization_codes WHERE codeHash = ? AND usedAt IS NULL AND expiresAt > ?', [sha256(req.body?.code), new Date().toISOString()]);
      if (!code || code.clientId !== clientId || code.redirectUri !== String(req.body?.redirect_uri || '')) return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired.');
      const verifier = String(req.body?.code_verifier || '');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || challenge !== code.codeChallenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
      if (req.body?.resource && String(req.body.resource).replace(/\/+$/, '') !== code.resource) return oauthError(res, 400, 'invalid_target', 'The requested resource does not match the authorization grant.');
      await run('BEGIN IMMEDIATE');
      try {
        const used = await run('UPDATE oauth_authorization_codes SET usedAt = ? WHERE codeHash = ? AND usedAt IS NULL', [new Date().toISOString(), code.codeHash]);
        if (!used.changes) throw Object.assign(new Error('Authorization code was already used.'), { status: 400 });
        const result = await issueTokens(code);
        await run('COMMIT');
        return res.json(result);
      } catch (error) { await run('ROLLBACK'); if (error.status === 400) return oauthError(res, 400, 'invalid_grant', error.message); throw error; }
    }
    if (grantType === 'refresh_token') {
      const refresh = await get('SELECT * FROM oauth_refresh_tokens WHERE tokenHash = ? AND revokedAt IS NULL AND expiresAt > ?', [sha256(req.body?.refresh_token), new Date().toISOString()]);
      if (!refresh || refresh.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired.');
      await run('BEGIN IMMEDIATE');
      try {
        const revoked = await run('UPDATE oauth_refresh_tokens SET revokedAt = ? WHERE tokenHash = ? AND revokedAt IS NULL', [new Date().toISOString(), refresh.tokenHash]);
        if (!revoked.changes) throw Object.assign(new Error('Refresh token was already used.'), { status: 400 });
        const result = await issueTokens(refresh);
        await run('COMMIT');
        return res.json(result);
      } catch (error) { await run('ROLLBACK'); if (error.status === 400) return oauthError(res, 400, 'invalid_grant', error.message); throw error; }
    }
    return oauthError(res, 400, 'unsupported_grant_type', 'Supported grants are authorization_code and refresh_token.');
  }));

  app.post('/oauth/revoke', urlencoded, asyncRoute(async (req, res) => {
    const hash = sha256(req.body?.token);
    const now = new Date().toISOString();
    await Promise.all([
      run('UPDATE oauth_access_tokens SET revokedAt = ? WHERE tokenHash = ?', [now, hash]),
      run('UPDATE oauth_refresh_tokens SET revokedAt = ? WHERE tokenHash = ?', [now, hash])
    ]);
    res.status(200).end();
  }));

  app.get('/api/auth/oidc/config', (_req, res) => {
    const settings = oidcSettings();
    res.json({ enabled: settings.enabled, name: settings.name });
  });

  async function createOidcAuthorizationUrl(req, { oauthRequest = '', linkUserId = null } = {}) {
    const settings = oidcSettings();
    if (!settings.enabled) return null;
    const { client, config } = await oidcClient(settings);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    await run(
      `INSERT INTO oidc_flows
       (stateHash, codeVerifier, nonce, oauthRequest, linkUserId, createdAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sha256(state), verifier, nonce, oauthRequest, linkUserId, new Date().toISOString(), addSeconds(PENDING_TTL_SECONDS)]
    );
    const redirectUri = `${baseUrlFor(req)}/api/auth/oidc/callback`;
    return client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: settings.scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce
    }).toString();
  }

  app.get('/api/auth/oidc/start', asyncRoute(async (req, res) => {
    const target = await createOidcAuthorizationUrl(req, { oauthRequest: String(req.query.oauth_request || '') });
    if (!target) return res.status(404).json({ error: 'OIDC sign-in is not configured.' });
    res.redirect(target);
  }));

  app.get('/api/auth/oidc/link/status', requireAuth, asyncRoute(async (req, res) => {
    const settings = oidcSettings();
    if (!settings.enabled) {
      return res.json({ enabled: false, providerName: settings.name, connected: false, identityEmail: '', connectedAt: null, canDisconnect: false });
    }
    const identity = await get(
      'SELECT email, createdAt, updatedAt FROM oidc_identities WHERE issuer = ? AND userId = ?',
      [settings.issuer, req.user.id]
    );
    res.json({
      enabled: true,
      providerName: settings.name,
      connected: !!identity,
      identityEmail: identity?.email || '',
      connectedAt: identity?.createdAt || null,
      canDisconnect: !!req.user.localPasswordEnabled
    });
  }));

  app.post('/api/auth/oidc/link/start', requireAuth, asyncRoute(async (req, res) => {
    const settings = oidcSettings();
    if (!settings.enabled) return res.status(404).json({ error: 'OIDC sign-in is not configured.' });
    const existing = await get('SELECT subject FROM oidc_identities WHERE issuer = ? AND userId = ?', [settings.issuer, req.user.id]);
    if (existing) return res.status(409).json({ error: `${settings.name} is already connected to this account.` });
    const url = await createOidcAuthorizationUrl(req, { linkUserId: req.user.id });
    res.json({ url });
  }));

  app.delete('/api/auth/oidc/link', requireAuth, asyncRoute(async (req, res) => {
    const settings = oidcSettings();
    if (!settings.enabled) return res.status(404).json({ error: 'OIDC sign-in is not configured.' });
    if (!req.user.localPasswordEnabled) {
      return res.status(409).json({ error: 'Set a local password before disconnecting your only sign-in method.' });
    }
    await run('DELETE FROM oidc_identities WHERE issuer = ? AND userId = ?', [settings.issuer, req.user.id]);
    res.status(204).end();
  }));

  app.get('/api/auth/oidc/callback', asyncRoute(async (req, res) => {
    const settings = oidcSettings();
    if (!settings.enabled) return res.redirect('/login?oidc_error=not_configured');
    const state = String(req.query.state || '');
    const flow = await get('SELECT * FROM oidc_flows WHERE stateHash = ? AND expiresAt > ?', [sha256(state), new Date().toISOString()]);
    if (!flow) return res.redirect('/login?oidc_error=expired');
    await run('DELETE FROM oidc_flows WHERE stateHash = ?', [sha256(state)]);
    const { client, config } = await oidcClient(settings);
    const currentUrl = new URL(`${baseUrlFor(req)}${req.originalUrl}`);
    const tokens = await client.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: flow.codeVerifier, expectedState: state, expectedNonce: flow.nonce });
    const claims = tokens.claims();
    if (!claims?.sub) return res.redirect(flow.linkUserId ? '/settings?oidc_link=missing_identity' : '/login?oidc_error=missing_identity');
    const email = String(claims.email || '').trim().toLowerCase();
    if (flow.linkUserId) {
      const targetUser = await get('SELECT * FROM users WHERE id = ? AND enabled = 1', [flow.linkUserId]);
      if (!targetUser) return res.redirect('/settings?oidc_link=account_unavailable');
      const linkedIdentity = await get('SELECT userId FROM oidc_identities WHERE issuer = ? AND subject = ?', [settings.issuer, claims.sub]);
      if (linkedIdentity && linkedIdentity.userId !== targetUser.id) {
        return res.redirect('/settings?oidc_link=already_connected');
      }
      const now = new Date().toISOString();
      if (linkedIdentity) {
        await run('UPDATE oidc_identities SET email = ?, updatedAt = ? WHERE issuer = ? AND subject = ?', [email || null, now, settings.issuer, claims.sub]);
      } else {
        await run(
          'INSERT INTO oidc_identities (issuer, subject, userId, email, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
          [settings.issuer, claims.sub, targetUser.id, email || null, now, now]
        );
      }
      return res.redirect('/settings?oidc_link=connected');
    }
    let identity = await get('SELECT users.* FROM oidc_identities JOIN users ON users.id = oidc_identities.userId WHERE issuer = ? AND subject = ? AND users.enabled = 1', [settings.issuer, claims.sub]);
    if (!identity && settings.autoLinkEmail && claims.email_verified === true && email) {
      const matches = await all('SELECT * FROM users WHERE lower(email) = ? AND enabled = 1', [email]);
      if (matches.length === 1) {
        identity = matches[0];
        await run('INSERT INTO oidc_identities (issuer, subject, userId, email, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)', [settings.issuer, claims.sub, identity.id, email, new Date().toISOString(), new Date().toISOString()]);
      }
    }
    if (!identity && settings.autoProvision) {
      const candidate = normalizeUsername(String(claims.preferred_username || email.split('@')[0] || `oidc-${String(claims.sub).slice(0, 12)}`).replace(/[^a-zA-Z0-9._-]/g, '-'));
      let username = candidate.length >= 3 ? candidate : `user-${crypto.randomBytes(4).toString('hex')}`;
      let suffix = 1;
      while (await get('SELECT id FROM users WHERE username = ?', [username])) username = `${candidate}-${suffix++}`;
      identity = await createUser({ username, displayName: String(claims.name || claims.preferred_username || username), password: randomToken('oidc_'), role: 'user', email: email || null, enabled: true, localPasswordEnabled: false });
      await run('INSERT INTO oidc_identities (issuer, subject, userId, email, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)', [settings.issuer, claims.sub, identity.id, email || null, new Date().toISOString(), new Date().toISOString()]);
    }
    if (!identity) return res.redirect(`/login?oidc_error=no_account${flow.oauthRequest ? `&oauth_request=${encodeURIComponent(flow.oauthRequest)}` : ''}`);
    const loginCode = randomToken('kept_login_');
    await run('INSERT INTO oidc_login_codes (codeHash, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)', [sha256(loginCode), identity.id, new Date().toISOString(), addSeconds(60)]);
    const params = new URLSearchParams({ oidc_code: loginCode });
    if (flow.oauthRequest) params.set('oauth_request', flow.oauthRequest);
    res.redirect(`/login?${params.toString()}`);
  }));

  app.post('/api/auth/oidc/exchange', asyncRoute(async (req, res) => {
    const codeHash = sha256(req.body?.code);
    const record = await get('SELECT * FROM oidc_login_codes WHERE codeHash = ? AND usedAt IS NULL AND expiresAt > ?', [codeHash, new Date().toISOString()]);
    if (!record) return res.status(400).json({ error: 'This SSO sign-in expired. Please try again.' });
    const user = await get('SELECT * FROM users WHERE id = ? AND enabled = 1', [record.userId]);
    if (!user) return res.status(403).json({ error: 'This Kept account is not enabled.' });
    const result = await run('UPDATE oidc_login_codes SET usedAt = ? WHERE codeHash = ? AND usedAt IS NULL', [new Date().toISOString(), codeHash]);
    if (!result.changes) return res.status(400).json({ error: 'This SSO sign-in was already used.' });
    res.json(await createSession(user));
  }));

  app.all('/mcp', asyncRoute(async (req, res) => {
    const issuer = baseUrlFor(req);
    const header = req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const access = await resolveOAuthAccessToken(token, { get });
    if (!access || access.oauthResource !== `${issuer}/mcp`) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`);
      return res.status(401).json({ error: 'invalid_token', error_description: 'A valid Kept OAuth access token is required.' });
    }
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    const [{ StreamableHTTPServerTransport }, { KeptClient }, { createKeptMcpServer }] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/streamableHttp.js'), import('../mcp/kept-client.mjs'), import('../mcp/server.mjs')
    ]);
    const client = new KeptClient({
      baseUrl: internalBaseUrl,
      token,
      timeoutMs: 120000,
      customHeaders: { [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET }
    });
    const mcpServer = createKeptMcpServer(client, { oauth: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => undefined); mcpServer.close().catch(() => undefined); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));
}

module.exports = { initOAuthTables, mountOAuthAndMcpRoutes, oauthTokenCanCallApi, resolveOAuthAccessToken, SUPPORTED_SCOPES };
