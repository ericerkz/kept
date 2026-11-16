const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('date searches paginate on creation dates, retain literal text, honor local days and enforce access', async () => {
  const fixture = await startFixture();
  let token;
  async function api(path, body, auth = token, expected = 200) {
    const response = await fetch(fixture.origin + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  }
  const cards = (query, extra = {}) => api('/notes?' + new URLSearchParams({ view: 'card', limit: '2', q: query, ...extra }));
  try {
    const credentials = { username: 'date-owner', password: 'isolated-date-search-password' };
    await api('/setup/admin', credentials, undefined, 201);
    token = (await api('/auth/login', credentials)).token;
    const owned = [];
    for (const [title, date] of [
      ['Budget alpha', '2025-06-01T12:00:00Z'],
      ['Budget beta', '2025-11-16T12:00:00Z'],
      ['Budget gamma', '2025-12-31T23:59:59Z'],
      ['Budget 2025', '2026-01-01T12:00:00Z'],
      ['Created on 2025', '2026-01-02T12:00:00Z'],
      ['Local midnight', '2025-11-17T01:00:00Z'],
    ]) {
      const note = await api('/notes', { noteTitle: title, noteBody: '', labels: [], images: [], checkBoxes: [] }, token, 201);
      await fixture.sql('UPDATE notes SET createdAt = ? WHERE id = ?', [date, note.id]);
      owned.push(note);
    }
    const first = await cards('budget !date 2025');
    assert.equal(first.notes.length, 2);
    assert.ok(first.nextCursor);
    const second = await cards('budget !date 2025', { cursor: first.nextCursor });
    assert.equal(second.notes.length, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.notes, ...second.notes].map(note => note.id).sort(), owned.slice(0, 3).map(note => note.id).sort());

    assert.deepEqual((await cards('budget !date November 2025')).notes.map(note => note.id), [owned[1].id]);
    assert.deepEqual((await cards('budget !date 2025-11-16')).notes.map(note => note.id), [owned[1].id]);
    assert.deepEqual((await cards('created on 2025')).notes.map(note => note.id), [owned[4].id]);
    assert.deepEqual((await cards('budget 2025')).notes.map(note => note.id), [owned[3].id]);
    assert.deepEqual((await cards('!date 2025-02-30')).notes, []);
    assert.deepEqual((await api('/notes/search?' + new URLSearchParams({ q: 'budget !date 2025' }))).map(note => note.id).sort(), owned.slice(0, 3).map(note => note.id).sort());

    // A client in America/New_York includes the next UTC day's early hours.
    const local = await cards('!date 2025-11-16', {
      dateStart: '2025-11-16T05:00:00Z', dateEnd: '2025-11-17T05:00:00Z'
    });
    assert.deepEqual(local.notes.map(note => note.id).sort(), [owned[1].id, owned[5].id].sort());
    await api('/notes?' + new URLSearchParams({ view: 'card', q: '!date today', dateStart: 'invalid', dateEnd: 'invalid' }), undefined, token, 400);

    const credentials2 = { username: 'date-outsider', password: credentials.password };
    await api('/users', credentials2, token, 201);
    const outsider = (await api('/auth/login', credentials2)).token;
    const privateNote = await api('/notes', { noteTitle: 'Budget secret', noteBody: '', labels: [], images: [], checkBoxes: [] }, outsider, 201);
    await fixture.sql('UPDATE notes SET createdAt = ? WHERE id = ?', ['2025-06-01T12:00:00Z', privateNote.id]);
    const ownerResults = await cards('budget !date 2025', { limit: '200' });
    assert.equal(ownerResults.notes.some(note => note.id === privateNote.id), false);
    assert.equal(ownerResults.notes.length, 3);
  } finally {
    await fixture.close();
  }
});
