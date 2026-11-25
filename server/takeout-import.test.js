const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('Takeout import reads notes from a localized Keep folder', { timeout: 20_000 }, async () => {
  const fixture = await startFixture();
  const password = 'test-password-123';
  async function api(route, body, token) {
    const response = await fetch(fixture.origin + '/api' + route, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return response.json();
  }
  try {
    await api('/setup/admin', { username: 'owner', displayName: 'Owner', password });
    const { token } = await api('/auth/login', { username: 'owner', password });
    const zip = new AdmZip();
    zip.addFile('Takeout/Google Notizen/Einkaufsliste.json', Buffer.from(JSON.stringify({ title: 'Einkaufsliste',
      textContent: 'Milch und Brot', isTrashed: false, userEditedTimestampUsec: 1700000000000000 })));
    zip.addFile('Takeout/Google Notizen/Einkaufsliste.html', Buffer.from('<html></html>'));
    zip.addFile('Takeout/Chrome/BrowserHistory.json', Buffer.from('{"Browser History":[]}'));
    const form = new FormData();
    form.append('takeout', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'takeout.zip');
    const imported = await fetch(fixture.origin + '/api/import/google-takeout', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).imported, 1);
    const note = (await api('/notes', null, token)).find(value => value.noteTitle === 'Einkaufsliste');
    assert.ok(note.noteBody.includes('Milch und Brot'));
  } finally { await fixture.close(); }
});
