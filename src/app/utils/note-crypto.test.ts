// node --test src/app/utils/note-crypto.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createNoteKeys, encryptedFileRefs, openFile, openNoteContent, parseNoteEnvelope, referencedImageFiles,
  sealFile, sealNoteContent, unlockNoteKeys
} from './note-crypto.ts';

// Fewer iterations keep the suite fast; the envelope records the count used.
const iterations = 100_000;
const content = {
  noteBody: '<p>Bank PIN 4242 <img src="kept://file/attachment-photo"></p>',
  checkBoxes: [{ id: 1, data: 'renew passport', done: false }],
  images: [{ id: 'drawing', dataUrl: 'data:image/png;base64,AAAA', name: 'Drawing', placement: 'top' }],
  files: {
    'attachment-photo': { name: 'photo.jpg', type: 'image/jpeg', size: 4, kind: 'image' as const },
    'attachment-tax': { name: 'tax return.pdf', type: 'application/pdf', size: 9, kind: 'attachment' as const },
    'attachment-old': { name: 'replaced.png', type: 'image/png', size: 3, kind: 'image' as const }
  }
};

test('content is sealed with the note key and opened with the passcode', async () => {
  const keys = await createNoteKeys('correct horse', iterations);
  const sealed = await sealNoteContent(keys, content);
  assert.doesNotMatch(sealed, /4242|passport|tax return|photo\.jpg/, 'no plaintext in the envelope');
  const envelope = parseNoteEnvelope(sealed)!;
  assert.equal(envelope.kdf.iterations, iterations);
  assert.equal(envelope.iv.length, 16);
  assert.deepEqual(envelope.files.sort(), ['attachment-photo', 'attachment-tax']);
  const unlocked = await unlockNoteKeys('correct horse', sealed);
  const opened = await openNoteContent(unlocked, sealed);
  assert.equal(opened.noteBody, content.noteBody);
  assert.deepEqual(opened.checkBoxes, content.checkBoxes);
  assert.deepEqual(opened.images, content.images);
  assert.deepEqual(Object.keys(opened.files!).sort(), ['attachment-photo', 'attachment-tax'], 'unused file details are dropped');
});

test('a wrong passcode or a tampered envelope fails to open', async () => {
  const keys = await createNoteKeys('right', iterations);
  const sealed = await sealNoteContent(keys, content);
  await assert.rejects(unlockNoteKeys('wrong', sealed));
  const envelope = JSON.parse(sealed);
  const flipped = envelope.ct[0] === 'A' ? 'B' : 'A';
  await assert.rejects(openNoteContent(keys, JSON.stringify({ ...envelope, ct: flipped + envelope.ct.slice(1) })));
});

test('a rotated key has a new epoch, and the old key cannot read what it seals', async () => {
  const old = await createNoteKeys('old passcode', iterations);
  const before = await sealNoteContent(old, content);
  assert.equal(parseNoteEnvelope(before)!.epoch, 1);
  const rotated = await createNoteKeys('new passcode', iterations, old.epoch + 1);
  const after = await sealNoteContent(rotated, { ...content, noteBody: '<p>written after the change</p>' });
  assert.equal(parseNoteEnvelope(after)!.epoch, 2);
  await assert.rejects(unlockNoteKeys('old passcode', after));
  // Someone who kept the old envelope and passcode still gets only the old key.
  const leaked = await unlockNoteKeys('old passcode', before);
  await assert.rejects(openNoteContent(leaked, after));
  const file = await sealFile(rotated.dataKey, new Blob(['%PDF tax return'], { type: 'application/pdf' }));
  await assert.rejects(openFile(leaked.dataKey, file));
  const unlocked = await unlockNoteKeys('new passcode', after);
  assert.equal(unlocked.epoch, 2);
  assert.equal((await openNoteContent(unlocked, after)).noteBody, '<p>written after the change</p>');
});

test('files are sealed with a fresh IV, keep their type when opened, and reject tampering', async () => {
  const { dataKey } = await createNoteKeys('pass', iterations);
  const plain = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  const [a, b] = await Promise.all([sealFile(dataKey, plain), sealFile(dataKey, plain)]);
  assert.equal(a.type, 'application/octet-stream');
  assert.notDeepEqual(new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer()));
  const opened = await openFile(dataKey, a, 'image/jpeg');
  assert.equal(opened.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  const bytes = new Uint8Array(await a.arrayBuffer());
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(openFile(dataKey, new Blob([bytes])));
  await assert.rejects(openFile(dataKey, new Blob(['not encrypted at all, just text'])));
  const other = await createNoteKeys('pass', iterations);
  await assert.rejects(openFile(other.dataKey, a));
});

test('file references come from the body, the images list and attachments', () => {
  assert.deepEqual(encryptedFileRefs(content).sort(), ['attachment-photo', 'attachment-tax']);
  assert.deepEqual(encryptedFileRefs({ noteBody: '', checkBoxes: [], images: [{ dataUrl: 'kept://file/attachment-top' }] }), ['attachment-top']);
});

test('only stored image names are listed as unencrypted images', () => {
  const body = '<img src="/api/uploads/images/1700000000000-0123456789abcdef01234567.png">'
    + '<img src="/api/uploads/images/../../etc/passwd"><img src="https://elsewhere.example/cat.png">';
  assert.deepEqual(referencedImageFiles(body), ['1700000000000-0123456789abcdef01234567.png']);
});

test('rejects envelopes that are not ours', () => {
  for (const value of ['', 'nope', '{}', JSON.stringify({ v: 2, alg: 'AES-GCM' }), JSON.stringify({ v: 1, alg: 'AES-CBC' })]) {
    assert.equal(parseNoteEnvelope(value), null, value);
  }
});
