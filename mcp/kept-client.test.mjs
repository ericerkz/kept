import assert from 'node:assert/strict';
import test from 'node:test';
import { KeptApiError, KeptClient, loadKeptConfig } from './kept-client.mjs';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('loadKeptConfig requires a URL and one authentication mode', () => {
  assert.throws(() => loadKeptConfig({}), /KEPT_BASE_URL is required/);
  assert.throws(
    () => loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com' }),
    /Set KEPT_TOKEN or both KEPT_USERNAME and KEPT_PASSWORD/
  );
  assert.deepEqual(
    loadKeptConfig({
      KEPT_BASE_URL: 'https://kept.example.com/',
      KEPT_TOKEN: 'session-token',
      KEPT_REQUEST_TIMEOUT_MS: '2500'
    }),
    {
      baseUrl: 'https://kept.example.com',
      token: 'session-token',
      username: '',
      password: '',
      timeoutMs: 2500
    }
  );
});

test('token authentication maps note requests without leaking credentials into the URL', async () => {
  const calls = [];
  const client = new KeptClient(
    loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com', KEPT_TOKEN: 'secret-token' }),
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse([{ id: 7, noteTitle: 'Result' }]);
      }
    }
  );

  const result = await client.searchNotes('project plan');
  assert.deepEqual(result, [{ id: 7, noteTitle: 'Result' }]);
  assert.equal(calls[0].url, 'https://kept.example.com/api/notes/search?q=project%20plan');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-token');
  assert.equal(calls[0].url.includes('secret-token'), false);
});

test('credential authentication logs in and retries one request rejected with 401', async () => {
  const calls = [];
  const responses = [
    jsonResponse({ token: 'first-session' }),
    jsonResponse({ error: 'Authentication required.' }, 401),
    jsonResponse({ token: 'second-session' }),
    jsonResponse({ id: 4, noteTitle: 'Recovered' })
  ];
  const client = new KeptClient(
    loadKeptConfig({
      KEPT_BASE_URL: 'https://kept.example.com',
      KEPT_USERNAME: 'agent',
      KEPT_PASSWORD: 'password'
    }),
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return responses.shift();
      }
    }
  );

  const result = await client.getNote(4);
  assert.equal(result.noteTitle, 'Recovered');
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/api/auth/login',
    '/api/notes/4',
    '/api/auth/login',
    '/api/notes/4'
  ]);
  assert.equal(calls[1].options.headers.authorization, 'Bearer first-session');
  assert.equal(calls[3].options.headers.authorization, 'Bearer second-session');
});

test('2FA accounts fail with an actionable token instruction', async () => {
  const client = new KeptClient(
    loadKeptConfig({
      KEPT_BASE_URL: 'https://kept.example.com',
      KEPT_USERNAME: 'agent',
      KEPT_PASSWORD: 'password'
    }),
    {
      fetchImpl: async () => jsonResponse({ error: '2FA required', requires2FA: true }, 401)
    }
  );

  await assert.rejects(
    () => client.getNote(1),
    (error) => error instanceof KeptApiError && error.code === 'TWO_FACTOR_REQUIRED' && /KEPT_TOKEN/.test(error.message)
  );
});

test('resolveLabels preserves existing labels and creates missing labels through the API', async () => {
  const calls = [];
  const responses = [
    jsonResponse([{ id: 2, name: 'Work' }]),
    jsonResponse({ id: 5, name: 'Agent' })
  ];
  const client = new KeptClient(
    loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com', KEPT_TOKEN: 'secret-token' }),
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return responses.shift();
      }
    }
  );

  assert.deepEqual(await client.resolveLabels(['work', 'Agent']), [
    { id: 2, name: 'Work', added: true },
    { id: 5, name: 'Agent', added: true }
  ]);
  assert.equal(new URL(calls[1].url).pathname, '/api/labels/find-or-create');
  assert.equal(calls[1].options.body, JSON.stringify({ name: 'Agent' }));
});

test('updateNote patches selected fields and then returns the current note', async () => {
  const calls = [];
  const client = new KeptClient(
    loadKeptConfig({ KEPT_BASE_URL: 'https://kept.example.com', KEPT_TOKEN: 'secret-token' }),
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (options.method === 'PATCH') return new Response(null, { status: 204 });
        return jsonResponse({ id: 9, noteTitle: 'Updated' });
      }
    }
  );

  const result = await client.updateNote(9, { noteTitle: 'Updated' });
  assert.equal(result.noteTitle, 'Updated');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.body, JSON.stringify({ noteTitle: 'Updated' }));
  assert.equal(calls[1].options.method, 'GET');
});
