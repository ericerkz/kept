const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
const { sanitizeNoteHtml } = require('./note-html');
const { startFixture } = require('../test-support/session-fixture.cjs');
function load(entry, globals = {}) {
  const bundle = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, addEventListener() {}, ...globals });
  return module.exports;
}
const code = load('src/app/utils/code-blocks.ts');

test('code metadata is bounded and stored snippets preserve literal markup and whitespace', () => {
  const text = '  if (a < b) {\n\tconst tag = "<script>alert(1)</script>";\n\n}\n';
  const html = code.codeBlockHtml(text, 'javascript', 'user');
  assert.equal(sanitizeNoteHtml(html), html);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(sanitizeNoteHtml('<pre class="kept-code" data-code-language="javascript:alert(1)" data-code-source="anything" onclick="alert(1)"><code>x</code></pre>'), /data-code-|onclick/);
  assert.doesNotMatch(sanitizeNoteHtml('<p data-code-language="javascript">text</p>'), /data-code/);
});

test('automatic paste detection is bounded and ignores ordinary prose and lists', () => {
  for (const value of ['Remember to buy milk', 'Shopping list\nMilk\nBread', '- milk\n- bread', 'https://example.test\nhttps://example.org', 'const value = 1;', 'x'.repeat(30001), 'const x = 1;\n'.repeat(1000)]) {
    assert.equal(code.pastedCodeCandidate(value), null);
  }
  assert.ok(code.pastedCodeCandidate(Array(1000).fill('const x = 1;').join('\n')), '1,000 lines remain eligible');
  const text = "$wh = 'Hello' | Write-Host\n$wo = 'World' | Write-Output\n\nGet-Variable wh\n";
  assert.equal(code.pastedCodeCandidate(text).text, text);
  assert.equal(code.pastedCodeCandidate(text).explicit, false);
  const fenced = code.pastedCodeCandidate('```ps1\n' + text + '```');
  assert.equal(fenced.language, 'powershell'); assert.equal(fenced.text, text.slice(0, -1)); assert.equal(fenced.explicit, true);
  assert.equal(code.pastedCodeCandidate('~~~unknown\nliteral <img src=x>\n~~~').language, 'plaintext');
  assert.equal(code.pastedCodeCandidate('```js\nconst x = 1;\n```').language, 'javascript');
});

test('Tab/outdent preserve selected lines and literal source text', () => {
  const value = 'first\nsecond\nthird';
  const indented = code.indentCode(value, 0, value.length);
  assert.equal(indented.text, '  first\n  second\n  third');
  const restored = code.indentCode(indented.text, indented.start, indented.end, true);
  assert.equal(restored.text, value);
  assert.equal(code.indentCode('  line', 4, 4, true).text, 'line');
  assert.equal(code.indentCode('\tline', 3, 3, true).text, 'line');
  assert.equal(code.indentCode('before after', 6, 6).text, 'before   after');
});

test('every syntax token meets 4.5:1 across the full palette, both defaults and custom colours', () => {
  const { codeSurface, codeContrast } = load('src/app/utils/code-surface.ts');
  const appearance = require('../shared/note-appearance.json');
  for (const color of [...appearance.noteColours.map(item => item.hex), '', '#777777', '#ff0000', '#0000ff', '#00ff00']) {
    for (const theme of [true, false]) {
      const surface = codeSurface(color, theme);
      for (const [token, ink] of Object.entries(surface.tokens)) assert.ok(codeContrast(ink, surface.background) >= 4.5, `${color}/${theme}/${token}`);
    }
  }
});

test('worker guesses conservatively, honours manual selection, escapes code and bounds grammar input', () => {
  const { highlightCode } = load('src/app/utils/code-highlight.worker.ts');
  assert.equal(highlightCode('shopping list', 'auto', 'shopping list').language, 'plaintext');
  const csharp = `// Outer loop
for (int i = 1; i <= 2; ++i)
{
  Console.WriteLine("Outer: " + i);  // Executes 2 times

  // Inner loop
  for (int j = 1; j <= 3; j++)
  {
    Console.WriteLine(" Inner: " + j); // Executes 6 times (2 * 3)
  }
}`;
  assert.equal(code.pastedCodeCandidate(csharp).definite, true, 'obvious C-family syntax does not depend on worker availability');
  assert.equal(highlightCode(csharp, 'auto', csharp).isCode, true);
  assert.equal(highlightCode(csharp, 'auto', csharp).language, 'csharp');
  const loop = 'for (int i = 0; i < 5; i++) {\n  print(i);\n}';
  assert.equal(highlightCode(loop, 'auto', loop).isCode, true, 'short C-family code can be recognised despite language ambiguity');
  for (const prose of ['return home by Friday\nfrom the station walk east', 'public transport\nprivate appointments']) {
    assert.equal(highlightCode(prose, 'auto', prose).isCode, false);
  }
  const powershell = "$wh = 'Hello, World!' | Write-Host\n$wo = 'Hello, World!' | Write-Output\n\nGet-Variable wh\n\nGet-Variable wo\n";
  assert.equal(highlightCode(powershell, 'auto', powershell).language, 'powershell');
  assert.equal(highlightCode(powershell, 'python', powershell).language, 'python', 'manual language overrides auto-detection');
  const result = highlightCode('const html = "<img src=x onerror=alert(1)>";', 'javascript', '');
  assert.equal(result.language, 'javascript'); assert.match(result.html, /hljs-keyword/); assert.doesNotMatch(result.html, /<img/);
  assert.equal(highlightCode('x'.repeat(30001), 'javascript', '').html, null);
  assert.notEqual(highlightCode(Array(1000).fill('// x').join('\n'), 'javascript', '').html, null);
  assert.equal(highlightCode('\n'.repeat(1000), 'javascript', '').html, null);
  assert.equal(highlightCode('x', 'untrusted-language', '').html, null);
});

test('REST, cards, shared notes, sync and search retain the original snippet and language', async () => {
  const fixture = await startFixture();
  let token;
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST', expected = 200, useToken = token) => {
    const response = await fetch(fixture.origin + '/api' + route, { method, headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, expected, await response.clone().text()); return response.status === 204 ? undefined : response.json();
  };
  try {
    await api('/setup/admin', { username: 'owner', password: 'test-password-123' }, 'POST', 201);
    token = (await api('/auth/login', { username: 'owner', password: 'test-password-123' })).token;
    const friend = await api('/users', { username: 'friend', password: 'test-password-123' }, 'POST', 201);
    const friendToken = (await api('/auth/login', { username: 'friend', password: 'test-password-123' })).token;
    const text = '  <script>never execute</script>\n\tneedleForSearch\n' + Array.from({ length: 650 }, (_, i) => `const line${i} = "https://example.test/${i}";`).join('\n') + '\n';
    const body = '<p>Before</p>' + code.codeBlockHtml(text, 'javascript', 'user') + '<div class="kept-checklist-anchor kept-list-tasks"></div><p>After</p>';
    const fields = { noteTitle: 'Code block fixture', noteBody: body, checkBoxes: [{ id: 1, listId: 'tasks', data: 'Keep this task', done: true }], isCbox: true, bgColor: '#fdcfe8' };
    const note = await api('/notes', fields, 'POST', 201);
    assert.equal(note.noteBody, body);
    await api(`/notes/${note.id}/collaborators`, { userIds: [friend.id] }, 'PUT');
    assert.equal((await api(`/notes/${note.id}`, undefined, 'GET', 200, friendToken)).noteBody, body);
    const cards = (await api('/notes?view=card&limit=10')).notes;
    assert.equal(cards.find(item => item.id === note.id).noteBody, body, 'no 12KB card truncation before Copy');
    assert.equal(cards.find(item => item.id === note.id).linkCount, 0, 'URLs inside code must not become link previews');
    assert.ok((await api('/notes?view=card&q=needleForSearch')).notes.some(item => item.id === note.id));
    const sync = await api('/sync/bootstrap?protocolVersion=2');
    assert.equal(sync.notes.find(item => item.id === note.id).noteBody, body);
    const changed = { ...fields, noteBody: body.replace('needleForSearch', 'updatedNeedle') };
    await api(`/notes/${note.id}`, changed, 'PUT', 204, friendToken);
    assert.equal((await api(`/notes/${note.id}`)).noteBody, changed.noteBody);
  } finally { await fixture.close(); }
});
