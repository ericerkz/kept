// node --test src/app/utils/note-crypto.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_STORED_LINK_PREVIEWS, canonicalLinkUrl, createNoteKeys, encryptedFileRefs, noteLinkUrls, openFile, openNoteContent, parseNoteEnvelope,
  referencedImageFiles, sealFile, sealNoteContent, unlockNoteKeys
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

test('link previews from before locking are sealed with the content, only for links the note still has', async () => {
  const thumb = 'data:image/webp;base64,UklGRg==';
  const body = '<p><a href="https://example.com/plan?a=1&amp;b=2">plan</a> and https://kept.example</p>';
  const linkPreviews = {
    [canonicalLinkUrl('https://example.com/plan?a=1&b=2')]: { url: 'https://example.com/plan?a=1&b=2', title: 'Secret plan', domain: 'example.com', description: 'Q3', image: thumb },
    [canonicalLinkUrl('https://kept.example')]: { url: 'https://kept.example/', title: 'Kept', domain: 'kept.example', description: null, image: 'https://tracker.example/og.png' },
    'https://removed.example/': { url: 'https://removed.example/', title: 'Removed', domain: 'removed.example', description: null, image: null },
    'javascript:alert(1)': { url: 'javascript:alert(1)', title: 'x', domain: 'x', description: null, image: null }
  };
  const keys = await createNoteKeys('correct horse', iterations);
  const sealed = await sealNoteContent(keys, { noteBody: body, checkBoxes: [], linkPreviews });
  assert.doesNotMatch(sealed, /Secret plan|kept\.example|UklGRg/, 'previews are encrypted with the note');
  const opened = await openNoteContent(keys, sealed);
  assert.deepEqual(Object.keys(opened.linkPreviews!).sort(), ['https://example.com/plan?a=1&b=2', 'https://kept.example/']);
  assert.equal(opened.linkPreviews!['https://example.com/plan?a=1&b=2'].image, thumb);
  assert.equal(opened.linkPreviews!['https://kept.example/'].image, null, 'a remote image address is never kept');

  const plain = await openNoteContent(keys, await sealNoteContent(keys, { noteBody: '<p>no links</p>', checkBoxes: [], linkPreviews }));
  assert.equal(plain.linkPreviews, undefined, 'removing the links drops their previews');
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`https://site${index}.example/`,
    { url: `https://site${index}.example/`, title: String(index), domain: 'site.example', description: null, image: null }]));
  const capped = await openNoteContent(keys, await sealNoteContent(keys,
    { noteBody: Object.keys(many).join(' '), checkBoxes: [], linkPreviews: many }));
  assert.equal(Object.keys(capped.linkPreviews!).length, MAX_STORED_LINK_PREVIEWS);
});

test('link addresses: hrefs are kept whole, links typed in the text end before punctuation', async () => {
  const html = '<p><a href="https://en.wikipedia.org/wiki/Kept_(app)">wiki</a> <a href=\'https://example.com/q?a=1&amp;b=2\'>q</a>'
    + ' (see https://typed.example/a) and https://typed.example/Kept_(app). Also https://x.example/end.'
    + ' <a href="mailto:me@example.com">mail</a> <a href="https://odd.example/&#99999999;">odd</a></p>';
  assert.deepEqual(noteLinkUrls(html), [
    'https://en.wikipedia.org/wiki/Kept_(app)', 'https://example.com/q?a=1&b=2', 'https://odd.example/&#99999999;',
    'https://typed.example/a', 'https://typed.example/Kept_(app)', 'https://x.example/end'
  ]);
  // A preview kept under a complete address survives sealing.
  const key = canonicalLinkUrl('https://en.wikipedia.org/wiki/Kept_(app)');
  const keys = await createNoteKeys('correct horse', iterations);
  const opened = await openNoteContent(keys, await sealNoteContent(keys, { noteBody: html, checkBoxes: [],
    linkPreviews: { [key]: { url: key, title: 'Kept', domain: 'en.wikipedia.org', description: null, image: null } } }));
  assert.deepEqual(Object.keys(opened.linkPreviews!), [key]);
});

test('rejects envelopes that are not ours', () => {
  for (const value of ['', 'nope', '{}', JSON.stringify({ v: 2, alg: 'AES-GCM' }), JSON.stringify({ v: 1, alg: 'AES-CBC' })]) {
    assert.equal(parseNoteEnvelope(value), null, value);
  }
});
