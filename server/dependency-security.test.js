const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const AdmZip = require('adm-zip');
const WebSocket = require('ws');
const { startFixture } = require('../test-support/session-fixture.cjs');

test('compressed JSON, multipart uploads and Takeout imports remain usable after malformed requests', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const credentials = { username: 'security-owner', password: 'security-regression-password' };
  const compressed = body => fetch(fixture.origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body
  });
  const json = Buffer.from(JSON.stringify(credentials));
  assert.equal((await compressed(zlib.gzipSync(json))).status, 401);
  const malformed = await compressed(Buffer.concat([zlib.gzipSync(json), Buffer.from('trailing invalid gzip bytes')]));
  await malformed.text();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await fetch(fixture.origin + '/api/setup/status')).status, 200, 'a malformed compressed body must not crash the server');

  assert.equal((await fetch(fixture.origin + '/api/setup/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).status, 201);
  const login = await compressed(zlib.gzipSync(json));
  assert.equal(login.status, 200, 'normal compressed requests still work');
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  for (const field of ['nested[child]', 'items[4294967294]', 'toString[toString]']) {
    const form = new FormData();
    form.append(field, 'untrusted');
    form.append('image', new Blob(['image'], { type: 'image/png' }), 'image.png');
    const rejected = await fetch(fixture.origin + '/api/uploads/images', { method: 'POST', headers, body: form });
    assert.equal(rejected.status, 400, await rejected.clone().text());
  }
  const image = new FormData();
  image.append('image', new Blob(['png'], { type: 'image/png' }), 'photo.png');
  assert.equal((await fetch(fixture.origin + '/api/uploads/images', { method: 'POST', headers, body: image })).status, 201);

  async function importZip(bytes) {
    const form = new FormData();
    form.append('takeout', new Blob([bytes], { type: 'application/zip' }), 'takeout.zip');
    return fetch(fixture.origin + '/api/import/google-takeout', { method: 'POST', headers, body: form });
  }
  const zip = new AdmZip();
  zip.addFile('Takeout/Keep/note.json', Buffer.from(JSON.stringify({ title: 'Imported checklist', isPinned: true,
    createdTimestampUsec: 1700000000000000, labels: [{ name: 'Imported' }],
    listContent: [{ text: 'First', isChecked: false }, { text: 'Second', isChecked: true }],
    attachments: [{ filePath: 'photo.png', mimetype: 'image/png' }] })));
  zip.addFile('Takeout/Keep/photo.png', Buffer.from('png'));
  const imported = await importZip(zip.toBuffer());
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal((await imported.json()).imported, 1);
  const notes = await (await fetch(fixture.origin + '/api/notes', { headers })).json();
  const note = notes.find(note => note.noteTitle === 'Imported checklist');
  assert.equal(note.checkBoxes.length, 2);
  assert.equal(note.images.length, 1);
  assert.equal(note.labels[0].name, 'Imported');
  assert.equal((await importZip(zip.toBuffer())).status, 200, 'repeat imports still use deduplication');

  const forged = new AdmZip();
  forged.addFile('Takeout/Keep/a-good.json', Buffer.from(JSON.stringify({ title: 'Must roll back', textContent: 'Temporary',
    attachments: [{ filePath: 'new.png', mimetype: 'image/png' }] })));
  forged.addFile('Takeout/Keep/new.png', Buffer.from('temporary image'));
  forged.addFile('Takeout/Keep/z-bomb.json', Buffer.from('{}'));
  const bytes = forged.toBuffer();
  let central = 0;
  while ((central = bytes.indexOf(Buffer.from('PK\x01\x02', 'binary'), central)) !== -1) {
    const nameLength = bytes.readUInt16LE(central + 28);
    if (bytes.subarray(central + 46, central + 46 + nameLength).toString().endsWith('z-bomb.json')) {
      bytes.writeUInt32LE(300 * 1024 * 1024, central + 24);
      break;
    }
    central += 4;
  }
  const mediaBefore = await fs.readdir(path.join(fixture.directory, 'uploads'));
  const rejected = await importZip(bytes);
  assert.equal(rejected.status, 400, await rejected.clone().text());
  assert.match((await rejected.json()).error, /too large/);
  const after = await (await fetch(fixture.origin + '/api/notes', { headers })).json();
  assert.equal(after.some(note => note.noteTitle === 'Must roll back'), false);
  assert.deepEqual(await fs.readdir(path.join(fixture.directory, 'uploads')), mediaBefore, 'rolled-back imports remove their temporary images');
  assert.equal((await fetch(fixture.origin + '/api/setup/status')).status, 200);
});

test('realtime works normally and excessive tiny fragments close the connection', { timeout: 15_000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const credentials = { username: 'realtime-owner', password: 'realtime-regression-password' };
  await fetch(fixture.origin + '/api/setup/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  const { token } = await (await fetch(fixture.origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).json();
  const socket = new WebSocket(fixture.origin.replace('http:', 'ws:') + '/api/realtime');
  t.after(() => socket.terminate());
  socket.on('error', () => {});
  const ready = new Promise(resolve => socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'auth-required') {
      const json = JSON.stringify({ type: 'authenticate', token });
      socket.send(json.slice(0, 10), { fin: false });
      socket.send(json.slice(10), { fin: true });
    }
    if (message.type === 'ready') resolve();
  }));
  await ready;
  const closed = once(socket, 'close');
  for (let i = 0; i < 16_385; i++) socket.send(Buffer.from('x'), { fin: false });
  await closed;
  assert.equal((await fetch(fixture.origin + '/api/setup/status')).status, 200);
});
