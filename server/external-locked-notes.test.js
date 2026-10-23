const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFixture } = require('../test-support/session-fixture.cjs');

async function setup(t) {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  let sessionToken;
  async function request(path, { token = sessionToken, method = 'GET', body, form, status = 200 } = {}) {
    const response = await fetch(fixture.origin + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
      },
      body: form ? new URLSearchParams(form) : body ? JSON.stringify(body) : undefined
    });
    const payload = response.status === 204 ? null : response.headers.get('content-type')?.includes('application/json')
      ? await response.json() : await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(payload)}`);
    return { payload, headers: response.headers };
  }
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  await request('/api/setup/admin', { method: 'POST', body: credentials, status: 201 });
  sessionToken = (await request('/api/auth/login', { method: 'POST', body: credentials })).payload.token;
  const mcpToken = (await request('/api/users/me/mcp-access/enable', { method: 'POST', body: {}, status: 201 })).payload.accessToken;
  async function createNote(fields = {}) {
    return (await request('/api/notes', { method: 'POST', status: 201, body: {
      noteTitle: 'Locked note', noteBody: 'SECRET-BODY-7391',
      checkBoxes: [{ id: 91, data: 'SECRET-CHECKLIST-7391', done: false }], images: [], labels: [],
      locked: true, lockSalt: 'test-salt',
      lockHash: `pbkdf2:${crypto.pbkdf2Sync('correct passcode', 'test-salt', 150000, 32, 'sha256').toString('base64url')}`,
      ...fields
    } })).payload;
  }
  async function challenge(noteId, token = mcpToken) {
    return (await request(`/api/mcp/locked-notes/${noteId}/unlock`, { token, method: 'POST', body: {}, status: 201 })).payload;
  }
  async function oauthToken(scope = 'kept.read kept.write') {
    await request('/api/users/me/oauth-access/enable', { method: 'POST', body: {} });
    const client = (await request('/oauth/register', { method: 'POST', status: 201, body: {
      client_name: 'Locked-note regression test', redirect_uris: ['http://localhost:9876/callback'], token_endpoint_auth_method: 'none'
    } })).payload;
    const verifier = crypto.randomBytes(48).toString('base64url');
    const params = new URLSearchParams({
      client_id: client.client_id, redirect_uri: 'http://localhost:9876/callback', response_type: 'code',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      scope, resource: `${fixture.origin}/api`, state: 'locked-note-test'
    });
    const page = (await request(`/oauth/authorize?${params}`)).payload;
    const requestId = page.match(/const requestId="([^"]+)"/)?.[1];
    assert.ok(requestId);
    const approval = (await request('/oauth/authorize/approve', { method: 'POST', body: { request: requestId } })).payload;
    return (await request('/oauth/token', { method: 'POST', form: {
      grant_type: 'authorization_code', client_id: client.client_id, code: new URL(approval.redirect).searchParams.get('code'),
      redirect_uri: 'http://localhost:9876/callback', code_verifier: verifier, resource: `${fixture.origin}/api`
    } })).payload.access_token;
  }
  return { fixture, request, createNote, challenge, oauthToken, sessionToken, mcpToken };
}

test('MCP and OAuth list/search responses hide locked content and verifiers; first-party reads stay compatible', async t => {
  const { fixture, request, createNote, oauthToken, sessionToken, mcpToken } = await setup(t);
  const note = await createNote({
    bgImage: 'data:image/png;base64,c2VjcmV0',
    customPreview: 'SECRET-CUSTOM-7391', bodyPreview: 'SECRET-PREVIEW-7391'
  });
  const ordinary = await createNote({ noteTitle: 'Ordinary', noteBody: 'Public body', checkBoxes: [], locked: false });
  const readToken = await oauthToken('kept.read');
  for (const token of [mcpToken, readToken]) {
    for (const path of ['/api/notes', '/api/notes?view=card', `/api/notes/${note.id}`, '/api/notes/search?q=Locked']) {
      const { payload } = await request(path, { token });
      const entries = Array.isArray(payload) ? payload : payload.notes || [payload];
      const locked = entries.find(item => item.id === note.id);
      assert.ok(locked, path);
      for (const field of ['lockHash', 'lockSalt', 'customPreview']) assert.equal(field in locked, false, `${path}: ${field}`);
      assert.equal(locked.lockedContentAvailable, false);
      assert.equal(locked.noteBody, '');
      assert.deepEqual(locked.checkBoxes, []);
      assert.deepEqual(locked.images, []);
      assert.deepEqual(locked.attachments, []);
      assert.equal(locked.bgImage, '');
      assert.doesNotMatch(JSON.stringify(locked), /SECRET-/);
    }
    for (const q of ['SECRET-BODY-7391', 'SECRET-CHECKLIST-7391']) {
      for (const path of [`/api/notes/search?q=${q}`, `/api/notes?view=card&q=${q}`]) {
        const { payload } = await request(path, { token });
        assert.deepEqual(Array.isArray(payload) ? payload : payload.notes, []);
      }
    }
    assert.equal((await request('/api/notes?view=card&q=!todo', { token })).payload.notes.some(item => item.id === note.id), false);
    assert.equal((await request(`/api/notes/${ordinary.id}`, { token })).payload.noteBody, 'Public body');
    await request('/api/sync/bootstrap?protocolVersion=2', { token, status: 403 });
  }
  // Native bearer API and sync keep the fields required for offline unlocking.
  const full = (await request('/api/notes', { token: sessionToken })).payload.find(item => item.id === note.id);
  assert.equal(full.noteBody, note.noteBody);
  assert.equal(full.lockHash, note.lockHash);
  assert.equal((await request(`/api/notes/${note.id}`)).payload.lockSalt, note.lockSalt);
  assert.equal((await request('/api/notes?view=card')).payload.notes.find(item => item.id === note.id).lockHash, note.lockHash);
  assert.equal((await request('/api/sync/bootstrap?protocolVersion=2')).payload.notes.find(item => item.id === note.id).noteBody, note.noteBody);
  // Browser-cookie reads use the same first-party behavior.
  const anonymous = await fetch(fixture.origin + '/api/auth/browser/session');
  const anonymousCookie = anonymous.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await anonymous.json();
  const login = await fetch(fixture.origin + '/api/auth/browser/login', {
    method: 'POST', headers: { Cookie: anonymousCookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'test-password-123' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const browserNotes = await fetch(fixture.origin + '/api/notes', { headers: { Cookie: cookie } });
  assert.equal((await browserNotes.json()).find(item => item.id === note.id).lockHash, note.lockHash);
});

test('files and reminders require external unlock; approval is connection-specific, expires and can be disabled', async t => {
  const { fixture, request, createNote, challenge, oauthToken, mcpToken, sessionToken } = await setup(t);
  const oauth = await oauthToken();
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C8kAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('image', new Blob([imageBytes], { type: 'image/png' }), 'private.png');
  const uploaded = await fetch(fixture.origin + '/api/uploads/images', { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` }, body: form });
  assert.equal(uploaded.status, 201);
  const image = await uploaded.json();
  const note = await createNote({ noteBody: `SECRET-BODY-7391<img src="${image.url}">`, images: [{ id: 'photo', dataUrl: image.url }] });
  const attachmentForm = new FormData();
  attachmentForm.append('file', new Blob(['SECRET-ATTACHMENT-7391'], { type: 'text/plain' }), 'secret.txt');
  const attachmentResponse = await fetch(fixture.origin + `/api/notes/${note.id}/attachments`, {
    method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` }, body: attachmentForm
  });
  assert.equal(attachmentResponse.status, 201);
  const attachment = await attachmentResponse.json();
  const reminder = (await request('/api/reminders', { method: 'POST', status: 201,
    body: { noteId: note.id, dueAtUtc: '2099-01-01T00:00:00Z', body: 'SECRET-REMINDER-7391', imageUrl: image.url }
  })).payload;
  async function denied(token) {
    await request(image.url, { token, status: 423 });
    await request(`/api/attachments/${attachment.id}`, { token, status: 423 });
    assert.equal((await request('/api/reminders', { token })).payload.some(item => item.id === reminder.id), false);
    await request('/api/reminders', { token, method: 'POST', status: 423, body: { noteId: note.id, dueAtUtc: '2099-01-02T00:00:00Z' } });
    await request(`/api/reminders/${reminder.id}`, { token, method: 'PATCH', status: 423, body: { status: 'dismissed' } });
    await request(`/api/notes/${note.id}/collaborators`, { token, method: 'PUT', status: 423, body: { userIds: [] } });
  }
  for (const token of [mcpToken, oauth]) await denied(token);
  for (const path of ['/api/notes', '/api/notes?view=card']) {
    const { payload } = await request(path, { token: mcpToken });
    const locked = (payload.notes || payload).find(item => item.id === note.id);
    assert.equal(locked.attachmentCount, 0);
    assert.deepEqual(locked.attachments, []);
    assert.doesNotMatch(JSON.stringify(locked), /secret\.txt|uploads\/images/);
  }
  // Copying a known image URL into an unlocked note cannot bypass the lock.
  await request('/api/notes', { token: mcpToken, method: 'POST', status: 201,
    body: { noteTitle: 'Copy', noteBody: `<img src="${image.url}">`, images: [{ id: 'copy', dataUrl: image.url }] } });
  await request(image.url, { token: mcpToken, status: 423 });
  // Legacy imported images can have an unlinked index record. Content still
  // determines the lock even if an external client creates another reference.
  await fixture.sql('UPDATE note_images SET noteId = NULL WHERE noteId = ?', [note.id]);
  await request(image.url, { token: mcpToken, status: 423 });
  await request('/api/users/me/external-access/capabilities', { method: 'PATCH', body: { allowLockedNotes: true } });
  const unlock = await challenge(note.id);
  const unlockPath = new URL(unlock.unlockUrl).pathname;
  await request(unlockPath, { method: 'POST', form: { passcode: 'correct passcode' } });
  const { payload: revealed } = await request(`/api/notes/${note.id}`, { token: mcpToken });
  assert.equal(revealed.noteBody, note.noteBody);
  assert.equal('lockHash' in revealed, false);
  assert.equal('lockSalt' in revealed, false);
  assert.equal((await request(`/api/attachments/${attachment.id}`, { token: mcpToken })).payload, 'SECRET-ATTACHMENT-7391');
  const imageResponse = await fetch(fixture.origin + image.url, { headers: { Authorization: `Bearer ${mcpToken}` } });
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageBytes);
  assert.equal((await request('/api/reminders', { token: mcpToken })).payload.some(item => item.id === reminder.id), true);
  await request(`/api/notes/${note.id}/collaborators`, { token: mcpToken, method: 'PUT', body: { userIds: [] } });
  await denied(oauth);
  const approved = (await fixture.sql('SELECT expiresAt FROM external_unlock_challenges WHERE token = ?', [unlockPath.split('/').pop()]))[0].expiresAt;
  await request(unlockPath, { method: 'POST', form: { passcode: 'correct passcode' } });
  assert.equal((await fixture.sql('SELECT expiresAt FROM external_unlock_challenges WHERE token = ?', [unlockPath.split('/').pop()]))[0].expiresAt, approved);
  await request('/api/users/me/external-access/capabilities', { method: 'PATCH', body: { allowLockedNotes: false } });
  await denied(mcpToken);
  await request('/api/users/me/external-access/capabilities', { method: 'PATCH', body: { allowLockedNotes: true } });
  const oauthUnlock = await challenge(note.id, oauth);
  await request(new URL(oauthUnlock.unlockUrl).pathname, { method: 'POST', form: { passcode: 'correct passcode' } });
  assert.equal((await request(`/api/attachments/${attachment.id}`, { token: oauth })).payload, 'SECRET-ATTACHMENT-7391');
  await fixture.sql('UPDATE external_unlock_challenges SET expiresAt = ?', ['2000-01-01T00:00:00Z']);
  for (const token of [mcpToken, oauth]) await denied(token);
  // Existing native reads and reminders continue while the note is locked.
  assert.equal((await request(`/api/attachments/${attachment.id}`)).payload, 'SECRET-ATTACHMENT-7391');
  assert.equal((await fetch(fixture.origin + image.url, { headers: { Authorization: `Bearer ${sessionToken}` } })).status, 200);
  assert.equal((await request('/api/reminders')).payload.some(item => item.id === reminder.id), true);
});

test('unlock failures are bounded across challenges, connections, races and restarts with a visible retry time', async t => {
  const { fixture, request, createNote, challenge, oauthToken, mcpToken } = await setup(t);
  const oauth = await oauthToken();
  const note = await createNote();
  await request('/api/users/me/external-access/capabilities', { method: 'PATCH', body: { allowLockedNotes: true } });
  const links = await Promise.all(Array.from({ length: 6 }, (_, index) => challenge(note.id, index % 2 ? oauth : mcpToken)));
  const responses = await Promise.all(links.map(link => fetch(new URL(link.unlockUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passcode: 'wrong' })
  })));
  assert.deepEqual(responses.map(response => response.status).sort(), [401, 401, 401, 401, 429, 429]);
  for (const response of responses.filter(response => response.status === 429)) {
    assert.match(await response.text(), /Too many incorrect passcodes\. Try again in \d+ minutes?\./);
  }
  await fixture.sql('UPDATE external_unlock_limits SET windowStartMs = ?', [Date.now() - 3 * 60 * 1000]);
  const blockedPage = await request(new URL(links[1].unlockUrl).pathname, { status: 429 });
  assert.equal(blockedPage.payload, 'Too many incorrect passcodes. Try again in 12 minutes.');
  for (const token of [mcpToken, oauth]) {
    const limited = await request(`/api/mcp/locked-notes/${note.id}/unlock`, { token, method: 'POST', body: {}, status: 429 });
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  }
  const replacement = (await request('/api/users/me/mcp-access/enable', { method: 'POST', body: {}, status: 201 })).payload.accessToken;
  await request(`/api/mcp/locked-notes/${note.id}/unlock`, { token: replacement, method: 'POST', body: {}, status: 429 });
  await fixture.restart();
  await request(`/api/mcp/locked-notes/${note.id}/unlock`, { token: replacement, method: 'POST', body: {}, status: 429 });
  await request(new URL(links[1].unlockUrl).pathname, { method: 'POST', form: { passcode: 'correct passcode' }, status: 429 });
  // Advancing only the persisted window proves recovery without a test sleep.
  await fixture.sql('UPDATE external_unlock_limits SET windowStartMs = ?', [Date.now() - 16 * 60 * 1000]);
  const recovered = await challenge(note.id, replacement);
  await request(new URL(recovered.unlockUrl).pathname, { method: 'POST', form: { passcode: 'correct passcode' } });
  assert.equal((await request(`/api/notes/${note.id}`, { token: replacement })).payload.lockedContentAvailable, true);
  const other = await createNote({ noteTitle: 'Other locked note' });
  for (let index = 0; index < 11; index++) await challenge(other.id, replacement);
});
