const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { plainText, imageSources, validateEmail, stripTrailingSlashes } = require('./text-utils');

test('plain-text extraction preserves text and entities while excluding active content', () => {
  assert.equal(plainText('<p>Hello <b>world</b></p> &nbsp; &amp; &#39; &quot;'), 'Hello world & \' "');
  assert.equal(plainText('Before<script>alert(1)</script >After<style>body{color:red}</style>End'), 'Before After End');
  assert.equal(plainText('&lt;literal&gt; &amp;lt;still encoded&amp;gt;'), '<literal> &lt;still encoded&gt;');
  assert.equal(plainText('<script>unfinished'), '');
  assert.equal(plainText('a < b'), 'a < b');
});

test('image extraction parses attributes and does not mistake text or data-src for src', () => {
  assert.deepEqual(imageSources('<IMG src = "/api/uploads/images/a.png?x=1&amp;y=2"><img data-src="ignored"><script>"<img src=bad>"</script><img src=unquoted>'),
    ['/api/uploads/images/a.png?x=1&y=2', 'unquoted']);
});

test('email validation stays compatible for normal addresses and bounds malformed input', () => {
  for (const email of [undefined, '', 'person@example.com', 'first.last+kept@sub.example.internal', ' person@example.com ']) assert.equal(validateEmail(email), true, email);
  for (const email of ['person', 'person@localhost', 'person@@example.com', 'person@.com', 'person@example.', 'person @example.com', 'x'.repeat(255) + '@example.com']) assert.equal(validateEmail(email), false, email);
});

test('trailing URL slashes are removed without changing embedded slashes', () => {
  assert.equal(stripTrailingSlashes('https://example.com/path///'), 'https://example.com/path');
  assert.equal(stripTrailingSlashes('https://example.com/a//b'), 'https://example.com/a//b');
  assert.equal(stripTrailingSlashes('////'), '');
});

test('large adversarial strings finish in an isolated process', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const {plainText,imageSources,validateEmail,stripTrailingSlashes}=require('./server/text-utils');
    const assert=require('node:assert/strict');
    assert.equal(validateEmail('a@'+'.'.repeat(100000)+'@'),false);
    assert.equal(plainText('<style>'.repeat(50000)),'');
    assert.deepEqual(imageSources('<img'.repeat(50000)),[]);
    const slashes='a'+'/'.repeat(100000)+'x';
    assert.equal(stripTrailingSlashes(slashes),slashes);
  `], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8', timeout: 3000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
