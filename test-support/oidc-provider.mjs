import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';

export async function startProvider() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: 'test-key', use: 'sig', alg: 'RS256' });
  const codes = new Map();
  let identity = { sub: 'primary-subject', email: 'admin@example.test', name: 'Admin User' };
  let issuer = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer || 'http://127.0.0.1');
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post']
      }));
    }
    if (url.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    if (url.pathname === '/authorize') {
      const code = randomBytes(20).toString('base64url');
      codes.set(code, {
        nonce: url.searchParams.get('nonce'),
        challenge: url.searchParams.get('code_challenge'),
        redirectUri: url.searchParams.get('redirect_uri'),
        identity: { ...identity }
      });
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const record = codes.get(params.get('code'));
      if (!record || record.redirectUri !== params.get('redirect_uri')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      const challenge = createHash('sha256').update(params.get('code_verifier') || '').digest('base64url');
      if (challenge !== record.challenge) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      codes.delete(params.get('code'));
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        iss: issuer, aud: 'kept-test', iat: now, exp: now + 300, nonce: record.nonce,
        sub: record.identity.sub, email: record.identity.email, email_verified: true,
        name: record.identity.name, preferred_username: record.identity.email.split('@')[0]
      })).toString('base64url');
      const input = `${header}.${payload}`;
      const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'provider-access', token_type: 'Bearer', expires_in: 300, id_token: `${input}.${signature}` }));
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  return {
    issuer,
    setIdentity(value) { identity = value; },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}

export async function completeProviderRedirect(startUrl) {
  const providerResponse = await fetch(startUrl, { redirect: 'manual' });
  assert.equal(providerResponse.status, 302);
  const callback = providerResponse.headers.get('location');
  assert.ok(callback);
  return callback;
}
