const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
const tokens = require('../shared/note-appearance.json');
const { sanitizeNoteContent, sanitizeNoteHtml } = require('../server/note-html');
const bundle = buildSync({ entryPoints: ['src/app/utils/note-appearance.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const moduleObject = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module: moduleObject, exports: moduleObject.exports });
const { noteAppearance, notePatternImage, validNotePattern } = moduleObject.exports;
const luminance = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);

test('all supplied colour families retain readable automatic highlights and precise tint tokens', () => {
  assert.equal(tokens.noteColours.length, 54);
  for (const colour of tokens.noteColours) {
    for (const light of [true, false]) {
      const actual = noteAppearance(colour.hex, light);
      assert.equal(actual.highlight, colour.highlight, colour.name);
      assert.equal(actual.patternInk, colour.patternInk, colour.name);
      assert.equal(actual.pickerInk, colour.pickerInk, colour.name);
      assert.equal(actual.text, colour.text, colour.name);
      const a = luminance(actual.highlight), b = luminance(actual.text);
      assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, colour.name);
    }
  }
  assert.equal(noteAppearance('', true).highlight, '#ffe066');
  assert.equal(noteAppearance('', false).highlight, '#896300');
  assert.equal(noteAppearance('#fff8b8').highlight, '#ffb8d2', 'saved legacy shades keep their family');
  assert.equal(noteAppearance('rgb(255, 248, 184)').highlight, '#ffb8d2');
});

test('every supplied pattern renders safely across all colours and both default themes', () => {
  assert.equal(tokens.patterns.length, 27);
  assert.equal(tokens.rules.tileSize, 100);
  for (const pattern of tokens.patterns) {
    for (const svg of [pattern.motif, pattern.tile]) assert.doesNotMatch(svg, /<script|<foreignObject|\bon\w+=|\bhref=|<metadata|c2pa/i);
    assert.match(pattern.tile, /width="100" height="100" viewBox="0 0 100 100"/);
    assert.match(pattern.tile, /translate\(25 25\) rotate\(-14\) translate\(-12 -12\)/);
    assert.match(pattern.tile, /translate\(75 75\) rotate\(12\) translate\(-12 -12\)/);
    assert.doesNotMatch(pattern.tile, /scale\(|<g fill="currentColor">/);
    const motif = pattern.motif.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    assert.equal(pattern.tile.split(motif).length - 1, 2, `${pattern.id}: both motifs stay unchanged`);
    for (const colour of [...tokens.noteColours.map(c => c.hex), '']) for (const theme of [true, false]) {
      const appearance = noteAppearance(colour, theme);
      for (const motif of [false, true]) {
        const url = notePatternImage(pattern.id, colour, theme, motif);
        assert.ok(url.startsWith("url('data:image/svg+xml,"));
        const svg = decodeURIComponent(url.slice("url('data:image/svg+xml,".length, -2));
        assert.ok(svg.includes(motif ? appearance.pickerInk : appearance.patternInk));
        assert.doesNotMatch(svg, /currentColor/);
      }
    }
  }
  assert.equal(notePatternImage('not-a-pattern'), '');
  assert.equal(validNotePattern('javascript:alert(1)'), null);
});

test('semantic highlights survive sanitization; pattern IDs stay bounded and illustrations exclude them', () => {
  const html = '<p><b>Keep <mark class="hl" onclick="alert(1)">this highlight</mark></b></p>';
  assert.equal(sanitizeNoteHtml(html), '<p><b>Keep <mark class="hl">this highlight</mark></b></p>');
  const note = sanitizeNoteContent({ noteBody: html, checkBoxes: [{ id: 1, data: html }], pattern: 'travel', bgImage: '' });
  assert.equal(note.pattern, 'travel');
  assert.match(note.checkBoxes[0].data, /<mark class="hl">/);
  assert.equal(sanitizeNoteContent({ pattern: 'not-a-pattern' }).pattern, null);
  assert.equal(sanitizeNoteContent({ pattern: 'travel', bgImage: 'url(/assets/images/backgrounds/budget.svg)' }).pattern, null);
  assert.equal(sanitizeNoteContent({ pattern: 'travel', bgImage: 'none' }).pattern, 'travel');
});

test('shared pattern edits reach the owner, cards and sync; old notes need no database migration', async () => {
  const { startFixture } = require('../test-support/session-fixture.cjs');
  const fixture = await startFixture();
  try {
    const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
    const request = async (path, body, token, method = body ? 'POST' : 'GET') => {
      const response = await fetch(fixture.origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      assert.ok(response.ok, `${path}: ${response.status}`); return response.status === 204 ? null : response.json();
    };
    await request('/setup/admin', credentials);
    const { token } = await request('/auth/login', credentials);
    const person = { username: 'friend', displayName: 'Friend', password: 'test-password-456' };
    const user = await request('/users', person, token);
    const friend = await request('/auth/login', person);
    const note = await request('/notes', { noteTitle: 'Pattern test', noteBody: '<p><mark class="hl">A semantic highlight</mark></p>', bgColor: '#1a4a4a', bgImage: '', pattern: 'travel', labels: [], checkBoxes: [], images: [], isCbox: false }, token);
    assert.equal(note.pattern, 'travel');
    await request(`/notes/${note.id}/collaborators`, { userIds: [user.id] }, token, 'PUT');
    await request(`/notes/${note.id}`, { pattern: 'music', bgImage: '' }, friend.token, 'PATCH');
    assert.equal((await request(`/notes/${note.id}`, undefined, token)).pattern, 'music');
    assert.equal((await request('/notes?view=card', undefined, token)).notes.find(item => item.id === note.id).pattern, 'music');
    assert.equal((await request('/sync/bootstrap?protocolVersion=2', undefined, token)).notes.find(item => item.id === note.id).pattern, 'music');
    await request(`/notes/${note.id}`, { bgColor: '#fedcbb' }, friend.token, 'PATCH');
    const recoloured = await request(`/notes/${note.id}`, undefined, token);
    assert.equal(recoloured.pattern, 'music'); assert.match(recoloured.noteBody, /<mark class="hl">/);
    await request(`/notes/${note.id}`, { pattern: 'music', bgImage: 'url(/assets/images/backgrounds/budget.svg)' }, token, 'PATCH');
    assert.equal((await request(`/notes/${note.id}`, undefined, token)).pattern, null);
    await request(`/notes/${note.id}`, { pattern: 'invalid-id', bgImage: '' }, token, 'PATCH');
    assert.equal((await request(`/notes/${note.id}`, undefined, token)).pattern, null);
  } finally { await fixture.close(); }
});
