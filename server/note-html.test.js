const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { sanitizeNoteHtml, safeUrl } = require('./note-html');
const { startFixture } = require('../test-support/session-fixture.cjs');
const cases = require('../test-support/note-html-cases.json');

test('note HTML removes executable content while preserving supported rich content', () => {
  assert.equal(sanitizeNoteHtml(0), '0');
  const rich = '<h1>Heading</h1><p><b>Bold</b> <i>italic</i> <u>underline</u><s>strike</s></p><ul><li>List</li></ul><blockquote>Quote</blockquote><pre><code>code</code></pre><span style="color: red; font-weight: bold; text-decoration: underline">Styled</span><a href="https://example.test">Link</a><img src="/api/uploads/images/pixel.png" alt="Pixel" width="100"><table><tr><td>Cell</td></tr></table>';
  const clean = sanitizeNoteHtml(rich);
  for (const tag of ['h1', 'b', 'i', 'u', 's', 'ul', 'li', 'blockquote', 'pre', 'code', 'span', 'a', 'img', 'table', 'td']) assert.ok(clean.includes('<' + tag), tag);
  assert.match(clean, /color:red/);
  assert.match(clean, /font-weight:bold/);
  assert.match(clean, /rel="noopener noreferrer"/);
  for (const payload of cases) {
    const value = sanitizeNoteHtml(payload);
    assert.doesNotMatch(value, /\bon(?:error|load|animationstart)\s*=|javascript:|<\/?(?:script|svg|math|iframe|object|form|input|button)\b|data-original-html|background-image|position:/i);
  }
  assert.equal(safeUrl('data:text/html,<script>alert(1)</script>', true), '');
  assert.equal(safeUrl('java\nscript:alert(1)'), '');
  assert.equal(safeUrl('kept://note/1'), 'kept://note/1');
});

test('REST, sync, legacy data, shared notes and Takeout use the safe content policy', async () => {
  const fixture = await startFixture();
  const password = 'test-password-123';
  let token;
  async function api(route, body, method = body ? 'POST' : 'GET', status = 200, credential = token) {
    const response = await fetch(fixture.origin + '/api' + route, { method,
      headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const data = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  const payload = '<img src=x onerror="window.__noteXss=1"><b>Keep formatting</b>';
  const assertClean = note => {
    assert.doesNotMatch(note.noteTitle + note.noteBody + JSON.stringify(note.checkBoxes), /onerror=/i);
    assert.ok(note.noteBody.includes('<b>Keep formatting</b>'));
  };
  try {
    await api('/setup/admin', { username: 'owner', displayName: 'Owner', password }, 'POST', 201);
    token = (await api('/auth/login', { username: 'owner', password })).token;
    const editor = await api('/users', { username: 'editor', displayName: 'Editor', password, role: 'user' }, 'POST', 201);
    const editorToken = (await api('/auth/login', { username: 'editor', password })).token;
    const fields = { noteTitle: payload, noteBody: payload, checkBoxes: [{ id: 1, data: payload, done: false, indentLevel: 2 }], images: [], labels: [], clientMetadata: { schema: 7 } };
    const note = await api('/notes', fields, 'POST', 201);
    assertClean(note);
    assert.deepEqual(note.clientMetadata, { schema: 7 });
    assert.equal(note.checkBoxes[0].indentLevel, 2);
    await api(`/notes/${note.id}`, fields, 'PUT', 204);
    assertClean(await api(`/notes/${note.id}`));
    await api(`/notes/${note.id}`, fields, 'PATCH', 204);
    assertClean(await api(`/notes/${note.id}`));
    await api(`/notes/${note.id}/collaborators`, { userIds: [editor.id] }, 'PUT');
    assertClean(await api(`/notes/${note.id}`, undefined, 'GET', 200, editorToken));

    const sync = await api('/sync/mutations', { mutations: [{ type: 'note.upsert', syncId: 'xss-sync', payload: fields }] });
    assert.equal(sync.results[0].ok, true);
    assertClean(sync.results[0].payload);
    // Existing records and historical change logs must be safe on read, too.
    await fixture.sql('UPDATE notes SET noteTitle = ?, noteBody = ?, checkBoxes = ? WHERE id = ?', [payload, payload, JSON.stringify(fields.checkBoxes), note.id]);
    await fixture.sql("UPDATE sync_changes SET payload = ? WHERE resourceType = 'note' AND operation = 'upsert'", [JSON.stringify({ ...note, ...fields })]);
    assertClean(await api(`/notes/${note.id}`));
    for (const route of ['/notes', '/sync/bootstrap']) {
      const data = await api(route);
      const notes = Array.isArray(data) ? data : data.notes;
      assertClean(notes.find(value => value.id === note.id));
    }
    const cards = await api('/notes?view=card&limit=10');
    assertClean(cards.notes.find(value => value.id === note.id));
    const search = await api('/notes?view=card&limit=10&q=Keep%20formatting');
    assert.doesNotMatch(search.notes.find(value => value.id === note.id).searchText, /<[^>]*onerror=/i);
    const changes = await api('/sync/changes?since=0');
    for (const change of changes.changes.filter(change => change.resourceType === 'note' && change.operation === 'upsert')) assertClean(change.payload);

    // A dedicated external bearer token may call REST directly, bypassing the
    // MCP tool adapter, so REST must enforce the policy itself.
    const external = await api('/users/me/mcp-access/enable', {}, 'POST', 201);
    assertClean(await api('/notes', fields, 'POST', 201, external.accessToken));

    const zip = new AdmZip();
    zip.addFile('Takeout/Keep/import.json', Buffer.from(JSON.stringify({ title: 'Imported title', textContent: 'Original text',
      annotations: [{ url: 'javascript:window.__noteXss=1', title: payload }, { url: 'https://example.test/" onmouseover="window.__noteXss=1', title: 'Safe text' }] })));
    const form = new FormData();
    form.append('takeout', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'takeout.zip');
    const imported = await fetch(fixture.origin + '/api/import/google-takeout', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).imported, 1);
    const importedNote = (await api('/notes')).find(value => value.noteTitle === 'Imported title');
    assert.ok(importedNote.noteBody.includes('Original text'));
    assert.doesNotMatch(importedNote.noteBody, /href="javascript:|<img[^>]*onerror=| onmouseover="/i);
    // The imported annotation title is literal text, not executable markup.
    assert.ok(importedNote.noteBody.includes('&lt;img'));
  } finally { await fixture.close(); }
});
