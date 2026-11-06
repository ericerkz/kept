const { createPublicFileDownloader } = require('./public-file-download');

const MAX_METADATA_BYTES = 5 * 1024;
const MAX_REDIRECT_URIS = 10;

function clientMetadataUrl(clientId) {
  if (typeof clientId !== 'string' || clientId.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(clientId)) return null;
  try {
    const url = new URL(clientId);
    if (url.protocol !== 'https:' || url.username || url.password || clientId.includes('#') ||
        /^https:\/\/[^/]*@/i.test(clientId) || url.pathname === '/') return null;
    // URL parsing normalizes dot segments; reject them in the original identifier too.
    const path = clientId.replace(/^https:\/\/[^/]+/i, '').split('?')[0];
    if (path.split('/').some(segment => ['.', '..'].includes(decodeURIComponent(segment)))) return null;
    return url;
  } catch { return null; }
}

function validRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (value.includes('#') || url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['data:', 'file:', 'javascript:'].includes(url.protocol);
  } catch { return false; }
}

function redirectUriMatches(requested, registered) {
  if (!validRedirectUri(requested)) return false;
  if (registered.includes(requested)) return true;
  const url = new URL(requested);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  // RFC 8252's loopback exception varies only the port. Keep every other byte exact.
  const withoutPort = value => value.replace(/^(http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::\d+)?(?=\/|\?|$)/i, '$1');
  return registered.some(value => validRedirectUri(value) && withoutPort(value) === withoutPort(requested));
}

function parseClientMetadata(clientId, metadata) {
  const url = clientMetadataUrl(clientId);
  if (!url || !metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.client_id !== clientId ||
      typeof metadata.client_name !== 'string' || !metadata.client_name.trim() || metadata.client_name.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(metadata.client_name) || !Array.isArray(metadata.redirect_uris) ||
      !metadata.redirect_uris.length || metadata.redirect_uris.length > MAX_REDIRECT_URIS || metadata.redirect_uris.some(uri => !validRedirectUri(uri))) {
    throw new Error('Invalid OAuth client metadata.');
  }
  // Supported alternatives take precedence over the preferred method. ChatGPT
  // prefers private_key_jwt but explicitly offers public-client "none" as well.
  const methods = metadata.token_endpoint_auth_methods_supported ?? [metadata.token_endpoint_auth_method ?? 'none'];
  if (!Array.isArray(methods) || !methods.includes('none') || methods.length > 10 ||
      methods.some(method => typeof method !== 'string' || method.startsWith('client_secret')) ||
      (typeof metadata.token_endpoint_auth_method === 'string' && metadata.token_endpoint_auth_method.startsWith('client_secret')) ||
      metadata.client_secret !== undefined || metadata.client_secret_expires_at !== undefined ||
      (metadata.grant_types !== undefined && (!Array.isArray(metadata.grant_types) || !metadata.grant_types.includes('authorization_code'))) ||
      (metadata.response_types !== undefined && (!Array.isArray(metadata.response_types) || !metadata.response_types.includes('code')))) {
    throw new Error('Unsupported OAuth client metadata.');
  }
  return { clientId, clientName: metadata.client_name.trim(), clientDomain: url.hostname, redirectUris: [...new Set(metadata.redirect_uris)] };
}

function cacheDuration(headers, now) {
  const control = String(headers['cache-control'] || '');
  if (/\b(?:no-store|no-cache)\b/i.test(control)) return 0;
  const age = Math.max(0, Number(headers.age) || 0);
  const maxAge = /\bmax-age\s*=\s*"?(\d+)/i.exec(control);
  const expires = Date.parse(headers.expires);
  const seconds = maxAge ? Number(maxAge[1]) - age : Number.isFinite(expires) ? (expires - now) / 1000 : 300;
  return Math.min(3600, Math.max(0, seconds)) * 1000;
}

function createClientMetadataResolver({ download = createPublicFileDownloader(), now = Date.now, maxEntries = 256, maxConcurrent = 16 } = {}) {
  const cache = new Map(), pending = new Map();
  return async function resolveClient(clientId, { get }) {
    const stored = await get('SELECT * FROM oauth_clients WHERE clientId = ?', [clientId]);
    if (stored) {
      let redirectUris;
      try { redirectUris = JSON.parse(stored.redirectUris); } catch { return null; }
      return Array.isArray(redirectUris) ? { clientId, clientName: stored.clientName, redirectUris } : null;
    }
    if (!clientMetadataUrl(clientId)) return null;
    const cached = cache.get(clientId);
    if (cached?.expiresAt > now()) {
      cache.delete(clientId); cache.set(clientId, cached);
      return cached.client;
    }
    cache.delete(clientId);
    if (pending.has(clientId)) return pending.get(clientId);
    if (pending.size >= maxConcurrent) return null;
    const promise = Promise.resolve().then(async () => {
      try {
        const { body, headers } = await download(clientId, {
          maxBytes: MAX_METADATA_BYTES, timeoutMs: 5000, maxRedirects: 0,
          accept: 'application/json', requiredStatus: 200, includeHeaders: true
        });
        const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(type)) return null;
        const client = parseClientMetadata(clientId, JSON.parse(body.toString('utf8')));
        const ttl = cacheDuration(headers, now());
        if (ttl > 0) {
          while (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
          cache.set(clientId, { client, expiresAt: now() + ttl });
        }
        return client;
      } catch { return null; }
      finally { pending.delete(clientId); }
    });
    pending.set(clientId, promise);
    return promise;
  };
}

module.exports = { clientMetadataUrl, validRedirectUri, redirectUriMatches, parseClientMetadata, createClientMetadataResolver };
