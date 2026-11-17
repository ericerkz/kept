const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { imagePreview } = require('./image-preview');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('preview sizing preserves aspect, orientation, transparency and originals; cache keys follow file changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kept-preview-'));
  try {
    const file = path.join(directory, 'photo.png');
    const original = await sharp({ create: { width: 800, height: 1600, channels: 4, background: '#f4a9b880' } }).png().toBuffer();
    await writeFile(file, original);
    const [first, same] = await Promise.all([imagePreview(file, 320), imagePreview(file, 320)]);
    assert.strictEqual(first, same);
    const metadata = await sharp(first).metadata();
    assert.equal(metadata.width, 160); assert.equal(metadata.height, 320);
    assert.equal(metadata.hasAlpha, true);
    assert.deepEqual(await readFile(file), original);
    assert.equal(await imagePreview(file, 999999), null);
    await writeFile(file, await sharp({ create: { width: 100, height: 50, channels: 3, background: 'red' } }).png().toBuffer());
    assert.notDeepEqual(await imagePreview(file, 320), first);
    const orientation = path.join(directory, 'orientation.jpg');
    await sharp({ create: { width: 600, height: 300, channels: 3, background: 'blue' } }).withMetadata({ orientation: 6 }).jpeg().toFile(orientation);
    const rotated = await sharp(await imagePreview(orientation, 320)).metadata();
    assert.equal(rotated.width, 160); assert.equal(rotated.height, 320);
    const invalid = path.join(directory, 'broken.png'); await writeFile(invalid, 'invalid');
    assert.equal(await imagePreview(invalid, 320), null);
    const vector = path.join(directory, 'vector.svg');
    await writeFile(vector, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>');
    assert.equal(await imagePreview(vector, 320), null, 'document/vector loaders stay disabled');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('image previews keep original upload authorization, cache policy and untouched full-size downloads', async () => {
  const fixture = await startFixture();
  try {
    const post = (route, body, token) => fetch(fixture.origin + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const credentials = { username: 'owner', password: 'test-preview-password' };
    await post('/api/setup/admin', credentials);
    const owner = await (await post('/api/auth/login', credentials)).json();
    await post('/api/users', { username: 'other', password: 'test-other-password' }, owner.token);
    const other = await (await post('/api/auth/login', { username: 'other', password: 'test-other-password' })).json();
    const original = await sharp({ create: { width: 1200, height: 1800, channels: 3, background: 'orange' } }).png().toBuffer();
    const form = new FormData(); form.append('image', new Blob([original], { type: 'image/png' }), 'photo.png');
    const upload = await (await fetch(fixture.origin + '/api/uploads/images', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form })).json();
    const url = fixture.origin + upload.url;
    assert.equal((await fetch(url + '?preview=320')).status, 401);
    assert.equal((await fetch(url + '?preview=320', { headers: { Authorization: `Bearer ${other.token}` } })).status, 404);
    const response = await fetch(url + '?preview=320', { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-type'), /image\/webp/);
    assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).height, 320);
    assert.equal((await fetch(url + '?preview=320', { headers: { Authorization: `Bearer ${other.token}` } })).status, 404, 'a warmed preview cache must not grant access');
    const full = await fetch(url, { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), original);
  } finally { await fixture.close(); }
});
